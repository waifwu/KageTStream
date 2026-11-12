// NScripter-compatible script interpreter.
//
// The engine executes the game's original script text directly (the same text
// ONScripter reads out of nscript.dat). Everything that touches the browser is
// reached through `host` (gfx, text, audio, ui, storage, loader) so the parser
// and command set can also be exercised headlessly under Node.

export class Signal extends Error {
  constructor(kind, data) {
    super('signal:' + kind);
    this.kind = kind;
    this.data = data;
  }
}

const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isDigit = (c) => c >= '0' && c <= '9';
const isIdent = (c) => c !== undefined && (isAlpha(c) || isDigit(c));
const normFile = (f) => f.replace(/\\/g, '/').toLowerCase();

const GLOBAL_BORDER = 200;
const NSC_VERSION = 296;

export class Engine {
  constructor(scriptText, host) {
    this.host = host;
    let src = scriptText.replace(/\r\n?/g, '\n');
    if (!src.endsWith('\n')) src += '\n';
    this.scriptLen = src.length;      // identifies the script a save belongs to
    // where a scene replayed from the flowchart returns to
    src += '*nsweb_replay_end\ncsp -1\nplaystop\nwavestop\nreset\n';
    this.src = src;
    this.len = src.length;

    // line table + labels
    this.lineStarts = [0];
    for (let i = src.indexOf('\n'); i >= 0 && i + 1 < src.length; i = src.indexOf('\n', i + 1)) {
      this.lineStarts.push(i + 1);
    }
    this.labels = new Map();
    for (let li = 0; li < this.lineStarts.length; li++) {
      let p = this.lineStarts[li];
      while (src[p] === ' ' || src[p] === '\t') p++;
      if (src[p] === '*') {
        let q = p + 1;
        while (isIdent(src[q])) q++;
        const name = src.slice(p + 1, q).toLowerCase();
        if (name && !this.labels.has(name)) this.labels.set(name, { off: this.lineStarts[li], line: li });
      }
    }

    // persistent (global) state
    this.nums = Object.create(null);
    this.strs = Object.create(null);
    this.arrays = Object.create(null);
    this.fileLog = new Set();
    this.labelLog = new Set();
    this.musicLog = new Set();      // music the story has played (for the music player)
    this.numOverride = null;        // see getNum
    this.globalsDirty = false;
    this.lastGlobalFlush = 0;

    // definitions
    this.numalias = new Map();
    this.stralias = new Map();
    this.effects = new Map();
    this.rmenu = [];
    this.saveNumber = 9;
    this.saveName = ['Save', 'Load', 'Slot'];
    this.selectColor = ['#ffffff', '#808080'];
    this.menuSelectColor = ['#ffffff', '#808080', '#808080'];
    this.menuWindow = { fw: 18, fh: 18, px: 2, py: 2, bold: 1, shadow: 1, color: '#cccccc' };
    this.lookbackColor = '#ffff00';
    this.lookbackButtons = null;
    this.effectBlank = 10;
    this.cdFadeout = 0;
    this.mp3Fadeout = 0;
    this.versionStr = ['', ''];
    this.caption = '';
    this.globalOn = false;

    // user settings (owned by the host, mirrored here)
    this.textSpeedNo = 1;
    this.autoPace = 1;
    this.skipMode = false;
    this.autoMode = false;
    this.currentFlow = null;

    this.warned = new Set();
    this.ended = false;
    this.pc = 0;
    this.stmtStart = 0;
    this.resetLocal();
    this.loadGlobals();
  }

  // ------------------------------------------------------------------ state
  setSkip(on) {
    if (this.skipMode === on) return;
    this.skipMode = on;
    if (this.host.onState) this.host.onState();
  }

  resetLocal() {
    for (const k in this.nums) if (+k < GLOBAL_BORDER) delete this.nums[k];
    for (const k in this.strs) if (+k < GLOBAL_BORDER) delete this.strs[k];
    for (const k in this.arrays) this.arrays[k].data.fill(0);
    this.callStack = [];
    this.buttons = [];
    this.btnImage = null;
    this.textMode = false;
    this.eraseTextWindow = 1;
    this.windowEffect = { type: 1, dur: 0 };
    this.saveon = true;
    this.snapshot = null;
    this.lastTilde = 0;
    this.timerStart = Date.now();
    this.waitTime = -1;
    this.cursors = [null, null];
    this.bgm = null;
    this.waveLoop = null;
    this.skipMode = false;
    this.replaying = false;
  }

  loadGlobals() {
    const g = this.host.storage.loadGlobals();
    if (!g) return;
    for (const k in g.nums) this.nums[k] = g.nums[k];
    for (const k in g.strs) this.strs[k] = g.strs[k];
    for (const f of g.fileLog || []) this.fileLog.add(f);
    for (const l of g.labelLog || []) this.labelLog.add(l);
    for (const m of g.musicLog || []) this.musicLog.add(m);
  }

  flushGlobals(force) {
    if (!this.globalsDirty) return;
    const now = Date.now();
    if (!force && now - this.lastGlobalFlush < 2000) return;
    this.lastGlobalFlush = now;
    this.globalsDirty = false;
    const nums = {}, strs = {};
    for (const k in this.nums) if (+k >= GLOBAL_BORDER && this.nums[k]) nums[k] = this.nums[k];
    for (const k in this.strs) if (+k >= GLOBAL_BORDER && this.strs[k]) strs[k] = this.strs[k];
    this.host.storage.saveGlobals({ nums, strs, fileLog: [...this.fileLog], labelLog: [...this.labelLog], musicLog: [...this.musicLog] });
  }

  warn(msg) {
    const line = this.lineOf(this.stmtStart) + 1;
    const key = msg + '@' + line;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (this.host.onWarn) this.host.onWarn(msg, line);
    else console.warn('[script line ' + line + '] ' + msg);
  }

