// Rendering: background, standing pictures, sprites, monochrome tint, text
// window, and the NScripter transition effects. Logical resolution is 640x480;
// every canvas is backed at S times that so text stays sharp on large screens.

export const W = 640;
export const H = 480;
const HUMAN_Z = 499; // sprites with a higher number are drawn behind standing pictures
const QUAKE_AMP = 12;

export class Loader {
  constructor(base, manifest) {
    this.base = base;
    this.files = new Set(manifest.files);
    this.images = new Map();
  }
  resolve(name) {
    const p = name.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
    if (this.files.has('arc/' + p)) return this.base + 'arc/' + enc(p);
    if (this.files.has(p)) return this.base + enc(p);
    return null;
  }
  findAudio(name) {
    const p = name.replace(/\\/g, '/').toLowerCase();
    if (/\.(ogg|mp3|wav)$/.test(p)) return this.resolve(p);
    for (const ext of ['.ogg', '.mp3', '.wav']) {
      const u = this.resolve(p + ext);
      if (u) return u;
    }
    return null;
  }
  image(name) {
    const url = this.resolve(name);
    if (!url) return Promise.resolve(null);
    let p = this.images.get(url);
    if (!p) {
      p = new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => { console.warn('failed to load', url); res(null); };
        img.src = url;
      });
      this.images.set(url, p);
      if (this.images.size > 80) this.images.delete(this.images.keys().next().value);
    }
    return p;
  }
  // The exact pixels of a .bmp, decoded from the file's own bytes. Reading them back off a canvas
  // is not exact everywhere: a browser that guards against fingerprinting (Brave) nudges the
  // values it hands back, and a colour key then matches nothing.
  pixels(name) {
    const url = this.resolve(name);
    if (!url || !/\.bmp$/i.test(url)) return Promise.resolve(null);
    return fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => (buf ? decodeBmp(buf) : null))
      .catch(() => null);
  }
}

// Uncompressed 8-bit palettised, 24-bit and 32-bit bitmaps -> { w, h, data: RGBA }; null for the rest.
function decodeBmp(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 54 || v.getUint16(0, true) !== 0x4d42) return null;
  const off = v.getUint32(10, true), hs = v.getUint32(14, true);
  if (hs < 40) return null;
  const w = v.getInt32(18, true), sh = v.getInt32(22, true);
  const bpp = v.getUint16(28, true), comp = v.getUint32(30, true);
  if (comp !== 0 || w <= 0 || !sh || (bpp !== 8 && bpp !== 24 && bpp !== 32)) return null;
  const h = Math.abs(sh), stride = ((w * bpp + 31) >> 5) << 2;
  const pal = 14 + hs;
  if (off + stride * h > v.byteLength || (bpp === 8 && pal + 1024 > v.byteLength)) return null;
  const b = new Uint8Array(buf);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, di = 0; y < h; y++) {
    const row = off + (sh > 0 ? h - 1 - y : y) * stride; // rows run bottom-up unless the height is negative
    for (let x = 0; x < w; x++, di += 4) {
      const p = bpp === 8 ? pal + b[row + x] * 4 : row + x * (bpp >> 3);
      data[di] = b[p + 2]; data[di + 1] = b[p + 1]; data[di + 2] = b[p]; data[di + 3] = 255;
    }
  }
  return { w, h, data };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ":a/3,160,2;file" -> { trans, cells, delays, loop, file }
