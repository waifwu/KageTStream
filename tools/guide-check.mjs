// Plays the whole walkthrough through the real script, headlessly, and reports
// every day on which a step of the guide did not match a choice the game offered.
//
//   node tools/guide-check.mjs [normal|true] [ja] [-v]
//
// With "ja" it plays the Japanese script (data/script-ja.txt), reading each choice through its
// English counterpart as the player does.
//
// It starts from an empty save, as the walkthrough assumes, presses the menus
// the way a reader would (Start game, the story, then "a day" / "op" / "ep" as
// the guide says) and at every choice takes the option the guide marks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, Signal } from '../js/engine.js';
import { Guide, choiceTranslator } from '../js/guide.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = path.join(here, '..', 'data');
const english = fs.readFileSync(path.join(data, 'script.txt'), 'utf8');
const japanese = process.argv.includes('ja');
const script = japanese ? fs.readFileSync(path.join(data, 'script-ja.txt'), 'utf8') : english;
const told = japanese ? choiceTranslator(script, english) : null;
const ending = process.argv.includes('true') ? 'true' : 'normal';
const verbose = process.argv.includes('-v');

const guide = new Guide(fs.readFileSync(path.join(data, 'guide.txt'), 'utf8'), { on: true, day: 1, ending });
const total = guide.days.length;

const store = new Map();
const storage = {
  loadGlobals: () => (store.has('g') ? JSON.parse(store.get('g')) : null),
  saveGlobals: (g) => { store.set('g', JSON.stringify(g)); return true; },
  saveSlot: (n, d) => { store.set('s' + n, JSON.stringify(d)); return true; },
  loadSlot: (n) => (store.has('s' + n) ? JSON.parse(store.get('s' + n)) : null),
};
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
  glyphs: [], x: 0, line: 0, color: '#ffffff', history: [], lineW: 600, lineH: 24, win: { rows: 21 },
  advance: (ch) => (ch.charCodeAt(0) < 0x100 ? 10 : 20),
  put(ch) { const a = this.advance(ch); if (this.x > 0 && this.x + a > this.lineW) this.newline(); this.glyphs.push(ch); this.x += a; },
  putWords(s) { for (const c of s) this.put(c); },
  space() { if (this.x + 10 > this.lineW) { this.newline(); return true; } this.put(' '); return false; },
  word() {}, endLine() { if (this.x > 0) this.newline(); },
  newline() { this.x = 0; this.line++; },
  locate(x, y) { this.x = x * 20; this.line = y; },
  pageFull() { return this.line >= 19; },
  clear() { this.glyphs = []; this.x = 0; this.line = 0; },
  async setWindow(w) { this.win = w; this.lineW = w.cols * (w.fw + w.px); this.clear(); },
  serialize() { return {}; }, pack: (x) => x, async restore() { this.clear(); }, reset() { this.clear(); },
  rectsOf: () => [], recolor: noop, redraw: noop,
};

const report = [];            // one line per day
let dayLog = null;
let problem = null;
const quizLog = [];
let selectsToday = 0;
let preludes = 0;
let engine = null;