  lineOf(off) {
    const a = this.lineStarts;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // ------------------------------------------------------------------ variables
  // `numOverride(i, value)`, when the host sets it, may answer for a variable as the script reads
  // it. What is stored (and saved) stays as it is.
  getNum(i) {
    const v = this.nums[i] | 0;
    return this.numOverride ? this.numOverride(i, v) : v;
  }
  setNum(i, v) {
    v |= 0;
    if (this.nums[i] === v) return;
    this.nums[i] = v;
    if (i >= GLOBAL_BORDER) this.globalsDirty = true;
  }
  getStr(i) { return this.strs[i] || ''; }
  setStr(i, v) {
    if ((this.strs[i] || '') === v) return;
    this.strs[i] = v;
    if (i >= GLOBAL_BORDER) this.globalsDirty = true;
  }
  arrIndex(ref) {
    const a = this.arrays[ref.id];
    if (!a) { this.warn('array ?' + ref.id + ' is not declared'); return null; }
    let idx = 0;
    for (let d = 0; d < a.dims.length; d++) {
      const i = ref.idx[d] | 0;
      if (i < 0 || i >= a.dims[d]) { this.warn('array index out of range'); return null; }
      idx = idx * a.dims[d] + i;
    }
    return [a, idx];
  }
  getRef(ref) {
    if (ref.t === 'n') return this.getNum(ref.i);
    if (ref.t === 's') return this.getStr(ref.i);
    const r = this.arrIndex(ref);
    return r ? r[0].data[r[1]] : 0;
  }
  setRef(ref, v) {
    if (ref.t === 'n') this.setNum(ref.i, v);
    else if (ref.t === 's') this.setStr(ref.i, String(v));
    else {
      const r = this.arrIndex(ref);
      if (r) r[0].data[r[1]] = v | 0;
    }
  }

  // ------------------------------------------------------------------ reader
  ws() {
    const s = this.src;
    let p = this.pc;
    while (s[p] === ' ' || s[p] === '\t') p++;
    this.pc = p;
  }
  wsnl() {
    const s = this.src;
    let p = this.pc;
    for (;;) {
      const c = s[p];
      if (c === ' ' || c === '\t' || c === '\n') p++;
      else if (c === ';' ) { while (p < this.len && s[p] !== '\n') p++; }
      else break;
    }
    this.pc = p;
  }
  tryComma() {
    this.ws();
    if (this.src[this.pc] === ',') {
      this.pc++;
      // a trailing comma continues the statement on the next line
      const save = this.pc;
      this.ws();
      if (this.src[this.pc] === '\n' || this.src[this.pc] === ';') this.wsnl(); else this.pc = save;
      return true;
    }
    return false;
  }
  comma() {
    if (!this.tryComma()) this.warn('expected ","');
  }
  readIdent() {
    const s = this.src;
    let p = this.pc;
    while (isIdent(s[p])) p++;
    const r = s.slice(this.pc, p);
    this.pc = p;
    return r;
  }
  skipLine() {
    const e = this.src.indexOf('\n', this.pc);
    this.pc = e < 0 ? this.len : e;
  }
  atEnd() {
    this.ws();
    const c = this.src[this.pc];
    return c === '\n' || c === ':' || c === ';' || c === undefined;
  }

  readInt() { this.ws(); return this.expr(); }
  expr() {
    let v = this.term();
    for (;;) {
      this.ws();
      const c = this.src[this.pc];
      if (c === '+') { this.pc++; v = (v + this.term()) | 0; }
      else if (c === '-') { this.pc++; v = (v - this.term()) | 0; }
      else break;
    }
    return v;
  }
  term() {
    let v = this.factor();
    for (;;) {
      this.ws();
      const s = this.src, c = s[this.pc];
      if (c === '*') { this.pc++; v = Math.imul(v, this.factor()); }
      else if (c === '/') { this.pc++; const d = this.factor(); v = d ? Math.trunc(v / d) : 0; }
      else if (c === 'm' && s.startsWith('mod', this.pc) && !isIdent(s[this.pc + 3])) {
        this.pc += 3; const d = this.factor(); v = d ? v % d : 0;
      } else break;
    }
    return v;
  }
  factor() {
    this.ws();
    const s = this.src, c = s[this.pc];
    if (c === '-') { this.pc++; return -this.factor() | 0; }
    if (c === '+') { this.pc++; return this.factor(); }
    if (c === '(') {
      this.pc++;
      const v = this.expr();
      this.ws();
      if (s[this.pc] === ')') this.pc++;
      return v;
    }
    if (isDigit(c)) return this.number();
    if (c === '%') { this.pc++; return this.getNum(this.varIndex()); }
    if (c === '?') { this.pc++; return this.getRef(this.arrayRef()); }
    if (isAlpha(c)) {
      const id = this.readIdent().toLowerCase();
      if (this.numalias.has(id)) return this.numalias.get(id);
      this.warn('undefined numalias "' + id + '"');
      return 0;
    }
    this.warn('number expected');
    return 0;
  }
  number() {
    const s = this.src;
    let p = this.pc, v = 0;
    while (isDigit(s[p])) { v = v * 10 + (s.charCodeAt(p) - 48); p++; }
    this.pc = p;
    return v | 0;
  }
  varIndex() {
    const s = this.src, c = s[this.pc];
    if (isDigit(c)) return this.number();
    if (isAlpha(c)) {
      const id = this.readIdent().toLowerCase();
      if (this.numalias.has(id)) return this.numalias.get(id);
      this.warn('undefined numalias "' + id + '"');
      return 0;
    }
    if (c === '%') { this.pc++; return this.getNum(this.varIndex()); }
    if (c === '?') { this.pc++; return this.getRef(this.arrayRef()); }
    if (c === '(') {
      this.pc++;
      const v = this.expr();
      this.ws();
      if (s[this.pc] === ')') this.pc++;
      return v;
    }
    this.warn('variable number expected');
    return 0;
  }
  arrayRef() {
    const id = this.varIndex();
    const idx = [];
    while (this.src[this.pc] === '[') {
      this.pc++;
      idx.push(this.expr());
      this.ws();
      if (this.src[this.pc] === ']') this.pc++;
    }
    return { t: 'a', id, idx };
  }
  readVarRef() {
    this.ws();
    const c = this.src[this.pc];
    if (c === '%') { this.pc++; return { t: 'n', i: this.varIndex() }; }
    if (c === '$') { this.pc++; return { t: 's', i: this.varIndex() }; }
    if (c === '?') { this.pc++; return this.arrayRef(); }
    this.warn('variable expected');
    return { t: 'n', i: 0 };
  }

  readStr() {
    this.ws();
    let out = this.strTerm();
    for (;;) {
      this.ws();
      if (this.src[this.pc] !== '+') break;
      const save = this.pc;
      this.pc++;
      this.ws();
      const c = this.src[this.pc];
      if (c === '"' || c === '$' || c === '`') out += this.strTerm();
      else { this.pc = save; break; }
    }
    return out;
  }
  strTerm() {
    const s = this.src, c = s[this.pc];
    if (c === '"' || c === '`') {
      let eol = s.indexOf('\n', this.pc);
      if (eol < 0) eol = this.len;
      let e = s.indexOf(c, this.pc + 1);
      if (e < 0 || e > eol) e = eol;
      const r = s.slice(this.pc + 1, e);
      this.pc = s[e] === c ? e + 1 : e;
      return r;
    }
    if (c === '$') { this.pc++; return this.getStr(this.varIndex()); }
    if (c === '#') { const r = s.slice(this.pc, this.pc + 7); this.pc += 7; return r; }
    if (c === '*') { this.pc++; return '*' + this.readIdent(); }
    if (isAlpha(c)) {
      const id = this.readIdent();
      const a = this.stralias.get(id.toLowerCase());
      return a !== undefined ? a : id;
    }
    this.warn('string expected');
    return '';
  }
  readLabel() {
    this.ws();
    const c = this.src[this.pc];
    if (c === '*') { this.pc++; return this.readIdent().toLowerCase(); }
    if (c === '$') { this.pc++; return this.getStr(this.varIndex()).replace(/^\*/, '').toLowerCase(); }
    this.warn('label expected');
    return '';
  }
  readEffect() {
    const no = this.readInt();
    if (this.tryComma()) {
      const dur = this.readInt();
      let mask = null;
      if (this.tryComma()) mask = this.readStr();
      return { type: no, dur, mask };
    }
    if (no === 0) return { type: 0, dur: 0 };
    if (no === 1) return { type: 1, dur: 0 };
    const e = this.effects.get(no);
    if (!e) { this.warn('effect ' + no + ' is not defined'); return { type: 1, dur: 0 }; }
    return e;
  }

  // ------------------------------------------------------------------ flow
  // Runs a subroutine of the script to its "return", at once. Only for ones that do not wait
  // (the game's "set the effect speeds" lists of mov, for instance); the place the story is at is kept.
  callSub(label) {
    const l = this.labels.get(label);
    if (!l) return false;
    const pc = this.pc, stmt = this.stmtStart, depth = this.callStack.length;
    this.callStack.push(pc);
    this.pc = l.off;
    for (let guard = 0; this.callStack.length > depth && guard < 5000; guard++) {
      const r = this.step();
      if (r && typeof r.then === 'function') { this.warn('callSub: *' + label + ' waits'); break; }
    }
    this.callStack.length = depth;
    this.pc = pc;
    this.stmtStart = stmt;
    return true;
  }

  // Runs the script from a label up to (not into) its first "gosub", at once, and comes back.
  // The game's galleries fill in a page's pictures and flags this way before showing it.
  evalUntilGosub(label) {
    const l = this.labels.get(label);
    if (!l) return false;
    const pc = this.pc, stmt = this.stmtStart, depth = this.callStack.length;
    this.pc = l.off;
    for (let guard = 0; guard < 4000; guard++) {
      this.ws();
      if (this.src.startsWith('gosub', this.pc) || this.pc >= this.len) break;
      const r = this.step();
      if (r && typeof r.then === 'function') { this.warn('evalUntilGosub: *' + label + ' waits'); break; }
    }
    this.callStack.length = depth;
    this.pc = pc;
    this.stmtStart = stmt;
    return true;
  }

  jumpTo(label) {
    const l = this.labels.get(label);
    if (!l) { this.warn('label *' + label + ' not found'); return false; }
    this.pc = l.off;
    return true;
  }
  markLabel(name) {
    if (this.host.onLabel) this.host.onLabel(name);
    if (name.charCodeAt(0) === 102 && /^f\d+$/.test(name)) this.currentFlow = name;   // "f<N>": a block of the day's flow
    if (!this.labelLog.has(name)) { this.labelLog.add(name); this.globalsDirty = true; }
  }
  logFile(file) {
    const f = normFile(file);
    if (!this.fileLog.has(f)) { this.fileLog.add(f); this.globalsDirty = true; }
  }

  skipping() {
    return this.skipMode || this.host.input.ctrl;
  }

  async run() {
    for (;;) {
      try {
        await this.mainLoop();
        break;
      } catch (e) {
        if (!(e instanceof Signal)) throw e;
        if (e.kind === 'reset') {
          this.flushGlobals(true);
          await this.doReset();
        } else if (e.kind === 'load') {
          await this.applySnapshot(e.data);
        } else if (e.kind === 'replay') {
          // one scene on its own: set the window up as the story does, play the scene, then back to the title
          this.flushGlobals(true);
          await this.doReset();
          const chain = ['nsweb_replay_end', e.data, 'disp_cursor', 'restore_weffect'].filter((l) => this.labels.has(l));
          this.callStack = chain.map((l) => this.labels.get(l).off);
          if (!this.jumpTo('set_window_mm')) this.pc = this.callStack.pop();
          this.replaying = true;
        } else if (e.kind === 'end') {
          break;
        }
      }
    }
    this.flushGlobals(true);
    this.ended = true;
    if (this.host.onEnd) this.host.onEnd();
  }

  async mainLoop() {
    let n = 0;
    while (this.pc < this.len) {
      const r = this.step();
      if (r !== undefined && r !== null && typeof r.then === 'function') { await r; n = 0; }
      else if (++n >= 3000) { n = 0; await this.host.yield(); }
    }
  }

  step() {
    const s = this.src;
    this.ws();
    const c = s[this.pc];
    if (c === '\n' || c === ':') { this.pc++; return; }
    if (c === ';') { this.skipLine(); return; }
    if (c === '*') {
      this.pc++;
      const name = this.readIdent().toLowerCase();
      if (name) this.markLabel(name);
      this.skipLine();
      return;
    }
    if (c === '~') { this.pc++; this.lastTilde = this.pc; return; }
    if (c === ',') {
      // stray arguments after a command: ignore the rest of the statement
      this.stmtStart = this.pc;
      this.warn('unexpected ","');
      this.skipStatement();
      return;
    }
    this.stmtStart = this.pc;
    if (isAlpha(c)) {
      const start = this.pc;
      const name = this.readIdent().toLowerCase();
      const fn = COMMANDS[name];
      if (fn) return fn.call(this, name);
      // Not a command. ONScripter would report it and drop the line; these are
      // lines of prose that lost their leading back-tick, so show them as text.
      this.pc = start;
      this.warn('unknown command "' + name + '" - treated as text');
      return this.textLine(true);
    }
    return this.textLine(false);
  }

  skipStatement() {
    const s = this.src;
    let p = this.pc, q = null;
    for (; p < this.len; p++) {
      const c = s[p];
      if (c === '\n') break;
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === '`') q = c;
      else if (c === ':' || c === ';') break;
    }
    this.pc = p;
  }

