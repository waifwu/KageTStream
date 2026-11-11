// Headless smoke test: runs the real interpreter over data/script.txt with a
// stub display, making random choices, and reports script warnings.
//
//   node tools/dryrun.mjs [runs=30] [stepsPerRun=400000] [seed=1]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, Signal, commandNames } from '../js/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(here, '..', 'data', 'script.txt'), 'utf8');
const runs = +process.argv[2] || 30;
const maxSteps = +process.argv[3] || 400000;
let seed = +process.argv[4] || 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- static pass: every command word that appears at a statement start
{
  const known = new Set(commandNames());
  const unknown = new Map();
  const lines = script.split('\n');
  lines.forEach((raw, i) => {
    let l = raw.replace(/^[ \t]+/, '');
    for (;;) {
      const m = /^([A-Za-z_][A-Za-z_0-9]*)/.exec(l);
      if (!m) break;
      const name = m[1].toLowerCase();
      if (!known.has(name)) { if (!unknown.has(name)) unknown.set(name, []); unknown.get(name).push(i + 1); break; }
      if (name !== 'if' && name !== 'notif') break;
      // skip the condition: the command is the last identifier-led chunk not followed by an operator
      const rest = l.slice(m[0].length);
      const mm = /(?:^|[\s"`\d])((?:goto|gosub|mov|skip|jumpf|jumpb|return|lsp|csp|bg|inc|dec|add|sub|btn|playstop|play|end|loadgame|windoweffect|select|selgosub|wave|wavestop|vsp|msp|print|btndef|reset|savegame|systemcall|ld|cl|monocro|setwindow|br|quakex|quakey)\b.*)$/.exec(rest);
      if (!mm) { if (!unknown.has('?if-tail')) unknown.set('?if-tail', []); unknown.get('?if-tail').push(i + 1); break; }
      l = mm[1];
    }
  });
  console.log('static: unknown statement heads:');
  for (const [k, v] of unknown) console.log('  ', k, 'x' + v.length, 'lines', v.slice(0, 8).join(','));
}

// ---- runtime pass
const store = new Map();
const storage = {
  loadGlobals: () => (store.has('g') ? JSON.parse(store.get('g')) : null),
  saveGlobals: (g) => { store.set('g', JSON.stringify(g)); return true; },
  saveSlot: (n, d) => { store.set('s' + n, JSON.stringify(d)); return true; },
  loadSlot: (n) => (store.has('s' + n) ? JSON.parse(store.get('s' + n)) : null),
  slotInfo: () => null,
};
const warnings = new Map();
const stats = { text: 0, selects: 0, buttons: 0, ends: 0, loads: 0 };
const cmdCount = new Map();

function makeHost() {
  const noop = () => {};
  const gfx = new Proxy({ dirty: false }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'serialize') return () => ({});
      if (k === 'loadSprite') return async (tag) => ({ tag, data: { cells: 1, delays: [0], loop: 0, w: 1, h: 1 } });
      if (k === 'loadPlain') return async () => ({});
      if (k === 'grabScreen') return () => ({});
      if (['transition', 'quake', 'setBgImage', 'setTachi', 'setSprite', 'restore'].includes(k)) return async () => {};
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const text = {
    glyphs: [], x: 0, line: 0, color: '#ffffff', history: [], lineW: 600, lineH: 24,
    win: { rows: 21 },
    advance: (ch) => (ch.charCodeAt(0) < 0x100 ? 10 : 20),
    put(ch) { const a = this.advance(ch); if (this.x > 0 && this.x + a > this.lineW) this.newline(); this.glyphs.push(ch); this.x += a; stats.text++; },
    putWords(s) { for (const c of s) this.put(c); },
    space() { if (this.x + 10 > this.lineW) { this.newline(); return true; } this.put(' '); return false; },
    word(s) { const w = [...s].reduce((a, c) => a + this.advance(c), 0); if (this.x > 0 && this.x + w > this.lineW && w <= this.lineW) this.newline(); },
    endLine() { if (this.x > 0) this.newline(); },
    newline() { this.x = 0; this.line++; },
    locate(x, y) { this.x = x * 20; this.line = y; },
    pageFull() { return this.line >= 19; },
    clear() { this.glyphs = []; this.x = 0; this.line = 0; },
    async setWindow(w) { this.win = w; this.lineW = w.cols * (w.fw + w.px); this.clear(); },
    serialize() { return { x: this.x, line: this.line, n: this.glyphs.length }; },
    pack: (x) => x,
    async restore() { this.clear(); },
    reset() { this.clear(); },
    rectsOf: () => [], recolor: noop, redraw: noop,
  };
  const audio = new Proxy({}, { get: () => noop });
  const input = { ctrl: true, flush: noop, takeClick: () => false, next: async () => ({ type: 'click' }) };
  const ui = {
    engine: null,
    clickWait: async () => {},
    select: async (texts) => { stats.selects++; return Math.floor(rnd() * texts.length); },
    buttonWait: async (buttons) => {
      stats.buttons++;
      if (!buttons.length || rnd() < 0.08) return rnd() < 0.5 ? -1 : 0;
      return buttons[Math.floor(rnd() * buttons.length)].no;
    },
    systemCall: async () => {},
  };
  return {
    gfx, text, audio, input, ui, storage,
    sleep: async () => {}, yield: async () => {}, frame: async () => {},
    random: rnd,
    onWarn: (msg, line) => { const k = msg + ' (line ' + line + ')'; warnings.set(k, (warnings.get(k) || 0) + 1); },
  };
}

const visited = new Set();
for (let r = 0; r < runs; r++) {
  const host = makeHost();
  const e = new Engine(script, host);
  host.ui.engine = e;
  let steps = 0;
  const origStep = e.step.bind(e);
  e.step = function () {
    if (++steps > maxSteps) throw new Signal('end');
    visited.add(e.lineOf(e.pc));
    return origStep();
  };
  const origApply = e.applySnapshot.bind(e);
  e.applySnapshot = async (s) => { stats.loads++; return origApply(s); };
  try {
    await e.run();
    stats.ends++;
  } catch (err) {
    console.log('RUN', r, 'CRASHED at line', e.lineOf(e.stmtStart) + 1, ':', err.stack || err);
    break;
  }
}

const total = script.split('\n').filter((l) => l.trim() && !/^\s*[;*]/.test(l)).length;
console.log('runtime:', JSON.stringify(stats), 'lines visited', visited.size, 'of ~' + total + ' executable');
console.log('warnings (' + warnings.size + '):');
[...warnings].sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([k, v]) => console.log('  x' + v, k));