const ui = {
  clickWait: async () => {},
  systemCall: async () => {},
  async select(shown, labels) {
    const texts = told ? told(shown, labels) : shown;
    const want = guide.suggest(texts);
    let pick = want;
    const short = (x) => x.replace(/`/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
    if (guide.active && guide.today && (Array.isArray(guide.today.quiz) || guide.today.n >= 45)) {
      quizLog.push((want < 0 ? 'no mark' : 'marked ' + (want + 1)) + ' of ' + texts.length + ': ' + texts.map(short).join(' / '));
    }
    if (++selectsToday > 400) { problem = 'day ' + guide.today.n + ': the same choices keep coming back'; throw new Signal('end'); }
    if (want < 0) {
      pick = 0;
      const t = guide.today;
      // a choice the guide did not recognise while it still had steps to give: worth a look
      if (guide.active && !guide.lost && t && guide.step < t.steps.length && t.quiz !== 'miss' && !(Array.isArray(t.quiz))) {
        dayLog.unmatched.push('step ' + (guide.step + 1) + ' of ' + t.steps.length + ' not found among ' + texts.length + ' options');
      }
    }
    const r = guide.chose(texts, pick);
    if (r === 'kept') dayLog.kept++;
    return pick;
  },
  async buttonWait(buttons, img, name) {
    const f = (name || '').replace(/\\/g, '/').toLowerCase();
    const has = (no) => buttons.some((b) => b.no === no);
    if (/title\/kagetsu_title02/.test(f)) {
      if (guide.finished) throw new Signal('end');
      return 1;
    }
    if (/gamestart\/game_selct02/.test(f)) return 1;
    if (/gamestart\/twilight\/twilight0[24]/.test(f)) {
      const offered = [[1, 'op'], [2, 'a day'], [3, 'ep']].filter(([no]) => has(no)).map(([, e]) => e);
      const entry = guide.entryAmong(offered);
      if (!entry) { problem = 'day ' + guide.today.n + ': "' + guide.today.entry + '" is not offered on the story page'; throw new Signal('end'); }
      if (entry !== guide.today.entry) preludes++;
      if (preludes > 3) { problem = 'day ' + guide.today.n + ': "' + guide.today.entry + '" never appears'; throw new Signal('end'); }
      return entry === 'op' ? 1 : entry === 'ep' ? 3 : 2;
    }
    return buttons.length ? buttons[0].no : -1;
  },
};
const host = {
  gfx, text, ui, storage,
  audio: new Proxy({}, { get: () => noop }),
  input: { ctrl: true, flush: noop, takeClick: () => false, next: async () => ({ type: 'click' }) },
  sleep: async () => {}, yield: async () => {}, frame: async () => {},
  random: Math.random,
  onWarn: noop,
};

engine = new Engine(script, host);
const mark = engine.markLabel.bind(engine);
const begin = (entry) => {
  dayLog = { n: guide.today ? guide.today.n : 0, entry, kept: 0, unmatched: [], path: [] };
  selectsToday = 0;
  guide.beginDay(entry);
};
const finish = () => {
  if (!guide.active) return;
  const t = guide.today;
  if (guide.lost && dayLog.entry !== t.entry) { guide.endDay(); return; }
  const steps = t.steps.length, at = guide.step, lost = guide.lost;
  const done = guide.endDay();
  report.push({ n: t.n, entry: t.entry, steps, kept: at, done, lost, unmatched: dayLog.unmatched, path: dayLog.path, notes: t.notes.length });
};
engine.markLabel = (name) => {
  mark(name);
  if (name === 'f500') begin('a day');
  else if (name === 'twilight_op') begin('op');
  else if (name === 'twilight_ep') begin('ep');
  else if (name === 'endofplay' || name === 'title_loop' || name === 'title' || name === 'twilight') finish();
  else if (guide.active && /^f\d+$/.test(name)) dayLog.path.push(name);
};
let steps = 0;
const step = engine.step.bind(engine);
engine.step = function () {
  if (++steps > 60e6) { problem = 'gave up after ' + steps + ' script steps on day ' + (guide.today ? guide.today.n : '?'); throw new Signal('end'); }
  return step();
};

await engine.run();

let bad = 0;
for (const d of report) {
  const ok = d.done && d.kept === d.steps && !d.unmatched.length;
  if (!ok) bad++;
  if (!ok || verbose) {
    console.log((ok ? 'ok   ' : 'FAIL ') + 'day ' + String(d.n).padStart(2) + ' (' + d.entry + '): ' + d.kept + ' of ' + d.steps + ' choices taken'
      + (d.lost ? ', guide left' : '') + (d.done ? '' : ', day not counted') + (d.unmatched.length ? ' -- ' + d.unmatched.join('; ') : '')
      + (verbose ? '  [' + d.path.length + ' blocks]' : ''));
  }
}
console.log('ending: ' + ending + ' | days played: ' + report.length + ' of ' + total + ' | days that did not follow the guide: ' + bad
  + ' | script steps: ' + steps + (problem ? ' | stopped: ' + problem : ''));
if (process.argv.includes('--choices')) { const seen = new Set(); for (const q of quizLog) { if (seen.has(q)) continue; seen.add(q); console.log('  ' + q.slice(0, 200)); if (seen.size > 60) break; } }
if (process.argv.includes('--paths')) fs.writeFileSync(path.join(here, 'guide-paths.json'), JSON.stringify(report.map((d) => ({ n: d.n, path: d.path }))));