  // ------------------------------------------------------------------ display helpers
  async enterTextMode() {
    const gfx = this.host.gfx;
    if (this.textMode) {
      if (gfx.dirty) gfx.present(true);
      return;
    }
    this.textMode = true;
    await gfx.transition(this.windowEffect, true, () => this.skipping());
  }
  async leaveTextMode(force) {
    if (this.textMode && (force || this.eraseTextWindow !== 0)) {
      this.textMode = false;
      await this.host.gfx.transition(this.windowEffect, false, () => this.skipping());
    }
  }
  async doEffect(eff) {
    const gfx = this.host.gfx;
    if (eff.type === 0) { gfx.dirty = true; return; }
    await gfx.transition(eff, this.textMode, () => this.skipping());
    if (eff.type !== 1 && this.effectBlank > 0 && !this.skipping()) await this.host.sleep(this.effectBlank);
    this.host.input.flush();
  }
  newPage() {
    this.host.text.clear(true);
    this.host.gfx.present(this.textMode);
  }

  textDelay() {
    const base = this.waitTime >= 0 ? this.waitTime : 20;
    return base * [2, 1, 0.4][this.textSpeedNo];
  }

  async wait(ms, clickSkips) {
    if (ms <= 0) return;
    const input = this.host.input;
    if (this.skipping()) { await this.host.sleep(Math.min(ms / 10, 10)); return; }
    const end = Date.now() + ms;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return;
      await this.host.sleep(Math.min(left, 30));
      if (this.skipping()) return;
      if (clickSkips && input.takeClick()) return;
    }
  }

  // ------------------------------------------------------------------ text
  async textLine(fromBadCommand) {
    const s = this.src;
    const start = this.pc;
    let eol = s.indexOf('\n', start);
    if (eol < 0) eol = this.len;
    const tok = s.slice(start, eol);
    this.pc = eol;
    if (this.saveon) this.takeSnapshot(start);
    await this.enterTextMode();
    await this.typeText(tok, fromBadCommand);
  }

  expandVar(tok, i) {
    // $name / $123 / %name / %123 inside a text line
    const m = /^[$%]([A-Za-z_][A-Za-z_0-9]*|\d+)/.exec(tok.slice(i, i + 48));
    if (!m) return null;
    let idx;
    if (isDigit(m[1][0])) idx = parseInt(m[1], 10);
    else {
      idx = this.numalias.get(m[1].toLowerCase());
      if (idx === undefined) return null;
    }
    return { len: m[0].length, text: tok[i] === '$' ? this.getStr(idx) : String(this.getNum(idx)) };
  }

  async typeText(tok, forceOneByte) {
    const { text, gfx, input } = this.host;
    const n = tok.length;
    let i = 0;
    let oneByte = !!forceOneByte;
    let noNewline = false;
    let instant = false;
    let due = Date.now();
    let wordStart = true;

    // `breaking` is a space between words: the line may break there, and then nothing is typed
    const put = async (ch, breaking) => {
      if (text.pageFull()) {
        gfx.present(true);
        await this.host.ui.clickWait('\\');
        this.newPage();
        instant = false;
        due = Date.now();
      }
      if (breaking) { if (text.space()) return; } else text.put(ch);
      if (instant || this.skipping()) return;
      const d = this.textDelay();
      if (d <= 0) return;
      due += d;
      const now = Date.now();
      if (due - now >= 4) {
        gfx.present(true);
        await this.host.sleep(due - now);
        if (input.takeClick()) instant = true;
      } else if (due < now - 100) due = now;
    };

    while (i < n) {
      const ch = tok[i];
      if (ch === '`') { oneByte = !oneByte; i++; wordStart = true; continue; }
      if (ch === '@') {
        i++;
        gfx.present(true);
        await this.host.ui.clickWait('@');
        instant = false; due = Date.now();
        continue;
      }
      if (ch === '\\') {
        i++;
        gfx.present(true);
        await this.host.ui.clickWait('\\');
        this.newPage();
        instant = false; due = Date.now();
        continue;
      }
      if (ch === '!') {
        const m = /^!(sd|s\d+|w\d+|d\d+)/.exec(tok.slice(i, i + 12));
        if (m) {
          i += m[0].length;
          const k = m[1][0];
          if (m[1] === 'sd') this.waitTime = -1;
          else if (k === 's') this.waitTime = parseInt(m[1].slice(1), 10);
          else {
            gfx.present(true);
            await this.wait(parseInt(m[1].slice(1), 10), k === 'd');
            due = Date.now();
          }
          continue;
        }
      }
      if (ch === '#' && /^#[0-9a-fA-F]{6}/.test(tok.slice(i, i + 7))) {
        text.color = tok.slice(i, i + 7).toLowerCase();
        i += 7;
        continue;
      }
      if (ch === '/' && tok.slice(i + 1).trim() === '') { noNewline = true; break; }
      if (!oneByte) {
        if (ch === ' ' || ch === '\t') { i++; continue; }
        if (ch === '_') { i++; continue; }
        if (ch === '$' || ch === '%') {
          const ex = this.expandVar(tok, i);
          if (ex) {
            i += ex.len;
            for (const c2 of ex.text) {
              if (c2 === '`') continue;
              await put(c2 === '^' ? ' ' : c2);
            }
            continue;
          }
        }
        await put(ch);
        i++;
        continue;
      }
      // one-byte (English) text: wrap at word boundaries
      if (ch === ' ') {
        await put(' ', true);
        i++;
        wordStart = true;
        continue;
      }
      if (wordStart) {
        // tell the layout which letters come next, so the word moves to a new line whole if it must
        let j = i;
        while (j < n) {
          const c2 = tok[j];
          if (c2 === ' ' || c2 === '@' || c2 === '\\' || c2 === '`') break;
          j++;
        }
        text.word(tok.slice(i, j));
        wordStart = false;
      }
      await put(ch);
      i++;
    }
    if (!noNewline) text.endLine();
    gfx.present(true);
  }

  // ------------------------------------------------------------------ save / load
  takeSnapshot(pc) {
    const { gfx, text } = this.host;
    const nums = {}, strs = {}, arrays = {};
    for (const k in this.nums) if (+k < GLOBAL_BORDER && this.nums[k]) nums[k] = this.nums[k];
    for (const k in this.strs) if (+k < GLOBAL_BORDER && this.strs[k]) strs[k] = this.strs[k];
    for (const k in this.arrays) arrays[k] = Array.from(this.arrays[k].data);
    this.snapshot = {
      v: 1,
      pc,
      stack: this.callStack.slice(),
      nums, strs, arrays,
      gfx: gfx.serialize(),
      text: text.serialize(),
      textMode: this.textMode,
      eraseTextWindow: this.eraseTextWindow,
      windowEffect: this.windowEffect,
      waitTime: this.waitTime,
      cursors: this.cursors.map((c) => (c ? { tag: c.tag, x: c.x, y: c.y, abs: c.abs } : null)),
      bgm: this.bgm,
      waveLoop: this.waveLoop,
      saveon: this.saveon,
      lastTilde: this.lastTilde,
      flow: this.currentFlow,
    };
    return this.snapshot;
  }

  saveToSlot(no) {
    if (!this.snapshot) return false;
    this.flushGlobals(true);
    const { gfx, text } = this.host;
    const data = Object.assign({ time: Date.now(), scriptLen: this.scriptLen }, this.snapshot);
    data.text = text.pack(data.text);
    if (no <= this.saveNumber) {     // the reader's own slots carry a picture and a line of the page
      data.thumb = gfx.thumbnail ? gfx.thumbnail() || null : null;
      data.excerpt = text.excerpt ? text.excerpt() : '';
    }
    return this.host.storage.saveSlot(no, data);
  }

  async doReset() {
    const { gfx, text, audio } = this.host;
    this.resetLocal();
    if (this.host.onState) this.host.onState();
    if (this.host.onMusic) this.host.onMusic();
    audio.stopBgm(0);
    audio.stopSe();
    gfx.reset();
    text.reset();
    gfx.present(false);
    this.jumpTo('start');
  }

  async applySnapshot(snap) {
    const { gfx, text, audio } = this.host;
    this.resetLocal();
    if (this.host.onState) this.host.onState();
    if (this.host.onMusic) this.host.onMusic();
    for (const k in snap.nums) this.nums[k] = snap.nums[k];
    for (const k in snap.strs) this.strs[k] = snap.strs[k];
    for (const k in snap.arrays) {
      const a = this.arrays[k];
      if (a) a.data.set(snap.arrays[k].slice(0, a.data.length));
    }
    this.callStack = snap.stack.slice();
    this.eraseTextWindow = snap.eraseTextWindow;
    this.windowEffect = snap.windowEffect;
    this.waitTime = snap.waitTime;
    this.saveon = snap.saveon;
    this.lastTilde = snap.lastTilde || 0;
    this.currentFlow = snap.flow || null;
    this.textMode = !!snap.textMode;
    this.cursors = [null, null];
    for (let i = 0; i < 2; i++) {
      const c = snap.cursors && snap.cursors[i];
      if (c) this.cursors[i] = { tag: c.tag, x: c.x, y: c.y, abs: c.abs, sprite: await gfx.loadSprite(c.tag) };
    }
    audio.stopSe();
    await gfx.restore(snap.gfx);
    await text.restore(snap.text);
    gfx.present(this.textMode);
    this.bgm = snap.bgm;
    if (this.bgm) audio.playBgm(this.bgm.file, this.bgm.loop); else audio.stopBgm(0);
    this.waveLoop = snap.waveLoop;
    if (this.waveLoop) audio.playSe(this.waveLoop, true);
    this.snapshot = snap;
    this.pc = snap.pc;
  }
}