export function parseTag(tag) {
  const out = { trans: 'l', cells: 1, delays: [0], loop: 0, file: tag };
  if (tag[0] !== ':') return out;
  const semi = tag.indexOf(';');
  if (semi < 0) return out;
  out.file = tag.slice(semi + 1);
  let head = tag.slice(1, semi);
  const m = /^(#[0-9a-fA-F]{6}|[a-zA-Z])?(.*)$/.exec(head);
  if (m[1]) out.trans = m[1].toLowerCase();
  head = m[2];
  if (head[0] === '/') {
    const parts = head.slice(1);
    const mm = /^(\d+)(?:,(<[\d,]+>|\d+))?(?:,(\d+))?/.exec(parts);
    if (mm) {
      out.cells = Math.max(1, parseInt(mm[1], 10));
      if (mm[2]) {
        if (mm[2][0] === '<') out.delays = mm[2].slice(1, -1).split(',').map((n) => parseInt(n, 10));
        else out.delays = new Array(out.cells).fill(parseInt(mm[2], 10));
      }
      if (mm[3]) out.loop = parseInt(mm[3], 10);
    }
  }
  return out;
}

export class Gfx {
  constructor(canvas, loader, scale) {
    this.S = scale;
    this.loader = loader;
    this.screen = canvas;
    canvas.width = W * scale;
    canvas.height = H * scale;
    this.sctx = canvas.getContext('2d');
    this.base = makeCanvas(W * scale, H * scale);   // everything below the text window
    this.bctx = this.base.getContext('2d');
    this.frame = makeCanvas(W * scale, H * scale);  // last composed frame
    this.fctx = this.frame.getContext('2d');
    this.work = makeCanvas(W * scale, H * scale);   // transition source / menu backdrop
    this.wctx = this.work.getContext('2d');
    this.spriteCache = new Map();
    this.text = null;
    this.reset();
  }

  reset() {
    this.bg = { color: '#000000', file: null, img: null };
    this.tachi = [null, null, null];
    this.sprites = new Map();
    this.monocro = null;
    this.nega = 0;
    this.baseValid = false;
    this.dirty = true;
  }

  touch() { this.baseValid = false; this.dirty = true; }

  // ---------------------------------------------------------------- sprites
  async loadSprite(tag) {
    let data = this.spriteCache.get(tag);
    if (!data) {
      const t = parseTag(tag);
      const keyed = t.trans !== 'c' && t.trans !== 'a';
      const raw = keyed ? await this.loader.pixels(t.file) : null;
      const img = raw ? null : await this.loader.image(t.file);
      if (!img && !raw) return null;
      data = this.buildSprite(img, t, raw);
      this.spriteCache.set(tag, data);
      if (this.spriteCache.size > 48) this.spriteCache.delete(this.spriteCache.keys().next().value);
    } else {
      this.spriteCache.delete(tag);
      this.spriteCache.set(tag, data);
    }
    return { tag, data, x: 0, y: 0, alpha: 255, visible: true, cell: 0 };
  }

  // `raw` is the file's exact pixels when the loader could decode them (colour-keyed bitmaps)
  buildSprite(img, t, raw) {
    const iw = raw ? raw.w : img.naturalWidth || img.width, ih = raw ? raw.h : img.naturalHeight || img.height;
    if (t.trans === 'c') {
      return { canvas: img, w: Math.floor(iw / t.cells), h: ih, cells: t.cells, delays: t.delays, loop: t.loop };
    }
    let d;
    if (raw) d = raw.data;
    else {
      const src = makeCanvas(iw, ih);
      const sctx = src.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(img, 0, 0);
      d = sctx.getImageData(0, 0, iw, ih).data;
    }
    let w = iw;
    if (t.trans === 'a') w = Math.floor(iw / 2);
    const out = makeCanvas(w, ih);
    const octx = out.getContext('2d');
    const op = octx.createImageData(w, ih);
    const o = op.data;
    if (t.trans === 'a') {
      // right half is the mask: white = transparent, black = opaque
      for (let y = 0; y < ih; y++) {
        let si = y * iw * 4, mi = (y * iw + w) * 4, di = y * w * 4;
        for (let x = 0; x < w; x++, si += 4, mi += 4, di += 4) {
          o[di] = d[si]; o[di + 1] = d[si + 1]; o[di + 2] = d[si + 2];
          o[di + 3] = 255 - d[mi + 2];
        }
      }
    } else {
      let kr, kg, kb;
      if (t.trans[0] === '#') {
        kr = parseInt(t.trans.slice(1, 3), 16); kg = parseInt(t.trans.slice(3, 5), 16); kb = parseInt(t.trans.slice(5, 7), 16);
      } else {
        const k = t.trans === 'r' ? (iw - 1) * 4 : 0;
        kr = d[k]; kg = d[k + 1]; kb = d[k + 2];
      }
      for (let i = 0; i < d.length; i += 4) {
        o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2];
        o[i + 3] = d[i] === kr && d[i + 1] === kg && d[i + 2] === kb ? 0 : 255;
      }
    }
    octx.putImageData(op, 0, 0);
    return { canvas: out, w: Math.floor(w / t.cells), h: ih, cells: t.cells, delays: t.delays, loop: t.loop };
  }

  async loadPlain(file) {
    const t = parseTag(file);
    return this.loader.image(t.file);
  }

  drawSprite(ctx, sp, x, y, cell) {
    if (!sp || !sp.data) return;
    const d = sp.data;
    const a = sp.alpha / 255;
    if (a <= 0) return;
    ctx.globalAlpha = a;
    ctx.drawImage(d.canvas, (cell || 0) * d.w, 0, d.w, d.h, x, y, d.w, d.h);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- scene state
  setBgColor(color) {
    this.bg = { color, file: null, img: null };
    this.touch();
    if (this.onBgChange) this.onBgChange(false);
  }
  async setBgImage(file) {
    const t = parseTag(file);
    const before = this.bg.img;
    let img = await this.loader.image(t.file);
    if (img && this.bgOverride) img = this.bgOverride(t.file, img) || img;
    this.bg = { color: '#000000', file, img };
    this.touch();
    // true when the new background is the very stand-in already showing (one menu page to the next)
    const same = !!img && img === before && img.naturalWidth === undefined;
    if (this.onBgChange) this.onBgChange(same);
    return same;
  }
  async setTachi(idx, tag) {
    const sp = await this.loadSprite(tag);
    if (sp) {
      sp.x = Math.floor((W * (idx + 1)) / 4 - sp.data.w / 2);
      sp.y = H - sp.data.h;
    }
    this.tachi[idx] = sp;
    this.touch();
  }
  clearTachi(idx) {
    if (idx < 0) this.tachi = [null, null, null]; else this.tachi[idx] = null;
    this.touch();
  }
  async setSprite(no, tag, x, y, alpha, visible) {
    const sp = await this.loadSprite(tag);
    if (!sp) { this.sprites.delete(no); this.touch(); return; }
    sp.x = x; sp.y = y;
    sp.alpha = Math.max(0, Math.min(255, alpha));
    sp.visible = visible;
    sp.hidden = this.hideSprite ? this.hideSprite(parseTag(tag).file) : false;
    this.sprites.set(no, sp);
    this.touch();
  }
  clearSprite(no) {
    if (no < 0) this.sprites.clear(); else this.sprites.delete(no);
    this.touch();
  }
  showSprite(no, visible) {
    const sp = this.sprites.get(no);
    if (sp) { sp.visible = visible; this.touch(); }
  }
  moveSprite(no, x, y, a, absolute) {
    const sp = this.sprites.get(no);
    if (!sp) return;
    if (absolute) { sp.x = x; sp.y = y; if (a !== null) sp.alpha = a; }
    else { sp.x += x; sp.y += y; sp.alpha += a || 0; }
    sp.alpha = Math.max(0, Math.min(255, sp.alpha));
    this.touch();
  }
  setMonocro(color) {
    this.monocro = color;
    this.touch();
  }
  setNega(mode) {
    this.nega = mode;
    this.touch();
  }

  serialize() {
    return {
      bg: { color: this.bg.color, file: this.bg.file },
      tachi: this.tachi.map((t) => (t ? t.tag : null)),
      sprites: [...this.sprites].map(([no, s]) => [no, s.tag, s.x, s.y, s.alpha, s.visible]),
      monocro: this.monocro,
      nega: this.nega,
    };
  }
  async restore(st) {
    this.reset();
    if (st.bg.file) await this.setBgImage(st.bg.file); else this.setBgColor(st.bg.color);
    for (let i = 0; i < 3; i++) if (st.tachi[i]) await this.setTachi(i, st.tachi[i]);
    for (const [no, tag, x, y, alpha, visible] of st.sprites) await this.setSprite(no, tag, x, y, alpha, visible);
    this.monocro = st.monocro;
    this.nega = st.nega || 0;
    this.touch();
  }

  // ---------------------------------------------------------------- composition
  prep(ctx) {
    ctx.setTransform(this.S, 0, 0, this.S, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  composeBase() {
    const ctx = this.bctx;
    this.prep(ctx);
    ctx.fillStyle = this.bg.color || '#000000';
    ctx.fillRect(0, 0, W, H);
    if (this.bg.img) {
      const im = this.bg.img;
      if (im.naturalWidth === undefined) ctx.drawImage(im, 0, 0, W, H);      // a stand-in drawn for the whole screen
      else ctx.drawImage(im, Math.floor((W - im.naturalWidth) / 2), Math.floor((H - im.naturalHeight) / 2));
    }
    const nos = [...this.sprites.keys()].sort((a, b) => b - a);
    for (const no of nos) {
      if (no <= HUMAN_Z) break;
      const sp = this.sprites.get(no);
      if (sp.visible && !sp.hidden) this.drawSprite(ctx, sp, sp.x, sp.y, sp.cell);
    }
    for (let i = 0; i < 3; i++) {
      const t = this.tachi[i];
      if (t) this.drawSprite(ctx, t, t.x, t.y, 0);
    }
    for (const no of nos) {
      if (no > HUMAN_Z) continue;
      const sp = this.sprites.get(no);
      if (sp.visible && !sp.hidden) this.drawSprite(ctx, sp, sp.x, sp.y, sp.cell);
    }
    if (this.nega === 1) this.applyNega(ctx);
    if (this.monocro) {
      // luminance-preserving grey, then tint: out = grey * colour
      ctx.globalCompositeOperation = 'saturation';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = this.monocro;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.nega === 2) this.applyNega(ctx);
    this.baseValid = true;
  }
  applyNega(ctx) {
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  compose(ctx, withText) {
    if (!this.baseValid) this.composeBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.base, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (withText && this.text) {
      this.prep(ctx);
      this.text.drawShade(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.text.canvas, 0, 0);
    }
  }

  blit() {
    const c = this.sctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'copy';
    c.drawImage(this.frame, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (this.onBlit) this.onBlit(this.frame);
  }

  // a small picture of the scene as last shown, for a save slot
  thumbnail(w = 220, h = 165) {
    try {
      const c = makeCanvas(w, h);
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(this.frame, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }

  present(withText) {
    this.compose(this.fctx, withText);
    this.blit();
    this.dirty = false;
  }

  // draw `fn` on top of the last presented frame (cursors, button highlights)
  overlay(fn) {
    this.blit();
    this.prep(this.sctx);
    fn(this.sctx);
  }

  // copy the current frame, without text, into the work canvas (menu backdrop)
  backdrop(shade) {
    this.compose(this.wctx, false);
    if (shade) {
      this.prep(this.wctx);
      this.wctx.globalCompositeOperation = 'multiply';
      this.wctx.fillStyle = shade;
      this.wctx.fillRect(0, 0, W, H);
      this.wctx.globalCompositeOperation = 'source-over';
    }
  }
  drawBackdrop(fn) {
    const c = this.sctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'copy';
    c.drawImage(this.work, 0, 0);
    this.prep(c);
    if (fn) fn(c);
  }

  blt(img, a) {
    const [dx, dy, dw, dh, sx, sy, sw, sh] = a;
    this.prep(this.sctx);
    this.sctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  grabScreen() {
    const c = makeCanvas(W, H);
    c.getContext('2d').drawImage(this.screen, 0, 0, W, H);
    return c;
  }

  // ---------------------------------------------------------------- transitions
  animate(dur, draw, isSkipping) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const t = (now - t0) / dur;
        if (t >= 1 || (isSkipping && isSkipping())) { resolve(); return; }
        draw(Math.max(0, t));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async transition(eff, withText, isSkipping) {
    if (eff.type === 0) return;
    // source = what is on screen now, destination = the newly composed frame
    const w = this.wctx;
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.globalAlpha = 1;
    w.globalCompositeOperation = 'copy';
    w.drawImage(this.screen, 0, 0);
    w.globalCompositeOperation = 'source-over';
    this.compose(this.fctx, withText);
    this.dirty = false;
    if (eff.type !== 1 && eff.dur > 0 && !(isSkipping && isSkipping()) && !document.hidden) {
      await this.animate(eff.dur, (t) => this.drawEffect(eff.type, t), isSkipping);
    }
    this.blit();
  }

  // part of the destination frame, in logical coordinates
  part(x, y, w, h, dx = x, dy = y) {
    if (w <= 0 || h <= 0) return;
    const S = this.S;
    this.sctx.drawImage(this.frame, x * S, y * S, w * S, h * S, dx, dy, w, h);
  }
  whole(img, dx, dy) {
    this.sctx.drawImage(img, 0, 0, W * this.S, H * this.S, dx, dy, W, H);
  }

  drawEffect(type, t) {
    const c = this.sctx;
    const S = this.S;
    this.prep(c);
    const snap = (v) => Math.round(v * S) / S;
    switch (type) {
      case 2: { // left shutter
        const w = snap(16 * t);
        for (let i = 0; i < W / 16; i++) this.part(i * 16, 0, w, H);
        break;
      }
      case 3: { // right shutter
        const w = snap(16 * t);
        for (let i = 0; i < W / 16; i++) this.part(i * 16 + 16 - w, 0, w, H);
        break;
      }
      case 4: { // up shutter
        const h = snap(16 * t);
        for (let i = 0; i < H / 16; i++) this.part(0, i * 16, W, h);
        break;
      }
      case 5: { // down shutter
        const h = snap(16 * t);
        for (let i = 0; i < H / 16; i++) this.part(0, i * 16 + 16 - h, W, h);
        break;
      }
      case 6: case 7: { // left / right curtain
        const w = 48 * t;
        for (let i = 0; i <= W / 24; i++) {
          const w2 = snap(Math.min(24, w - (24 * 24 * i) / W));
          if (w2 <= 0) continue;
          if (type === 6) this.part(i * 24, 0, w2, H);
          else this.part(W - i * 24 - w2, 0, w2, H);
        }
        break;
      }
      case 8: case 9: { // up / down curtain
        const h = 48 * t;
        for (let i = 0; i <= H / 24; i++) {
          const h2 = snap(Math.min(24, h - (24 * 24 * i) / H));
          if (h2 <= 0) continue;
          if (type === 8) this.part(0, i * 24, W, h2);
          else this.part(0, H - i * 24 - h2, W, h2);
        }
        break;
      }
      case 11: { const w = snap(W * t); this.whole(this.work, w, 0); this.whole(this.frame, w - W, 0); break; }
      case 12: { const w = snap(W * t); this.whole(this.work, -w, 0); this.whole(this.frame, W - w, 0); break; }
      case 13: { const h = snap(H * t); this.whole(this.work, 0, h); this.whole(this.frame, 0, h - H); break; }
      case 14: { const h = snap(H * t); this.whole(this.work, 0, -h); this.whole(this.frame, 0, H - h); break; }
      default: { // 10 crossfade (also stands in for mask / mosaic effects)
        this.whole(this.work, 0, 0);
        c.globalAlpha = t;
        this.whole(this.frame, 0, 0);
        c.globalAlpha = 1;
      }
    }
  }

  async quake(kind, amp, dur, withText, isSkipping) {
    this.compose(this.fctx, withText);
    this.dirty = false;
    const c = this.sctx;
    await this.animate(dur, (t) => {
      let dx = 0, dy = 0;
      const v = Math.sin(Math.PI * 2 * amp * t) * QUAKE_AMP * amp * (1 - t);
      if (kind === 'quakex') dx = v;
      else if (kind === 'quakey') dy = v;
      else {
        dx = amp * (Math.floor(Math.random() * 3) - 1) * 2;
        dy = amp * (Math.floor(Math.random() * 3) - 1) * 2;
      }
      this.prep(c);
      c.fillStyle = '#000000';
      c.fillRect(0, 0, W, H);
      this.whole(this.frame, Math.round(dx), Math.round(dy));
    }, isSkipping);
    this.blit();
  }
}
