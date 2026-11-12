// Text window: layout, drawing, page history.
//
// A page is kept as a stream of operations (characters, breaking spaces, word
// marks, line ends), not as fixed positions. Positions are worked out from the
// stream, so the same page can be set again in another font or line spacing -
// which is what happens to the page on screen and to the history when the
// reader changes the story font.
import { W, H } from './gfx.js';

// The story can be set in the game's own face or in one of the reader's. The game's font draws
// "|" as an ellipsis and "^" as a blank, so the other faces are given the real characters.
// `scale` is the letter size against the game's, `lead` the line pitch against the game's.
const SUBST = { '|': '…', '^': ' ' };
export const FONTS = {
  original: { stack: '"NSFont", "MS Gothic", "Hiragino Kaku Gothic ProN", monospace', scale: 1, lead: 1, map: null },
  serif: { stack: '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", "TeX Gyre Pagella", Georgia, "Hiragino Mincho ProN", "Yu Mincho", serif', scale: 1.08, lead: 1.2, map: SUBST },
  sans: { stack: '"Helvetica Neue", Helvetica, Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", system-ui, sans-serif', scale: 1, lead: 1.16, map: SUBST },
};
let storyFont = 'original';
export function setStoryFont(key) { if (FONTS[key]) storyFont = key; }
export function storyFontKey() { return storyFont; }
const fontOf = (key) => FONTS[key] || FONTS.original;
const fontCss = (size, key) => { const f = fontOf(key); return Math.round(size * f.scale * 10) / 10 + 'px ' + f.stack; };
const shown = (ch, key) => { const m = fontOf(key).map; return (m && m[ch]) || ch; };

const DEFAULT_WIN = {
  x: 8, y: 16, cols: 23, rows: 16, fw: 26, fh: 26, px: 0, py: 2,
  speed: 20, bold: 0, shadow: 1, color: '#999999', image: null, rx: 0, ry: 0, rr: 639, rb: 479,
};

const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const mctx = measureCanvas ? measureCanvas.getContext('2d') : null;
const widthCache = new Map();
const ascentCache = new Map();