// ====================================================================== commands
const COMMANDS = Object.create(null);
const def = (names, fn) => { for (const n of names.split(' ')) COMMANDS[n] = fn; };
export const commandNames = () => Object.keys(COMMANDS);

// ---- definitions
def('numalias', function () {
  this.ws();
  const name = this.readIdent().toLowerCase();
  this.comma();
  this.numalias.set(name, this.readInt());
});
def('stralias', function () {
  this.ws();
  const name = this.readIdent().toLowerCase();
  this.comma();
  this.stralias.set(name, this.readStr());
});
def('effect', function () {
  const no = this.readInt();
  this.comma();
  const type = this.readInt();
  let dur = 0, mask = null;
  if (this.tryComma()) dur = this.readInt();
  if (this.tryComma()) mask = this.readStr();
  this.effects.set(no, { type, dur, mask });
});
def('effectblank', function () { this.effectBlank = this.readInt(); });
def('cdfadeout', function () { this.cdFadeout = this.readInt(); });
def('mp3fadeout', function () { this.mp3Fadeout = this.readInt(); });
def('versionstr', function () { this.versionStr[0] = this.readStr(); this.comma(); this.versionStr[1] = this.readStr(); });
def('caption', function () { this.caption = this.readStr(); if (this.host.onCaption) this.host.onCaption(this.caption); });
def('selectcolor', function () { this.selectColor[0] = this.readStr(); this.comma(); this.selectColor[1] = this.readStr(); });
def('menuselectcolor', function () {
  this.menuSelectColor[0] = this.readStr(); this.comma();
  this.menuSelectColor[1] = this.readStr(); this.comma();
  this.menuSelectColor[2] = this.readStr();
});
def('menusetwindow', function () {
  const m = this.menuWindow;
  m.fw = this.readInt(); this.comma(); m.fh = this.readInt(); this.comma();
  m.px = this.readInt(); this.comma(); m.py = this.readInt(); this.comma();
  m.bold = this.readInt(); this.comma(); m.shadow = this.readInt(); this.comma();
  m.color = this.readStr();
});
def('rmenu', function () {
  this.rmenu = [];
  while (!this.atEnd()) {
    const label = this.readStr();
    this.comma();
    const action = this.readStr().toLowerCase();
    this.rmenu.push({ label, action });
    if (!this.tryComma()) break;
  }
});
def('savenumber', function () { this.saveNumber = Math.max(1, Math.min(20, this.readInt())); });
def('savename', function () {
  this.saveName[0] = this.readStr(); this.comma();
  this.saveName[1] = this.readStr(); this.comma();
  this.saveName[2] = this.readStr();
});
def('lookbackbutton', function () {
  const b = [];
  for (let i = 0; i < 4; i++) { if (i) this.comma(); b.push(this.readStr()); }
  this.lookbackButtons = b;
});
def('lookbackcolor', function () { this.lookbackColor = this.readStr(); });
def('globalon', function () { this.globalOn = true; });
def('dim', function () {
  this.ws();
  if (this.src[this.pc] === '?') this.pc++;
  const ref = this.arrayRef();
  const dims = ref.idx.map((n) => n + 1);
  let size = 1;
  for (const d of dims) size *= d;
  this.arrays[ref.id] = { dims, data: new Int32Array(size) };
});
// accepted and ignored: these configure things that have no browser equivalent
def('nsa arc ns2 ns3 nsadir filelog labellog kidokuskip mode_saya mode_ext mode800 mode400 mode320 ' +
    'transmode humanz underline windowback defaultfont defaultspeed mousecursor killmenu roff rmode ' +
    'clickstr clickvoice selectvoice linepage usewheel useescspc pretextgosub textgosub loadgosub ' +
    'maxkaisoupage lookbacksp soundpressplgin spi automode_time defvoicevol defsevol defmp3vol ' +
    'shadedistance intlimit zenkakko english mode_wave_demo savedir humanorder insertmenu resetmenu deletemenu ' +
    'menu_full menu_window menu_automode menu_click_def menu_click_page menu_dwavvolume lookbackflush lookbackvoice',
  function () { this.skipStatement(); });
def('game', function () {
  this.gameStarted = true;
  this.jumpTo('start');
});
def('reset', function () { throw new Signal('reset'); });
def('end', function () { throw new Signal('end'); });
def('definereset', function () { throw new Signal('reset'); });

// ---- arithmetic
def('mov', function () {
  const ref = this.readVarRef();
  this.comma();
  this.setRef(ref, ref.t === 's' ? this.readStr() : this.readInt());
});
def('movl', function () {
  this.ws();
  if (this.src[this.pc] === '?') this.pc++;
  const ref = this.arrayRef();
  const a = this.arrays[ref.id];
  let i = 0;
  while (this.tryComma()) {
    const v = this.readInt();
    if (a && i < a.data.length) a.data[i] = v;
    i++;
  }
});
def('add', function () {
  const ref = this.readVarRef();
  this.comma();
  if (ref.t === 's') this.setRef(ref, this.getRef(ref) + this.readStr());
  else this.setRef(ref, (this.getRef(ref) + this.readInt()) | 0);
});
def('sub', function () { const r = this.readVarRef(); this.comma(); this.setRef(r, (this.getRef(r) - this.readInt()) | 0); });
def('mul', function () { const r = this.readVarRef(); this.comma(); this.setRef(r, Math.imul(this.getRef(r), this.readInt())); });
def('div', function () { const r = this.readVarRef(); this.comma(); const d = this.readInt(); this.setRef(r, d ? Math.trunc(this.getRef(r) / d) : 0); });
def('mod', function () { const r = this.readVarRef(); this.comma(); const d = this.readInt(); this.setRef(r, d ? this.getRef(r) % d : 0); });
def('inc', function () { const r = this.readVarRef(); this.setRef(r, (this.getRef(r) + 1) | 0); });
def('dec', function () { const r = this.readVarRef(); this.setRef(r, (this.getRef(r) - 1) | 0); });
def('rnd', function () {
  const r = this.readVarRef();
  this.comma();
  const n = this.readInt();
  this.setRef(r, n > 0 ? Math.floor(this.host.random() * n) : 0);
});
def('rnd2', function () {
  const r = this.readVarRef();
  this.comma(); const lo = this.readInt();
  this.comma(); const hi = this.readInt();
  this.setRef(r, lo + Math.floor(this.host.random() * (hi - lo + 1)));
});
def('itoa itoa2', function () { const r = this.readVarRef(); this.comma(); this.setRef(r, String(this.readInt())); });
def('atoi', function () { const r = this.readVarRef(); this.comma(); this.setRef(r, parseInt(this.readStr(), 10) || 0); });
def('len', function () { const r = this.readVarRef(); this.comma(); this.setRef(r, this.readStr().length); });
def('cmp', function () {
  const r = this.readVarRef();
  this.comma(); const a = this.readStr();
  this.comma(); const b = this.readStr();
  this.setRef(r, a < b ? -1 : a > b ? 1 : 0);
});
def('date', function () {
  const d = new Date();
  const vals = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate()];
  for (let i = 0; i < 3; i++) { if (i) this.comma(); this.setRef(this.readVarRef(), vals[i]); }
});
def('time', function () {
  const d = new Date();
  const vals = [d.getHours(), d.getMinutes(), d.getSeconds()];
  for (let i = 0; i < 3; i++) { if (i) this.comma(); this.setRef(this.readVarRef(), vals[i]); }
});
def('getversion', function () { this.setRef(this.readVarRef(), NSC_VERSION); });