export function charWidth(ch, size, font = 'original') {
  const key = font + size + ch;
  let w = widthCache.get(key);
  if (w === undefined) {
    mctx.font = fontCss(size, font);
    w = mctx.measureText(shown(ch, font)).width;
    widthCache.set(key, w);
  }
  return w;
}
function ascent(size, font = 'original') {
  const ck = font + size;
  let a = ascentCache.get(ck);
  if (a === undefined) {
    mctx.font = fontCss(size, font);
    const m = mctx.measureText('Mgあ');
    a = m.fontBoundingBoxAscent && m.fontBoundingBoxDescent !== undefined
      ? Math.round((size - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent)
      : Math.round(size * 0.86);
    ascentCache.set(ck, a);
  }
  return a;
}

// script strings carry back-ticks (1-byte text markers) and "^" (a space that survives trimming)
export function cleanLabel(s) {
  return s.replace(/`/g, '').replace(/\^/g, ' ');
}

// ---------------------------------------------------------------------- layout
// Operations of a page:
//   { t: 'c', c, col }   a character
//   { t: 's', col }      a space that a line may break at (it is dropped when it does)
//   { t: 'w', s }        a word of these letters follows: start a new line first if it will not fit
//   { t: 'n' }           new line
//   { t: 'e' }           end of a line of the script: new line unless already at the start of one
//   { t: 'l', x, y }     move to column x, row y
function newState(win, font) {
  const size = Math.min(win.fw, win.fh);
  return {
    win, font, size,
    pitch: win.fw + win.px,
    lineW: win.cols * (win.fw + win.px),
    lineH: Math.round((win.fh + win.py) * fontOf(font).lead),
    x: 0, line: 0, glyphs: [],
  };
}
// Applies one operation; returns the glyph it made, if any.
function apply(st, o) {
  const adv = (ch) => charWidth(ch, st.size, st.font) + st.win.px;
  const glyph = (ch, hid) => {
    const g = { c: ch, x: st.win.x + st.x, y: st.win.y + st.line * st.lineH, col: o.col, f: st.size, s: st.win.shadow ? 1 : 0, ff: st.font, o, hid: !!hid };
    st.glyphs.push(g);
    return g;
  };
  switch (o.t) {
    case 'c': {
      const a = adv(o.c);
      if (st.x > 0 && st.x + a > st.lineW + 0.01) { st.x = 0; st.line++; }
      const g = glyph(o.c);
      st.x += a;
      return g;
    }
    case 's': {
      const a = adv(' ');
      if (st.x + a > st.lineW) { st.x = 0; st.line++; return glyph(' ', true); }
      const g = glyph(' ');
      st.x += a;
      return g;
    }
    case 'w': {
      let w = 0;
      for (const ch of o.s) w += adv(ch);
      if (st.x > 0 && st.x + w > st.lineW && w <= st.lineW) { st.x = 0; st.line++; }
      return null;
    }
    case 'n': st.x = 0; st.line++; return null;
    case 'e': if (st.x > 0) { st.x = 0; st.line++; } return null;
    case 'l': st.x = o.x * st.pitch; st.line = o.y; return null;
    default: return null;
  }
}

export class TextLayer {
  constructor(gfx) {
    this.gfx = gfx;
    this.S = gfx.S;
    this.canvas = document.createElement('canvas');
    this.canvas.width = gfx.VW * this.S;
    this.canvas.height = H * this.S;
    this.ctx = this.canvas.getContext('2d');
    this.reset();
  }

  // the view changed shape (gfx.js): the page is drawn again where the game's 640 now stands in it
  resize() {
    this.canvas.width = this.gfx.VW * this.S;
    this.canvas.height = H * this.S;
    this.redraw();
  }

  reset() {
    this.win = Object.assign({}, DEFAULT_WIN);
    this.winImage = null;
    this.color = '#ffffff';
    this.ops = [];
    this.st = newState(this.win, storyFont);
    this.history = [];
    this.redraw();
  }

  async setWindow(win) {
    this.win = win;
    this.winImage = win.image ? await this.gfx.loadPlain(win.image) : null;
    this.ops = [];
    this.st = newState(win, storyFont);
    this.redraw();
  }

  get glyphs() { return this.st.glyphs; }
  get x() { return this.st.x; }
  get line() { return this.st.line; }
  get size() { return this.st.size; }
  get lineW() { return this.st.lineW; }
  get lineH() { return this.st.lineH; }
  advance(ch) { return charWidth(ch, this.st.size, this.st.font) + this.win.px; }
  cursorX() { return this.win.x + this.st.x; }
  cursorY() { return this.win.y + this.st.line * this.st.lineH; }
  pageFull() {
    return this.st.line >= this.win.rows || this.cursorY() + this.win.fh > H + 2;
  }

  // ---------------------------------------------------------------- writing
  // lines of the window not yet begun, the one being written included
  linesLeft() { return this.win.rows - this.st.line; }
  op(o) {
    this.ops.push(o);
    const g = apply(this.st, o);
    if (g) this.drawGlyph(this.ctx, g, g.col);
    return g;
  }
  put(ch) { this.op({ t: 'c', c: ch, col: this.color }); }
  // a space between words; true when the line broke there instead
  space() { return this.op({ t: 's', col: this.color }).hid; }
  word(letters) { if (letters) this.op({ t: 'w', s: letters }); }
  newline() { this.op({ t: 'n' }); }
  endLine() { this.op({ t: 'e' }); }
  locate(cx, cy) { this.op({ t: 'l', x: cx, y: cy }); }
  // a whole string, wrapping at spaces (used for choices)
  putWords(str) {
    for (const part of cleanLabel(str).split(/( )/)) {
      if (!part) continue;
      if (part === ' ') { this.space(); continue; }
      this.word(part);
      for (const ch of part) this.put(ch);
    }
  }
  clear(pushHistory) {
    if (pushHistory && this.ops.some((o) => o.t === 'c' && o.c !== '　')) {
      this.history.push({ ops: this.ops, win: this.win, winImage: this.winImage });
      if (this.history.length > 200) this.history.shift();
    }
    this.ops = [];
    this.st = newState(this.win, storyFont);
    this.redraw();
  }

  // set a stream of operations for a window, in the story font of the moment
  layout(ops, win) {
    const st = newState(win, storyFont);
    for (const o of ops) apply(st, o);
    return st;
  }
  // set the page on screen again (after the font has changed)
  reflow() {
    this.st = this.layout(this.ops, this.win);
    this.redraw();
  }

  rectsOf(from, to) {
    const rows = new Map();
    for (let i = from; i < to; i++) {
      const g = this.glyphs[i];
      if (g.hid) continue;
      const w = charWidth(g.c, g.f, g.ff);
      const r = rows.get(g.y);
      if (!r) rows.set(g.y, { x: g.x, y: g.y, x2: g.x + w, h: this.lineH });
      else { r.x = Math.min(r.x, g.x); r.x2 = Math.max(r.x2, g.x + w); }
    }
    return [...rows.values()];
  }
  recolor(from, to, color) {
    for (let i = from; i < to; i++) { this.glyphs[i].col = color; this.glyphs[i].o.col = color; }
  }

  // the page as lines of plain text (for the history and for save slots)
  linesOf(glyphs) {
    const rows = new Map();
    for (const g of glyphs) {
      if (g.hid) continue;
      if (!rows.has(g.y)) rows.set(g.y, []);
      rows.get(g.y).push(g);
    }
    return [...rows.keys()].sort((a, b) => a - b).map((y) => rows.get(y).sort((a, b) => a.x - b.x).map((g) => shown(g.c, 'serif')).join('').replace(/\s+$/, ''));
  }
  historyLines(page) { return this.linesOf(this.layout(page.ops, page.win).glyphs); }
  excerpt(max = 110) {
    const t = this.linesOf(this.glyphs).join(' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  // ---------------------------------------------------------------- drawing
  drawGlyph(ctx, g, color) {
    if (g.hid || g.c === ' ' || g.c === '　') return;
    const S = this.S;
    ctx.setTransform(S, 0, 0, S, this.gfx.OX * S, 0);
    ctx.font = fontCss(g.f, g.ff);
    ctx.textBaseline = 'alphabetic';
    const x = Math.round(g.x * S) / S;
    const by = g.y + ascent(g.f, g.ff);
    const c = shown(g.c, g.ff);
    if (c === ' ') return;
    if (g.s) { ctx.fillStyle = '#000000'; ctx.fillText(c, x + 1, by + 1); }
    ctx.fillStyle = color;
    ctx.fillText(c, x, by);
  }
  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const g of this.glyphs) this.drawGlyph(ctx, g, g.col);
  }
  // darken (or draw the frame image of) the window area; ctx is in the game's coordinates.
  // A shade that reaches both sides of the game's 640 goes on to the sides of a wider view.
  drawShade(ctx, win = this.win, image = this.winImage) {
    if (image) { ctx.drawImage(image, win.rx, win.ry); return; }
    if (!win.color || win.color.toLowerCase() === '#ffffff') return;
    const ox = this.gfx.OX;
    const x0 = win.rx <= 0 ? -ox : win.rx, x1 = win.rr >= W - 1 ? W + ox : win.rr + 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = win.color;
    ctx.fillRect(x0, win.ry, x1 - x0, win.rb - win.ry + 1);
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- persistence
  serialize() {
    return { win: this.win, color: this.color, ops: this.ops.slice() };
  }
  // compact form for storage: runs of characters of one colour become one entry
  pack(st) {
    if (!st.ops || st.packed) return st;
    const out = [];
    let run = null;
    for (const o of st.ops) {
      if (o.t === 'c') {
        if (run && run.col === o.col) run.s += o.c;
        else { run = { t: 'c', s: o.c, col: o.col }; out.push(run); }
        continue;
      }
      run = null;
      out.push(o.t === 's' ? { t: 's', col: o.col } : o.t === 'w' ? { t: 'w', s: o.s } : o.t === 'l' ? { t: 'l', x: o.x, y: o.y } : { t: o.t });
    }
    return { win: st.win, color: st.color, ops: out, packed: true };
  }
  async restore(st) {
    this.win = st.win;
    this.winImage = st.win.image ? await this.gfx.loadPlain(st.win.image) : null;
    this.color = st.color;
    const ops = [];
    if (st.ops) {
      for (const o of st.ops) {
        if (o.t === 'c' && o.s !== undefined) for (const c of o.s) ops.push({ t: 'c', c, col: o.col });
        else ops.push(Object.assign({}, o));
      }
    } else {
      // saves made before pages were kept as a stream: positions, as runs or as single glyphs
      let y = null;
      const row = (gy) => { if (y !== null && gy !== y) ops.push({ t: 'n' }); y = gy; };
      if (st.runs) for (const r of st.runs) { row(r.y); for (const c of r.t) ops.push({ t: 'c', c, col: r.col }); }
      else for (const g of st.glyphs || []) { row(g.y); ops.push({ t: 'c', c: g.c, col: g.col }); }
      if (ops.length) ops.push({ t: 'e' });
    }
    this.ops = ops;
    this.history = [];
    this.reflow();
  }
}