// ---- control flow
function cond(neg) {
  const s = this.src;
  let ok = true;
  for (;;) {
    this.ws();
    let f;
    const c = s[this.pc];
    if (c === 'f' && s.startsWith('fchk', this.pc) && !isIdent(s[this.pc + 4])) {
      this.pc += 4;
      f = this.fileLog.has(normFile(this.readStr()));
    } else if (c === 'l' && s.startsWith('lchk', this.pc) && !isIdent(s[this.pc + 4])) {
      this.pc += 4;
      f = this.labelLog.has(this.readLabel());
    } else {
      const isStr = c === '"' || c === '`' || c === '$';
      const a = isStr ? this.readStr() : this.readInt();
      this.ws();
      let op = s[this.pc];
      const two = s.slice(this.pc, this.pc + 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '<>') { op = two; this.pc += 2; }
      else if (op === '=' || op === '>' || op === '<') this.pc++;
      else { this.warn('comparison operator expected'); op = '=='; }
      const b = isStr ? this.readStr() : this.readInt();
      switch (op) {
        case '>=': f = a >= b; break;
        case '<=': f = a <= b; break;
        case '=': case '==': f = a === b; break;
        case '!=': case '<>': f = a !== b; break;
        case '>': f = a > b; break;
        default: f = a < b;
      }
    }
    if (neg ? f : !f) ok = false;
    this.ws();
    if (s[this.pc] === '&') { while (s[this.pc] === '&') this.pc++; continue; }
    break;
  }
  if (!ok) this.skipLine();
}
def('if', function () { cond.call(this, false); });
def('notif', function () { cond.call(this, true); });
def('goto', function () { this.jumpTo(this.readLabel()); });
def('gosub', function () {
  const l = this.readLabel();
  const ret = this.pc;
  if (this.jumpTo(l)) this.callStack.push(ret);
});
def('return', function () {
  let label = null;
  if (!this.atEnd() && this.src[this.pc] === '*') label = this.readLabel();
  if (!this.callStack.length) { this.warn('return without gosub'); return; }
  const ret = this.callStack.pop();
  if (label) this.jumpTo(label); else this.pc = ret;
});
def('skip', function () {
  const line = this.lineOf(this.stmtStart);
  let n = 1;
  if (!this.atEnd()) n = this.readInt();
  const target = line + n;
  if (target < 0 || target >= this.lineStarts.length) { this.warn('skip out of range'); return; }
  this.pc = this.lineStarts[target];
});
def('jumpf', function () {
  const s = this.src;
  // rest of this line, then the first later line that begins with "~"
  let p = this.pc;
  for (; p < this.len && s[p] !== '\n'; p++) if (s[p] === '~') { this.pc = p + 1; this.lastTilde = this.pc; return; }
  for (let li = this.lineOf(p) + 1; li < this.lineStarts.length; li++) {
    let q = this.lineStarts[li];
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (s[q] === '~') { this.pc = q + 1; this.lastTilde = this.pc; return; }
  }
  this.warn('jumpf: no "~" found');
});
def('jumpb', function () { this.pc = this.lastTilde; });

// ---- timing
def('resettimer', function () { this.timerStart = Date.now(); });
def('waittimer', async function () {
  const n = this.readInt();
  const left = this.timerStart + n - Date.now();
  if (this.host.gfx.dirty) this.host.gfx.present(this.textMode);
  if (this.skipping()) { await this.host.sleep(left > 100 ? 4 : Math.max(0, Math.min(left, 4))); return; }
  if (left > 0) await this.host.sleep(left); else await this.host.yield();
});
def('gettimer', function () { this.setRef(this.readVarRef(), Date.now() - this.timerStart); });
def('wait', async function () { await this.wait(this.readInt(), false); });
def('delay', async function () { await this.wait(this.readInt(), true); });
def('click', async function () { await this.host.ui.clickWait('@', true); });

// ---- images
def('bg', async function () {
  const v = this.readStr();
  const eff = this.tryComma() ? this.readEffect() : { type: 1, dur: 0 };
  await this.leaveTextMode();
  const gfx = this.host.gfx;
  gfx.clearTachi(-1);
  const lv = v.toLowerCase();
  let same = false;
  if (lv === 'black') gfx.setBgColor('#000000');
  else if (lv === 'white') gfx.setBgColor('#ffffff');
  else if (v[0] === '#') gfx.setBgColor(v);
  else { this.logFile(v); same = await gfx.setBgImage(v); }
  // (between two of the redrawn menu pages the background is the same sheet of paper: nothing to fade)
  await this.doEffect(same ? { type: 1, dur: 0 } : eff);
});
def('ld', async function () {
  const pos = this.readStr().toLowerCase();
  this.comma();
  const tag = this.readStr();
  const eff = this.tryComma() ? this.readEffect() : { type: 1, dur: 0 };
  await this.leaveTextMode();
  const idx = pos === 'l' ? 0 : pos === 'r' ? 2 : 1;
  this.logFile(tag.replace(/^:[^;]*;/, ''));
  await this.host.gfx.setTachi(idx, tag);
  await this.doEffect(eff);
});
def('cl', async function () {
  const pos = this.readStr().toLowerCase();
  const eff = this.tryComma() ? this.readEffect() : { type: 1, dur: 0 };
  await this.leaveTextMode();
  this.host.gfx.clearTachi(pos === 'l' ? 0 : pos === 'c' ? 1 : pos === 'r' ? 2 : -1);
  await this.doEffect(eff);
});
def('print', async function () {
  const eff = this.readEffect();
  await this.leaveTextMode();
  await this.doEffect(eff.type === 0 ? { type: 1, dur: 0 } : eff);
});
def('lsp lsph', async function (name) {
  const no = this.readInt();
  this.comma(); const tag = this.readStr();
  this.comma(); const x = this.readInt();
  this.comma(); const y = this.readInt();
  let alpha = 255;
  if (this.tryComma()) alpha = this.readInt();
  this.logFile(tag.replace(/^:[^;]*;/, ''));
  await this.host.gfx.setSprite(no, tag, x, y, alpha, name === 'lsp');
});
def('csp', function () {
  const no = this.atEnd() ? -1 : this.readInt();
  this.host.gfx.clearSprite(no);
});
def('vsp', function () {
  const no = this.readInt();
  this.comma();
  this.host.gfx.showSprite(no, this.readInt() !== 0);
});
def('msp amsp', function (name) {
  const no = this.readInt();
  this.comma(); const x = this.readInt();
  this.comma(); const y = this.readInt();
  let a = name === 'msp' ? 0 : null;
  if (this.tryComma()) a = this.readInt();
  this.host.gfx.moveSprite(no, x, y, a, name === 'amsp');
});
def('monocro', function () {
  this.ws();
  const v = this.readStr();
  this.host.gfx.setMonocro(v[0] === '#' ? v : null);
});
def('nega', function () { this.host.gfx.setNega(this.readInt()); });
def('quake quakex quakey', async function (name) {
  const amp = this.readInt();
  this.comma();
  const dur = this.readInt();
  await this.leaveTextMode();
  if (this.skipping()) { this.host.gfx.present(this.textMode); return; }
  await this.host.gfx.quake(name, amp, dur, this.textMode, () => this.skipping());
});
def('setcursor abssetcursor', async function (name) {
  const no = this.readInt();
  this.comma(); const tag = this.readStr();
  this.comma(); const x = this.readInt();
  this.comma(); const y = this.readInt();
  if (no < 0 || no > 1) return;
  const sprite = await this.host.gfx.loadSprite(tag);
  this.cursors[no] = { tag, x, y, abs: name === 'abssetcursor', sprite };
});

// ---- buttons
def('btndef', async function () {
  this.ws();
  const v = this.readStr();
  this.buttons = [];
  this.btnImage = null;
  this.btnDefName = v;
  if (v && v.toLowerCase() !== 'clear') this.btnImage = await this.host.gfx.loadPlain(v);
});
def('btn', function () {
  const b = [];
  for (let i = 0; i < 7; i++) { if (i) this.comma(); b.push(this.readInt()); }
  this.buttons = this.buttons.filter((o) => o.no !== b[0]);
  this.buttons.push({ no: b[0], x: b[1], y: b[2], w: b[3], h: b[4], sx: b[5], sy: b[6] });
});
def('btnwait btnwait2', async function (name) {
  const ref = this.readVarRef();
  if (name === 'btnwait') await this.leaveTextMode();
  this.setSkip(false);
  this.host.gfx.present(this.textMode);
  this.flushGlobals();
  const r = await this.host.ui.buttonWait(this.buttons, this.btnImage, this.btnDefName);
  this.setRef(ref, r);
});
def('blt', function () {
  const a = [];
  for (let i = 0; i < 8; i++) { if (i) this.comma(); a.push(this.readInt()); }
  if (this.btnImage) this.host.gfx.blt(this.btnImage, a);
});
def('ofscpy', function () { this.btnImage = this.host.gfx.grabScreen(); });

// ---- text window
def('setwindow', async function () {
  const p = [];
  for (let i = 0; i < 11; i++) { if (i) this.comma(); p.push(this.readInt()); }
  this.comma();
  const color = this.readStr();
  const r = [];
  for (let i = 0; i < 2; i++) { this.comma(); r.push(this.readInt()); }
  while (this.tryComma()) r.push(this.readInt());
  const win = {
    x: p[0], y: p[1], cols: p[2], rows: p[3], fw: p[4], fh: p[5], px: p[6], py: p[7],
    speed: p[8], bold: p[9], shadow: p[10], color: null, image: null,
    rx: r[0], ry: r[1], rr: r.length > 2 ? r[2] : 639, rb: r.length > 3 ? r[3] : 479,
  };
  if (color[0] === '#') win.color = color; else win.image = color;
  this.waitTime = win.speed;
  this.textMode = false;
  await this.host.text.setWindow(win);
  this.host.gfx.present(false);
});
def('br', async function () {
  await this.enterTextMode();
  this.host.text.newline();
});
def('locate', function () {
  const x = this.readInt();
  this.comma();
  this.host.text.locate(x, this.readInt());
});
def('textclear', function () { this.host.text.clear(false); this.host.gfx.present(this.textMode); });
def('texton', async function () { await this.enterTextMode(); });
def('textoff', async function () { await this.leaveTextMode(true); });
def('erasetextwindow', function () { this.eraseTextWindow = this.readInt(); });
def('windoweffect', function () { this.windowEffect = this.readEffect(); });
def('saveon', function () { this.saveon = true; });
def('saveoff', function () { this.saveon = false; });

// ---- choices
async function select(name) {
  const start = this.stmtStart;
  const mode = name === 'selnum' ? 'num' : name === 'selgosub' ? 'gosub' : 'goto';
  let ref = null;
  if (mode === 'num') { ref = this.readVarRef(); this.comma(); }
  const opts = [];
  for (;;) {
    const text = this.readStr();
    let label = null;
    if (mode !== 'num') { this.comma(); label = this.readLabel(); }
    opts.push({ text, label });
    if (!this.tryComma()) break;
  }
  const ret = this.pc;
  if (this.saveon) this.takeSnapshot(start);
  await this.enterTextMode();
  this.setSkip(false);
  this.flushGlobals();
  const idx = await this.host.ui.select(opts.map((o) => o.text));
  if (mode === 'num') this.setRef(ref, idx);
  else if (mode === 'gosub') { if (this.jumpTo(opts[idx].label)) this.callStack.push(ret); }
  else this.jumpTo(opts[idx].label);
  this.newPage();
}
def('select selgosub selnum', select);

// ---- sound
function bgmFile(v) {
  const m = /^\*(\d+)/.exec(v);
  if (m) return 'cd/track' + String(parseInt(m[1], 10)).padStart(2, '0');
  return v;
}
def('play playonce bgm mp3 mp3loop', function (name) {
  const v = this.readStr();
  const loop = name !== 'playonce' && name !== 'mp3';
  const file = bgmFile(v);
  if (this.host.onMusic) this.host.onMusic();
  if (!this.musicLog.has(file)) { this.musicLog.add(file); this.globalsDirty = true; }
  this.bgm = loop ? { file, loop } : null;
  this.host.audio.playBgm(file, loop);
});
def('playstop mp3stop bgmstop stop', function (name) {
  this.bgm = null;
  if (this.host.onMusic) this.host.onMusic();
  this.host.audio.stopBgm(Math.max(this.cdFadeout, this.mp3Fadeout));
  if (name === 'stop') { this.waveLoop = null; this.host.audio.stopSe(); }
});
def('wave waveloop dwave dwaveloop', function (name) {
  if (name[0] === 'd') { this.readInt(); this.comma(); }
  const v = this.readStr();
  const loop = name.endsWith('loop');
  this.waveLoop = loop ? v : null;
  this.host.audio.playSe(v, loop);
});
def('wavestop dwavestop', function () {
  if (!this.atEnd()) this.readInt();
  this.waveLoop = null;
  this.host.audio.stopSe();
});
def('bgmvol mp3vol sevol voicevol', function () { this.readInt(); });

// ---- system
def('savegame', function () {
  const no = this.readInt();
  this.takeSnapshot(this.stmtStart);
  this.saveToSlot(no);
});
def('loadgame', function () {
  const no = this.readInt();
  const data = this.host.storage.loadSlot(no);
  if (data && data.scriptLen === this.scriptLen) throw new Signal('load', data);
});
def('systemcall', async function () {
  this.ws();
  const what = this.readIdent().toLowerCase();
  await this.host.ui.systemCall(what);
});
