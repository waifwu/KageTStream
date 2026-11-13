// The interface around the game: the opening page, the quick bar, the system
// menu, save / load, the text history, settings and questions. It is HTML laid
// over the canvas inside the stage, so it scales with the picture.
//
// Every screen is a "layer"; openLayer() returns a promise for what was chosen,
// so the engine can simply await it from wherever it is waiting.

import { parseCond } from './flowchart-model.js';
import { t, when as whenJa } from './i18n.js';
import { titleX } from './skins.js';

// (several functions below have a `t` of their own: there the wording is asked of `tr`)
const tr = t;

// The stage: 1280 x 960, or 16:9 at the same height (Settings > Picture). Its pages are laid out
// for either by css/shell.css ("#stage.wide").
const SW = 1280, SH = 960, SW_WIDE = (SH * 16) / 9;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = t(text);
  return e;
};
const pad2 = (n) => String(n).padStart(2, '0');
// A page's title and tabs stand on one line with a count at its far end. Where the words are too
// long for that (another language's), the title and tabs are set smaller until they end before
// the count begins. The 90px before the title is the page's margin and stays as it is.
const fitHead = (head, count) => {
  head.style.removeProperty('--fit');
  const h = head.getBoundingClientRect(), c = count.getBoundingClientRect();
  if (!h.width || !c.width || !head.offsetWidth) return;
  const unit = h.width / head.offsetWidth;          // the stage is scaled as a whole
  const room = (c.left - h.left) / unit - 30, natural = head.offsetWidth, margin = 90;
  if (natural > room) head.style.setProperty('--fit', Math.max(0.55, (room - margin) / (natural - margin)).toFixed(3));
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (time) => {
  const ja = whenJa(time);
  if (ja) return ja;
  return whenEn(time);
};
const whenEn = (t) => {
  const d = new Date(t);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + '  ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

export class Shell {
  constructor() {
    this.stage = document.getElementById('stage');
    this.sheet = document.getElementById('sheet');
    this.home = document.getElementById('home');
    this.toastEl = document.getElementById('toast');
    this.ambient = document.getElementById('ambient');
    this.input = null;
    this.everything = false;      // "Unlock everything" is on (main.js sets it): the pages' counts say so
    // A choice of the story, in the words of the script that is running (main.js sets these when
    // that is not the script the flowchart and the walkthrough were read from).
    this.word = (s) => s;         // a choice exactly as the reference script writes it
    this.stepWord = (s) => s;     // a choice as the walkthrough words it
    this.layers = [];
    this.leaving = [];
    this.homeOpen = false;
    this.wide = false;
    this.SW = SW;
    this.scale = 1;
    this.toastTimer = null;
    this.lastAmbient = 0;
    this.makeGrain();
    this.fit();
    window.addEventListener('resize', () => this.fit());
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    this.wireQuickBar();
  }

  // The paper's grain: a small tile of soft noise, made once. (An SVG turbulence filter gives the
  // same look but is rendered afresh for every page that uses it, which stalls each page's arrival.)
  makeGrain() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      const x = c.getContext('2d');
      const id = x.createImageData(192, 192);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random();
        d[i] = 120 + v * 26; d[i + 1] = 106 + v * 22; d[i + 2] = 122 + v * 26;
        d[i + 3] = Math.random() * 30;
      }
      x.putImageData(id, 0, 0);
      document.documentElement.style.setProperty('--grain', 'url(' + c.toDataURL('image/png') + ')');
    } catch (e) { /* no grain */ }
  }

  fit() {
    const s = Math.min(window.innerWidth / this.SW, window.innerHeight / SH);
    this.scale = s;
    const x = Math.round((window.innerWidth - this.SW * s) / 2), y = Math.round((window.innerHeight - SH * s) / 2);
    this.stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }
  // the stage at 16:9, or back at the game's own 4:3
  setWide(on) {
    this.wide = !!on;
    this.SW = this.wide ? SW_WIDE : SW;
    this.stage.classList.toggle('wide', this.wide);
    this.fit();
  }

  // ---------------------------------------------------------------- ambient backdrop
  // The glow shows what is on screen: the picture as displayed, or, while a page of the
  // interface is open, that page's paper or veil. It eases towards it rather than jumping, so
  // a text window opening or the black between two pictures does not make it blink.
  setAmbient(on) {
    this.ambientOn = !!on;
    this.ambient.classList.toggle('on', this.ambientOn);
    clearInterval(this.ambientTimer);
    if (!this.ambientOn) return;
    const ctx = this.ambient.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = 64;
    tmp.height = 48;
    const t = tmp.getContext('2d', { willReadFrequently: true });
    let primed = false, seen = '', still = 0;
    this.ambientTimer = setInterval(() => {
      // nothing of the glow shows while the stage covers the window: it is left as it was
      if (this.SW * this.scale >= window.innerWidth - 1 && SH * this.scale >= window.innerHeight - 1) return;
      if (document.hidden || !this.paintAmbient(t)) return;
      // Once the glow has caught up with a picture that is not changing it is left alone: every
      // touch of the canvas has the whole window's blur worked out again, ten times a second.
      let sig = '';
      try {
        const d = t.getImageData(0, 0, 64, 48).data;
        let a = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { a = (a * 31 + d[i] + d[i + 1] * 3) % 1000003; b = (b * 17 + d[i + 2]) % 1000003; }
        sig = a + ':' + b;
      } catch (e) { /* the sketch cannot be read: the glow is simply kept up as before */ }
      if (sig && sig === seen) { if (++still > 45) return; } else { still = 0; seen = sig; }
      ctx.globalAlpha = primed ? 0.13 : 1;
      ctx.drawImage(tmp, 0, 0);
      primed = true;
    }, 100);
  }
  // a 64 x 48 sketch of what the stage is showing; false when there is nothing to go by yet
  paintAmbient(t) {
    const src = this.ambientSource && this.ambientSource();
    const scene = () => {
      t.globalAlpha = 1;
      t.fillStyle = '#000';
      t.fillRect(0, 0, 64, 48);
      if (!src) return false;
      try { t.drawImage(src, 0, 0, 64, 48); } catch (e) { return false; }
      return true;
    };
    const paper = (x, y, w, h) => {
      t.fillStyle = '#efe9e9';
      t.fillRect(x, y, w, h);
      const wash = (cx, cy, r, col) => {
        const g = t.createRadialGradient(x + w * cx, y + h * cy, 0, x + w * cx, y + h * cy, w * r);
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(239,233,233,0)');
        t.fillStyle = g;
        t.fillRect(x, y, w, h);
      };
      wash(0.86, 0.18, 0.5, 'rgba(228,176,176,.75)');
      wash(0.08, 0.72, 0.5, 'rgba(228,182,178,.65)');
      wash(0.44, 0.3, 0.4, 'rgba(204,205,230,.75)');
      wash(0.7, 0.88, 0.45, 'rgba(214,208,232,.7)');
    };
    const top = this.layers[this.layers.length - 1];
    if (top) {
      const c = top.layer.classList;
      if (c.contains('paper')) { paper(0, 0, 64, 48); return true; }
      if (c.contains('clear')) return scene();
      if (c.contains('viewer')) {
        const im = top.layer.querySelector('img');
        t.fillStyle = '#000';
        t.fillRect(0, 0, 64, 48);
        try { if (im && im.complete && im.naturalWidth) t.drawImage(im, 0, 0, 64, 48); } catch (e) { /* not ready */ }
        return true;
      }
      scene();
      if (c.contains('veil')) {
        const g = t.createLinearGradient(0, 0, 20, 48);
        g.addColorStop(0, 'rgba(34,24,56,.84)');
        g.addColorStop(0.46, 'rgba(72,44,76,.72)');
        g.addColorStop(1, 'rgba(120,72,30,.58)');
        t.fillStyle = g;
        t.fillRect(0, 0, 64, 48);
      } else {
        t.fillStyle = 'rgba(22,14,34,.55)';
        t.fillRect(0, 0, 64, 48);
        paper(18, 17, 28, 13);
      }
      return true;
    }
    if (this.homeOpen) {
      if (!scene()) return false;
      const g = t.createLinearGradient(0, 0, 0, 48);
      g.addColorStop(0, 'rgba(28,18,44,.7)');
      g.addColorStop(0.46, 'rgba(28,18,44,0)');
      g.addColorStop(1, 'rgba(14,8,4,.88)');
      t.fillStyle = g;
      t.fillRect(0, 0, 64, 48);
      if (this.home.classList.contains('tabbed')) paper(7.5, 8.3, 49, 35.9);
      return true;
    }
    return scene();
  }

  // ---------------------------------------------------------------- story furniture
  // 'text' while the story waits for the reader, 'busy' otherwise (the game's own
  // button screens use the whole picture, so the quick bar stays out of their way).
  setContext(ctx) {
    this.stage.classList.toggle('ctx-text', ctx === 'text');
    this.stage.classList.toggle('ctx-busy', ctx !== 'text');
    if (ctx !== 'text') this.stage.classList.remove('qb');
  }
  setModes(m) {
    document.getElementById('mode-skip').classList.toggle('on', !!m.skip);
    document.getElementById('mode-auto').classList.toggle('on', !!m.auto);
    for (const p of document.querySelectorAll('#quickbar .plate')) {
      const a = p.dataset.act;
      if (a === 'skip') p.classList.toggle('on', !!m.skip);
      if (a === 'auto') p.classList.toggle('on', !!m.auto);
    }
  }
  wireQuickBar() {
    const stage = this.stage;
    let pinned = false, hideTimer = null;
    const show = (on) => {
      clearTimeout(hideTimer);
      if (on) stage.classList.add('qb');
      else if (!pinned) hideTimer = setTimeout(() => stage.classList.remove('qb'), 350);
    };
    stage.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const r = stage.getBoundingClientRect();
      show((e.clientY - r.top) / this.scale < 96);
    });
    stage.addEventListener('pointerleave', () => show(false));
    document.getElementById('qb-handle').addEventListener('click', () => {
      pinned = !stage.classList.contains('qb') || !pinned;
      stage.classList.toggle('qb', pinned);
    });
  }
  onAction(fn) {
    for (const p of document.querySelectorAll('#quickbar .plate')) {
      p.addEventListener('click', () => { fn(p.dataset.act); p.blur(); });
    }
    document.getElementById('mode-skip').addEventListener('click', () => fn('skip'));
    document.getElementById('mode-auto').addEventListener('click', () => fn('auto'));
  }
  toast(msg) {
    const t = this.toastEl;
    t.textContent = tr(msg);
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
  }
  curtain(on) { document.getElementById('curtain').classList.toggle('on', on); }

  // ---------------------------------------------------------------- layers
  syncModal() {
    const m = this.layers.length > 0 || this.homeOpen;
    this.stage.classList.toggle('modal', m);
    if (this.input) {
      this.input.modal = m;
      if (!m) this.input.flush();
    }
  }

  openLayer(cls, build) {
    return new Promise((resolve) => {
      const layer = el('div', 'layer ' + cls);
      const ctl = {
        layer, items: [], cur: -1, onCur: null, onKey: null, closed: false,
        // A page that has answered does not leave at once: if another page follows straight away
        // (menu to settings, gallery to pictures) it stays until that one is in, so the picture
        // underneath never shows between them. If nothing follows, it fades out.
        done: (v) => {
          if (ctl.closed) return;
          ctl.closed = true;
          this.layers.splice(this.layers.indexOf(ctl), 1);
          layer.style.pointerEvents = 'none';
          this.leaving.push(ctl);
          ctl.leaveTimer = setTimeout(() => this.fadeOut(ctl), 90);
          this.syncModal();
          resolve(v);
        },
        setCur: (i) => {
          if (ctl.cur === i) return;
          if (ctl.items[ctl.cur]) ctl.items[ctl.cur].classList.remove('cur');
          ctl.cur = i;
          if (ctl.items[i]) ctl.items[i].classList.add('cur');
          if (ctl.onCur) ctl.onCur(i);
        },
        // a thing that can be pointed at, moved to with the arrow keys, and chosen
        nav: (button, pick) => {
          const idx = ctl.items.length;
          ctl.items.push(button);
          button.addEventListener('pointerenter', () => { if (!button.disabled) ctl.setCur(idx); });
          button.addEventListener('click', (e) => { e.stopPropagation(); if (!button.disabled) pick(); });
          return button;
        },
        move: (d) => {
          const n = ctl.items.length;
          let k = ctl.cur;
          for (let i = 0; i < n; i++) {
            k = k < 0 ? (d > 0 ? 0 : n - 1) : (k + d + n) % n;
            if (!ctl.items[k].disabled) { ctl.setCur(k); return; }
          }
        },
      };
      layer.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!ctl.sticky) ctl.done(null); });
      build(layer, ctl);
      // pages on their way out: under a page that covers the stage they wait until it is in;
      // under one that lets the picture through they fade as it arrives
      const covers = layer.classList.contains('paper') || layer.classList.contains('viewer');
      const held = [];
      for (const old of this.leaving.splice(0)) {
        clearTimeout(old.leaveTimer);
        if (covers) held.push(old); else this.fadeOut(old);
      }
      if (held.length) {
        // let go of them only once this page has really finished arriving (not after a set time:
        // a busy browser can start the fade late), with a long stop in case the event never comes
        let released = false;
        const release = (e) => {
          if (released || (e && (e.target !== layer || e.propertyName !== 'opacity'))) return;
          released = true;
          layer.removeEventListener('transitionend', release);
          for (const old of held) old.layer.remove();
        };
        layer.addEventListener('transitionend', release);
        setTimeout(() => release(null), 2500);
      }
      this.sheet.appendChild(layer);
      this.layers.push(ctl);
      this.syncModal();
      if (ctl.ready) ctl.ready();
      void layer.offsetWidth;          // so the fade starts from 0 even when no frame is drawn in between
      layer.classList.add('in');
    });
  }

  // Keep the pages that have just answered where they are, for the script to bring up the next
  // one (it hands over as usual when that opens); releaseLeaving lets them go when what follows
  // is not a page after all.
  holdLeaving(ms = 1500) {
    for (const c of this.leaving) {
      clearTimeout(c.leaveTimer);
      c.leaveTimer = setTimeout(() => this.fadeOut(c), ms);
    }
  }
  releaseLeaving() {
    for (const c of this.leaving.slice()) {
      clearTimeout(c.leaveTimer);
      this.fadeOut(c);
    }
  }

  fadeOut(ctl) {
    const i = this.leaving.indexOf(ctl);
    if (i >= 0) this.leaving.splice(i, 1);
    ctl.layer.classList.remove('in');
    setTimeout(() => ctl.layer.remove(), 240);
  }

  back(layer, ctl, label = 'Back') {
    const b = el('button', 'back', label);
    ctl.nav(b, () => ctl.done(null));
    layer.appendChild(b);
    return b;
  }

  onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.homeOpen && !this.layers.length) { if (this.homeKey(e)) { e.preventDefault(); e.stopPropagation(); } return; }
    const ctl = this.layers[this.layers.length - 1];
    if (!ctl) return;
    e.stopPropagation();
    if (ctl.onKey && ctl.onKey(e)) { e.preventDefault(); return; }
    if (e.target && e.target.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    switch (e.key) {
      case 'Escape': case 'Backspace': if (!ctl.sticky) ctl.done(null); break;
      case 'ArrowUp': case 'ArrowLeft': ctl.move(-1); break;
      case 'ArrowDown': case 'ArrowRight': case 'Tab': ctl.move(1); break;
      case 'Enter': case ' ': if (ctl.items[ctl.cur]) ctl.items[ctl.cur].click(); break;
      default: return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- system menu
  // items: [{ label, value }]; info: { title, track }
  menu(items, info) {
    return this.openLayer('veil sysmenu', (layer, ctl) => {
      layer.appendChild(el('div', 'sm-head', info.title || ''));
      const rule = el('div', 'rulecursor');
      layer.appendChild(rule);
      const list = el('div', 'sm-list');
      for (const it of items) list.appendChild(ctl.nav(el('button', 'sm-item', it.label), () => ctl.done(it.value)));
      layer.appendChild(list);
      const side = el('div', 'sm-side');
      if (info.track) {
        side.appendChild(el('div', 'lbl', 'Now playing'));
        side.appendChild(el('div', 'big', info.track));
      }
      side.appendChild(el('div', null, 'Right-click or Esc returns to the story'));
      layer.appendChild(side);
      const back = this.back(layer, ctl);
      // the rule runs in from the edge of the screen and stops under the item pointed at
      ctl.onCur = (i) => {
        const b = ctl.items[i];
        if (!b || b === back) { rule.style.opacity = 0; return; }
        rule.style.opacity = 1;
        rule.style.top = list.offsetTop + b.offsetTop + b.offsetHeight - 9 + 'px';
        rule.style.width = list.offsetLeft + b.offsetWidth + 34 + 'px';
      };
      ctl.ready = () => ctl.setCur(0);
      layer.addEventListener('click', (e) => { if (e.target === layer) ctl.done(null); });
    });
  }

  // ---------------------------------------------------------------- questions
  ask(question, detail, options = [['Yes', true], ['No', false]], initial = 1) {
    return this.openLayer('ask', (layer, ctl) => {
      const box = el('div', 'dialog paper');
      const q = el('div', 'q', question);
      if (detail) q.appendChild(el('small', null, detail));
      box.appendChild(q);
      const opts = el('div', 'opts');
      for (const [label, value] of options) opts.appendChild(ctl.nav(el('button', 'opt', label), () => ctl.done(value)));
      box.appendChild(opts);
      layer.appendChild(box);
      ctl.ready = () => ctl.setCur(Math.min(initial, options.length - 1));
    });
  }
  async confirm(question, detail) { return (await this.ask(question, detail)) === true; }
  notice(message, detail) { return this.ask(message, detail, [['OK', true]], 0); }

  // ---------------------------------------------------------------- save / load
  // slots: [{ no, info: { time, thumb, excerpt } | null, disabled }]
  saves(title, note, slots) {
    return this.openLayer('paper saves', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', title));
      layer.appendChild(el('div', 'page-note', note));
      const grid = el('div', 'grid');
      const excerpt = el('div', 'excerpt');
      for (const s of slots) {
        const b = el('button', 'slot' + (s.info ? '' : ' empty'));
        const thumb = el('div', 'thumb');
        if (s.info && s.info.thumb) thumb.style.backgroundImage = 'url(' + s.info.thumb + ')';
        b.appendChild(thumb);
        const cap = el('div', 'cap');
        cap.appendChild(el('span', 'no', 'No. ' + pad2(s.no)));
        cap.appendChild(el('span', 'when', s.info ? when(s.info.time) : ''));
        b.appendChild(cap);
        b.disabled = !!s.disabled;
        grid.appendChild(ctl.nav(b, () => ctl.done(s.no)));
      }
      layer.appendChild(grid);
      layer.appendChild(excerpt);
      const back = this.back(layer, ctl);
      ctl.onCur = (i) => {
        const s = slots[i];
        excerpt.textContent = s && s.info && s.info.excerpt ? s.info.excerpt : '';
      };
      // arrow keys walk the grid, five to a row
      ctl.onKey = (e) => {
        const n = slots.length;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[e.key];
        if (!step) return false;
        let k = ctl.cur < 0 || ctl.items[ctl.cur] === back ? (step > 0 ? -step : n) : ctl.cur;
        for (let i = 0; i < n; i++) {
          k += step;
          if (k < 0 || k >= n) { if (Math.abs(step) === 5 && k >= n) ctl.setCur(ctl.items.indexOf(back)); return true; }
          if (!ctl.items[k].disabled) { ctl.setCur(k); return true; }
        }
        return true;
      };
      ctl.ready = () => {
        const first = slots.findIndex((s) => !s.disabled && (title.toLowerCase().includes('load') ? s.info : !s.info));
        ctl.setCur(first >= 0 ? first : ctl.items.indexOf(back));
      };
    });
  }

  // ---------------------------------------------------------------- text history
  // pages: [{ lines: [string], now: bool }], oldest first
  log(pages, color) {
    return this.openLayer('veil log', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', 'Text history'));
      layer.appendChild(el('div', 'page-note', 'Scroll past the end to return'));
      const scroll = el('div', 'log-scroll');
      scroll.style.color = color || '';
      for (const p of pages) scroll.appendChild(el('div', 'log-page' + (p.now ? ' now' : ''), p.lines.join('\n')));
      layer.appendChild(scroll);
      this.back(layer, ctl);
      const atEnd = () => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
      let overshoot = 0;
      scroll.addEventListener('wheel', (e) => {
        if (e.deltaY > 0 && atEnd()) { if (++overshoot >= 2) ctl.done(null); } else overshoot = 0;
      }, { passive: true });
      ctl.onKey = (e) => {
        const page = scroll.clientHeight * 0.85;
        const by = { ArrowUp: -90, ArrowDown: 90, PageUp: -page, PageDown: page, k: -90, j: 90 }[e.key];
        if (by === undefined) return false;
        if (by > 0 && atEnd()) { ctl.done(null); return true; }
        scroll.scrollBy({ top: by });
        return true;
      };
      ctl.ready = () => {
        const last = scroll.lastElementChild;
        // open on the newest finished page, with the page being read just below it
        const target = pages.length && pages[pages.length - 1].now && last.previousElementSibling ? last.previousElementSibling : last;
        scroll.scrollTop = target ? Math.max(0, target.offsetTop + target.offsetHeight - scroll.clientHeight) : 0;
      };
    });
  }

  // ---------------------------------------------------------------- the game's own menus
  // The title: its entries along the foot of the picture, where the game has them.
  // items: [{ no, label, cx }] (cx of 640); secret: { no, x, y, w, h } of 640 x 480. Resolves to a button number.
  gameTitle({ items, secret, note }) {
    return this.openLayer('clear gtitle', (layer, ctl) => {
      ctl.sticky = true;
      const rule = el('div', 'rulecursor');
      layer.appendChild(rule);
      // At 16:9 the picture is a wider one made from the game's (skins.js): its entries stand
      // across the whole of it, and the line of capitals along its top, which could not be made
      // wider with the rest, is set here.
      const wide = this.wide;
      if (wide) {
        const brand = el('div', 'gt-brand');
        for (const ch of 'TSUKIHIME FUN DISC') brand.appendChild(el('span', null, ch));
        layer.appendChild(brand);
      }
      for (const it of items) {
        const b = ctl.nav(el('button', 'gt-item', it.label), () => ctl.done(it.action || it.no));
        b.style.left = (wide ? (it.cx / 640) * this.SW : it.cx * 2) + 'px';
        layer.appendChild(b);
      }
      if (note) layer.appendChild(el('div', 'gt-note', note));
      if (secret) {
        const b = el('button', 'gt-secret');
        const left = wide ? titleX(secret.x, 854) * this.SW : secret.x * 2;
        b.style.cssText = 'left:' + left + 'px;top:' + secret.y * 2 + 'px;width:' + secret.w * 2 + 'px;height:' + secret.h * 2 + 'px';
        b.tabIndex = -1;
        b.addEventListener('click', () => ctl.done(secret.no));
        layer.appendChild(b);
      }
      ctl.onCur = (i) => {
        const b = ctl.items[i];
        if (!b) { rule.style.opacity = 0; return; }
        rule.style.opacity = 1;
        rule.style.top = b.offsetTop + b.offsetHeight - 2 + 'px';
        rule.style.width = b.offsetLeft + b.offsetWidth / 2 + 26 + 'px';
      };
      layer.addEventListener('pointerleave', () => ctl.setCur(-1));
    });
  }

  // A page of the game's menus: a title, its entries, "back". items: [{ no, label }], aside: { no, label }.
  // Resolves to a button number, or null for back.
  gamePage({ title, items, aside }) {
    return this.openLayer('paper gpage', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', title));
      const rule = el('div', 'rulecursor ink');
      layer.appendChild(rule);
      const list = el('div', 'gp-list' + (items.length > 7 ? ' long' : ''));
      for (const it of items) {
        const two = tr(it.label).includes('\n') ? ' two' : '';         // a name set on two lines
        const b = ctl.nav(el('button', 'gp-item' + (it.guide ? ' guided' : '') + two, it.label), () => ctl.done(it.no));
        if (it.guide) { b.title = tr('The guide begins the day here'); b.appendChild(el('span', 'moon')); }
        list.appendChild(b);
      }
      layer.appendChild(list);
      let asideBtn = null;
      if (aside) {
        asideBtn = ctl.nav(el('button', 'gp-aside', aside.label), () => ctl.done(aside.no));
        layer.appendChild(asideBtn);
      }
      const back = this.back(layer, ctl);
      ctl.onCur = (i) => {
        const b = ctl.items[i];
        if (!b || b === back || b === asideBtn) { rule.style.opacity = 0; return; }
        rule.style.opacity = 1;
        rule.style.top = list.offsetTop + b.offsetTop + b.offsetHeight - 8 + 'px';
        rule.style.width = list.offsetLeft + b.offsetWidth + 34 + 'px';
      };
      ctl.ready = () => ctl.setCur(Math.max(0, items.findIndex((it) => it.guide)));
    });
  }

  // ---------------------------------------------------------------- the guide
  // guide: a Guide (guide.js). The page says where the guide has got to, in plain words: the
  // walkthrough is a numbered list of play-throughs of the day ("Day 1", "Day 2", ...), to be
  // played in order; one of them is next, the ones before it are done.
  guidePage(guide) {
    return this.openLayer('paper guide', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', 'Guide'));
      const note = el('div', 'page-note');
      layer.appendChild(note);
      const left = el('div', 'gd-left');
      const right = el('div', 'gd-right');
      layer.appendChild(left);
      layer.appendChild(right);
      const backBtn = this.back(layer, ctl);
      let shown = null;
      const cap = (t) => t[0].toUpperCase() + t.slice(1);

      const render = () => {
        const days = guide.days;
        const total = days.length;
        const at = Math.min(guide.state.day, total + 1);          // the place in the list of the day that is next
        const finished = at > total;
        if (shown === null || shown > total) shown = Math.min(at, total);
        const next = finished ? null : days[at - 1];
        ctl.items.length = 0;
        ctl.cur = -1;
        note.textContent = tr(at - 1 + ' of ' + total + ' done');
        left.innerHTML = '';
        right.innerHTML = '';

        const row = (label, options, current, pick) => {
          const r = el('div', 'cf-row');
          r.appendChild(el('div', 'cf-label', label));
          const opts = el('div', 'cf-opts');
          for (const [name, value] of options) {
            const b = ctl.nav(el('button', 'cf-opt' + (value === current ? ' sel' : ''), name), () => { pick(value); render(); });
            opts.appendChild(b);
          }
          r.appendChild(opts);
          left.appendChild(r);
        };
        row('Mark the choices to take', [['On', true], ['Off', false]], guide.state.on, (v) => guide.setOn(v));
        const names = Object.keys(guide.endings);
        if (names.length > 1) row('Ending to head for', names.map((n) => [cap(n), n]), guide.state.ending || names[0], (v) => guide.setEnding(v));

        // where it has got to
        const status = el('div', 'gd-status');
        status.appendChild(el('div', 'gd-sub', finished ? 'Finished' : 'Next up'));
        status.appendChild(el('div', 'gd-next', finished ? 'All ' + total + ' done' : 'Day ' + next.n));
        const bar = el('div', 'gd-bar');
        const fill = el('div', 'gd-fill');
        fill.style.width = Math.round(((at - 1) / total) * 100) + '%';
        bar.appendChild(fill);
        status.appendChild(bar);
        status.appendChild(el('p', 'gd-line', finished
          ? 'Every day of the walkthrough has been played the guide’s way.'
          : guide.state.on
            ? 'Start “' + cap(next.entry) + '” on the story’s page, and the choices listed for Day ' + next.n + ' are marked as you reach them.'
            : 'The guide is off, so nothing is marked. Turn it on above to have Day ' + next.n + '’s choices marked.'));
        left.appendChild(status);

        // every day, as a strip to look through
        const grid = el('div', 'gd-days');
        days.forEach((d, i) => {
          const state = i + 1 < at ? 'done' : i + 1 === at ? 'next' : 'later';
          const b = el('button', 'gd-day ' + state + (i + 1 === shown ? ' shown' : ''), String(d.n));
          b.title = tr(state === 'done' ? 'Day ' + d.n + ': done' : state === 'next' ? 'Day ' + d.n + ': next up' : 'Day ' + d.n + ': still to come');
          ctl.nav(b, () => { shown = i + 1; render(); });
          grid.appendChild(b);
        });
        left.appendChild(grid);
        const key = el('div', 'gd-key');
        for (const [cls, label] of [['done', 'Done'], ['next', 'Next up'], ['later', 'Still to come'], ['shown', 'Shown on the right']]) {
          const k = el('span', 'gd-keyitem');
          k.appendChild(el('span', 'gd-day mini ' + cls));
          k.append(tr(label));
          key.appendChild(k);
        }
        left.appendChild(key);

        const how = el('div', 'gd-how');
        how.appendChild(el('div', 'gd-sub', 'How it works'));
        for (const line of [
          'The walkthrough is ' + total + ' play-throughs of the story’s day, meant to be played in order. It calls each one a Day.',
          'Finish one having taken every marked choice, and the next Day becomes next up.',
          'Take any other choice and the marks stop for that play-through; the same Day stays next up.',
        ]) how.appendChild(el('p', null, line));
        left.appendChild(how);

        // the day being looked at
        const d = days[shown - 1];
        const isNext = shown === at, isDone = shown < at;
        right.appendChild(el('div', 'gd-sub', isDone ? 'Done' : isNext ? 'Next up' : 'Still to come'));
        right.appendChild(el('h2', 'gd-title', 'Day ' + d.n));
        right.appendChild(el('div', 'gd-entry', 'Begins with “' + cap(d.entry) + '” on the story’s page.'));
        if (d.steps.length) {
          right.appendChild(el('div', 'gd-sub steps', 'Choices to take, in order'));
          const ol = el('ol', 'gd-steps');
          for (const st of d.steps) ol.appendChild(el('li', null, this.stepWord(st.text)));
          right.appendChild(ol);
        } else right.appendChild(el('div', 'gd-entry', 'No choices are made in this one.'));
        if (d.quiz === 'miss') right.appendChild(el('div', 'gd-note', 'There is a quiz in this one, and the walkthrough has you miss a question on purpose, so nothing is marked in it.'));
        else if (Array.isArray(d.quiz)) right.appendChild(el('div', 'gd-note', 'There is a quiz in this one. Its questions come from one of ' + d.quiz.length + ' sets; the right answer is marked in each.'));
        for (const n of d.notes) right.appendChild(el('div', 'gd-note', cap(n.toLowerCase().replace(/^unlock:\s*/, 'unlocks ').replace(/ten nights of dream:\s*/, 'the dream ')) + '.'));
        if (!isNext) {
          const box = el('div', 'gd-move');
          const b = el('button', 'hm-link', 'Make Day ' + d.n + ' next up');
          ctl.nav(b, () => { guide.setDay(shown); render(); });
          box.appendChild(b);
          box.appendChild(el('p', 'gd-entry', isDone
            ? 'To play it again with its choices marked. The days after it count as not done.'
            : 'If your save is already further along than the guide thinks. The days before it count as done.'));
          right.appendChild(box);
        }
        ctl.items.push(backBtn);
      };
      ctl.ready = render;
    });
  }

  // ---------------------------------------------------------------- gallery: pictures
  // cats: [{ label, items: [{ url, title, artist, unlocked }] }]
  cgGallery(cats) {
    return this.openLayer('paper flow cgpage', (layer, ctl) => {
      const head = el('div', 'fc-head');
      head.appendChild(el('h1', 'page-title', 'Graphics mode'));
      const tabBar = el('div', 'fc-tabs');
      head.appendChild(tabBar);
      layer.appendChild(head);
      const count = el('div', 'fc-count');
      layer.appendChild(count);
      const scroll = el('div', 'cg-scroll');
      layer.appendChild(scroll);
      const backBtn = this.back(layer, ctl);
      let current = 0;
      let watcher = null;
      const closeLayer = ctl.done;
      ctl.done = (v) => { if (watcher) watcher.disconnect(); closeLayer(v); };
      const tabs = cats.map((c, i) => {
        const b = el('button', 'fc-tab', c.label);
        b.addEventListener('click', () => show(i));
        tabBar.appendChild(b);
        return b;
      });
      const show = (index) => {
        current = index;
        const cat = cats[index];
        tabs.forEach((b, k) => b.classList.toggle('on', k === index));
        const open = cat.items.filter((it) => it.unlocked);
        count.textContent = tr(this.everything ? 'All ' + cat.items.length + ' unlocked' : open.length + ' of ' + cat.items.length + ' seen');
        fitHead(head, count);
        requestAnimationFrame(() => fitHead(head, count));
        scroll.innerHTML = '';
        scroll.scrollTop = 0;
        ctl.items.length = 0;
        ctl.cur = -1;
        const grid = el('div', 'cg-grid');
        // A card rises into place when it comes into view (also the row that only just shows at
        // the foot, and the ones scrolled to later), a little after the one before it; its
        // picture fades in once it has arrived, so nothing pops in after the movement is over.
        if (watcher) watcher.disconnect();
        watcher = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
          const coming = entries.filter((en) => en.isIntersecting).map((en) => en.target)
            .sort((p, q) => (p.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          coming.forEach((card, k) => {
            watcher.unobserve(card);
            card.style.animationDelay = Math.min(k, 14) * 28 + 'ms';
            card.classList.remove('wait');
            card.classList.add('arrive');
          });
        }, { root: scroll, threshold: 0.01 });
        for (const it of cat.items) {
          const b = el('button', 'cg' + (it.unlocked ? '' : ' locked') + (watcher ? ' wait' : ' arrive'));
          if (it.unlocked) {
            const img = el('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = it.title || '';
            img.addEventListener('load', () => img.classList.add('on'));
            img.src = it.url;
            if (img.complete && img.naturalWidth) img.classList.add('on');
            b.appendChild(img);
            ctl.nav(b, async () => { await this.viewer(open, open.indexOf(it)); });
          } else b.disabled = true;
          grid.appendChild(b);
          if (watcher) watcher.observe(b);
        }
        scroll.appendChild(grid);
        ctl.items.push(backBtn);
      };
      ctl.onKey = (e) => {
        if (e.key === 'Tab') { show((current + 1) % cats.length); return true; }
        if (e.key === 'PageDown') { scroll.scrollBy({ top: 500 }); return true; }
        if (e.key === 'PageUp') { scroll.scrollBy({ top: -500 }); return true; }
        return false;
      };
      ctl.ready = () => show(0);
    });
  }

  // one picture at full size; click or the arrow keys go on to the next
  viewer(items, start) {
    return this.openLayer('viewer', (layer, ctl) => {
      // At 16:9 a picture of the game's shape leaves the sides bare. A soft, dark copy of it lies
      // there: painted once, small, into a canvas that is simply shown large. (A blur asked of the
      // style sheet is worked out again for every frame the page fades or the picture changes.)
      const back = this.wide ? document.createElement('canvas') : null;
      if (back) {
        back.className = 'vw-back';
        back.width = 96;
        back.height = 54;
        layer.appendChild(back);
      }
      const soften = (im) => {
        if (!back || !im.naturalWidth) return;
        const x = back.getContext('2d');
        const k = Math.max(back.width / im.naturalWidth, back.height / im.naturalHeight) * 1.12;
        const w = im.naturalWidth * k, hgt = im.naturalHeight * k;
        x.fillStyle = '#000';
        x.fillRect(0, 0, back.width, back.height);
        try { x.filter = 'blur(3px) saturate(1.15)'; } catch (e) { /* no canvas filters: it is small enough to be soft as it is */ }
        x.drawImage(im, (back.width - w) / 2, (back.height - hgt) / 2, w, hgt);
        x.filter = 'none';
        x.fillStyle = 'rgba(0,0,0,.5)';
        x.fillRect(0, 0, back.width, back.height);
        back.classList.add('on');
      };
      const img = el('img', 'vw-img');
      img.decoding = 'async';
      layer.appendChild(img);
      const cap = el('div', 'vw-cap');
      layer.appendChild(cap);
      const num = el('div', 'vw-num');
      layer.appendChild(num);
      let i = start;
      const show = () => {
        const it = items[i];
        img.classList.remove('on');
        const arrived = () => { if (items[i] !== it) return; img.classList.add('on'); soften(img); };
        img.onload = arrived;
        img.src = it.url;
        if (img.complete && img.naturalWidth) arrived();
        // the one that follows is fetched meanwhile, so going on to it does not wait
        if (items.length > 1) { const next = new Image(); next.decoding = 'async'; next.src = items[(i + 1) % items.length].url; }
        cap.innerHTML = '';
        if (it.title) cap.appendChild(el('div', 'vw-title', it.title));
        if (it.artist) cap.appendChild(el('div', 'vw-artist', it.artist));
        num.textContent = i + 1 + ' / ' + items.length;
      };
      const go = (d) => { i = (i + d + items.length) % items.length; show(); };
      layer.addEventListener('click', () => { if (i + 1 >= items.length) ctl.done(null); else go(1); });
      ctl.onKey = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') { if (i + 1 >= items.length) ctl.done(null); else go(1); return true; }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { go(-1); return true; }
        return false;
      };
      show();
    });
  }

  // ---------------------------------------------------------------- gallery: music
  // tracks: [{ no, title }]
  // api: play(no), toggle(), next(), prev(), seek(0..1), state() -> { no, paused, time, duration }, repeat (get / set)
  musicPlayer(tracks, api) {
    const icon = (d, size) => '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true"><path fill="currentColor" d="' + d + '"/></svg>';
    const ICON = {
      play: 'M8 5.2v13.6L19 12z',
      pause: 'M7 5h3.6v14H7zM13.4 5H17v14h-3.6z',
      prev: 'M6 5h2.4v14H6zM19 5.4v13.2L9.4 12z',
      next: 'M15.6 5H18v14h-2.4zM5 5.4v13.2L14.6 12z',
    };
    const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    return this.openLayer('paper music', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', 'Music player'));
      const open = tracks.filter((t) => !t.locked);
      layer.appendChild(el('div', 'page-note', this.everything ? 'All ' + tracks.length + ' unlocked' : open.length === tracks.length ? 'All ' + tracks.length + ' heard' : open.length + ' of ' + tracks.length + ' heard in the story'));
      const list = el('div', 'mp-list');
      const rows = [];
      for (const t of tracks) {
        const b = el('button', 'mp-row' + (t.locked ? ' locked' : ''));
        b.appendChild(el('span', 'moon'));
        b.appendChild(el('span', 'mp-no', String(t.no).padStart(2, '0')));
        b.appendChild(el('span', 'mp-title', t.locked ? '? ? ?' : t.title));
        if (t.locked) {
          // not met in the story yet: no name, and nothing to press
          b.disabled = true;
          b.title = tr('Not heard in the story yet');
        } else {
          ctl.nav(b, () => { if (api.state().no === t.no) api.toggle(); else api.play(t.no); paint(); });
          rows.push([b, t]);
        }
        list.appendChild(b);
      }
      layer.appendChild(list);

      // the player: previous, play / pause, next; the track and where it is; repeat
      const bar = el('div', 'mp-player');
      const mk = (cls, title, fn) => {
        const b = el('button', cls);
        b.title = title;
        ctl.nav(b, () => { fn(); paint(); });
        return b;
      };
      const prev = mk('mp-btn small', 'Previous track', () => api.prev());
      prev.innerHTML = icon(ICON.prev, 26);
      const play = mk('mp-btn', 'Play / pause', () => api.toggle());
      const next = mk('mp-btn small', 'Next track', () => api.next());
      next.innerHTML = icon(ICON.next, 26);
      const mid = el('div', 'mp-mid');
      const name = el('div', 'mp-name');
      const line = el('div', 'mp-line');
      const now = el('span', 'mp-time', '0:00');
      const seek = el('input');
      seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
      const total = el('span', 'mp-time', '0:00');
      line.appendChild(now); line.appendChild(seek); line.appendChild(total);
      mid.appendChild(name); mid.appendChild(line);
      const repeat = mk('mp-repeat', 'When a track ends: play it again, or go on to the next', () => { api.repeat = !api.repeat; });
      bar.appendChild(prev); bar.appendChild(play); bar.appendChild(next); bar.appendChild(mid); bar.appendChild(repeat);
      layer.appendChild(bar);

      let dragging = false, shownPlay = null;
      seek.addEventListener('pointerdown', () => { dragging = true; });
      seek.addEventListener('change', () => { api.seek(seek.value / 1000); dragging = false; paint(); });
      seek.addEventListener('input', () => { const st = api.state(); now.textContent = clock((seek.value / 1000) * st.duration); });
      const paint = () => {
        const st = api.state();
        const t = tracks.find((x) => x.no === st.no);
        rows.forEach(([b, tr]) => { b.classList.toggle('playing', tr.no === st.no && !st.paused); b.classList.toggle('chosen', tr.no === st.no); });
        name.textContent = tr(t ? t.title : open.length ? 'Choose a track' : 'No music heard in the story yet');
        name.classList.toggle('idle', !t);
        for (const b of [prev, play, next]) b.disabled = !open.length;
        const showPlay = !t || st.paused;
        if (showPlay !== shownPlay) { play.innerHTML = icon(showPlay ? ICON.play : ICON.pause, 34); shownPlay = showPlay; }
        repeat.textContent = tr(api.repeat ? 'Repeat' : 'Play through');
        seek.disabled = !t || !st.duration;
        if (!dragging) {
          seek.value = st.duration ? Math.round((st.time / st.duration) * 1000) : 0;
          now.textContent = clock(st.time);
        }
        total.textContent = clock(st.duration);
      };
      const timer = setInterval(paint, 250);
      const done = ctl.done;
      ctl.done = (v) => { clearInterval(timer); done(v); };
      this.back(layer, ctl);
      ctl.onKey = (e) => {
        if (e.key === ' ') { api.toggle(); paint(); return true; }
        return false;
      };
      ctl.ready = paint;
    });
  }

  // ---------------------------------------------------------------- settings
  // sections: [{ title, rows: [{ key, label, options: [[label, value]] } | { key, label, range: true }] }]
  config(sections, get, set) {
    return this.openLayer('paper config', (layer, ctl) => {
      layer.appendChild(el('h1', 'page-title', 'Settings'));
      // the desktop program (desktop/) is no browser
      layer.appendChild(el('div', 'page-note', location.protocol === 'app:' ? 'Kept on this computer' : 'Kept in this browser'));
      const cols = el('div', 'cols');
      const rows = [];
      let box = null;
      for (const sec of sections) {
        // a section marked `under` goes below the one before it, in the same column
        const below = sec.under && box;
        if (!below) box = el('div', 'cf-col');
        box.appendChild(el('div', 'cf-sec' + (below ? ' below' : ''), sec.title));
        for (const row of sec.rows) {
          rows.push(row);
          const r = el('div', 'cf-row');
          r.appendChild(el('div', 'cf-label', row.label));
          if (row.range) {
            const wrap = el('label', 'cf-range');
            const inp = el('input');
            inp.type = 'range'; inp.min = 0; inp.max = 100; inp.step = 5;
            inp.value = Math.round(get(row.key) * 100);
            const out = el('output', null, inp.value + '%');
            inp.addEventListener('input', () => { out.textContent = inp.value + '%'; set(row.key, inp.value / 100); });
            wrap.appendChild(inp);
            wrap.appendChild(out);
            r.appendChild(wrap);
          } else {
            const opts = el('div', 'cf-opts');
            const buttons = [];
            const paint = () => buttons.forEach(([b, v]) => b.classList.toggle('sel', get(row.key) === v));
            for (const [label, value] of row.options) {
              // `set` may ask first (and so take a while, or decline): the row shows what was kept
              // (every row is shown again: one setting can change what another reads, as the picture's shape does the glow)
              const b = ctl.nav(el('button', 'cf-opt', label), async () => { await set(row.key, value); rows.forEach((r) => r.repaint && r.repaint()); });
              buttons.push([b, value]);
              opts.appendChild(b);
            }
            row.repaint = paint;
            paint();
            r.appendChild(opts);
          }
          box.appendChild(r);
        }
        if (!below) cols.appendChild(box);
      }
      layer.appendChild(cols);
      this.back(layer, ctl);
      const onFs = () => rows.forEach((r) => r.repaint && r.repaint());
      document.addEventListener('fullscreenchange', onFs);
      const done = ctl.done;
      ctl.done = (v) => { document.removeEventListener('fullscreenchange', onFs); done(v); };
    });
  }

  // ---------------------------------------------------------------- flowchart
  // tabs: [{ label, note, chart, seen: Set of block ids, open: Set of block ids whose name may be shown,
  //          current: block id, fog: bool }], the first being the day itself.
  // opts: { canReplay, value(name) -> number, prefs: { all, hints }, savePrefs() }
  // Resolves to { replay: sceneId } or null.
  flowchart(tabs, opts) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text !== undefined) e.textContent = tr(text);
      return e;
    };
    const wrap = (str, max) => {
      const out = [];
      let line = '';
      // a name without spaces between its words (Japanese) breaks by the letter; a full-width
      // letter takes the room of about two
      if (!str.includes(' ') && /[^\x00-\xff]/.test(str)) {
        const per = Math.floor(max / 2) - 1;
        for (let i = 0; i < str.length; i += per) out.push(str.slice(i, i + per));
        if (out.length > 2) { out.length = 2; out[1] = out[1].slice(0, per - 1) + '…'; }
        return out;
      }
      for (const w of str.split(' ')) {
        if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
      }
      if (line) out.push(line);
      if (out.length > 2) { out.length = 2; out[1] = out[1].slice(0, max - 1).replace(/[ ,.;:]+$/, '') + '…'; }
      return out;
    };
    const NONAME = 'A scene without a name';
    const DOTS = '· · ·';
    const prefs = opts.prefs;
    return this.openLayer('paper flow', (layer, ctl) => {
      // the title and the tabs stand on one rule: full under the title and the chosen tab, faint between
      const head = el('div', 'fc-head');
      head.appendChild(el('h1', 'page-title', 'Flowchart'));
      const tabBar = el('div', 'fc-tabs');
      head.appendChild(tabBar);
      layer.appendChild(head);
      const legend = el('div', 'fc-legend');
      layer.appendChild(legend);
      const count = el('div', 'fc-count');
      layer.appendChild(count);
      const body = el('div', 'fc-body');
      layer.appendChild(body);
      const tabButtons = tabs.map((t, i) => {
        const b = el('button', 'fc-tab', t.label);
        b.addEventListener('click', () => show(i));
        tabBar.appendChild(b);
        return b;
      });
      const backBtn = this.back(layer, ctl);
      let keys = null;

      // what has been read, per tab: a gate counts as passed when the story has been on both sides of it
      const seenOf = tabs.map((t) => {
        const chart = t.chart;
        const m = new Map(chart.nodes.map((n) => [n.id, n.kind === 'scene' && t.seen.has(n.id)]));
        const into = new Map(chart.nodes.map((n) => [n.id, []]));
        for (const e of chart.edges) into.get(e.to).push(e.from);
        for (let pass = 0; pass < 3; pass++) {
          for (const n of chart.nodes) {
            if (n.kind !== 'gate') continue;
            const before = n.id === chart.nodes[0].id || into.get(n.id).some((f) => m.get(f));
            m.set(n.id, before && n.outs.some((e) => m.get(e.to)));
          }
        }
        return m;
      });

      const show = (index, focus) => {
        const t = tabs[index], chart = t.chart, isSeen = seenOf[index];
        const named = (n) => isSeen.get(n.id) || (t.open && t.open.has(n.id));
        const nameOf = (n) => tr(this.word(n.name || n.title || NONAME));
        const inEdges = new Map(chart.nodes.map((n) => [n.id, []]));
        for (const e of chart.edges) inEdges.get(e.to).push(e);
        tabButtons.forEach((b, k) => b.classList.toggle('on', k === index));
        body.innerHTML = '';
        ctl.items.length = 0;
        ctl.cur = -1;
        legend.innerHTML = '';
        if (t.note) legend.appendChild(el('span', 'fc-note', t.note));
        const scenes = chart.nodes.filter((n) => n.kind === 'scene');
        count.textContent = tr(opts.unlocked ? 'All ' + scenes.length + ' scenes unlocked'
          : scenes.filter((n) => isSeen.get(n.id)).length + ' of ' + scenes.length + ' scenes read');
        fitHead(head, count);
        requestAnimationFrame(() => fitHead(head, count));

        // What is drawn. By default only what has been reached: the scenes read, and the next
        // step from each (through any turn in the road). "Everything" draws the whole chart.
        const fog = !!t.fog && !prefs.all;
        const vis = new Set();
        if (!fog) for (const n of chart.nodes) vis.add(n.id);
        else {
          const reach = (id) => {
            if (vis.has(id)) return;
            vis.add(id);
            const n = chart.byId.get(id);
            if (n.kind === 'gate' && !isSeen.get(id)) for (const e of n.outs) reach(e.to);
          };
          const from = chart.nodes.filter((n) => isSeen.get(n.id));
          vis.add(chart.nodes[0].id);
          from.push(chart.nodes[0]);
          for (const n of from) { vis.add(n.id); for (const e of n.outs) reach(e.to); }
        }
        const routeLinks = new Set();
        const onRoute = new Set(t.route || []);
        if (t.route) {
          for (const id of t.route) vis.add(id);
          for (let i = 0; i + 1 < t.route.length; i++) routeLinks.add(t.route[i] + '>' + t.route[i + 1]);
        }

        const view = el('div', 'fc-view');
        const world = el('div', 'fc-world');
        const root = svg('svg', { width: chart.width, height: chart.height, viewBox: '0 0 ' + chart.width + ' ' + chart.height });
        const gBands = svg('g'), gEdges = svg('g'), gNodes = svg('g');
        root.appendChild(gBands);
        root.appendChild(gEdges);
        root.appendChild(gNodes);
        for (const b of chart.bands || []) {
          gBands.appendChild(svg('rect', { class: 'fc-band z-' + b.key, x: b.x, y: b.y, width: b.w, height: b.h, rx: 6 }));
          gBands.appendChild(svg('text', { class: 'fc-band-label z-' + b.key, x: b.x + 40, y: b.y + 150 }, b.label));
        }
        const bottom = (n) => n.y + (n.kind === 'gate' ? 40 : n.h);
        const top = (n) => n.y + (n.kind === 'gate' ? 14 : 0);
        const edgeEls = [];
        for (const e of chart.edges) {
          if (!vis.has(e.from) || !vis.has(e.to)) continue;
          const a = chart.byId.get(e.from), z = chart.byId.get(e.to);
          const pts = e.points.map((p, i) => (i === 0 ? [p[0], bottom(a)] : i === e.points.length - 1 ? [p[0], top(z)] : [p[0], p[1] + 27]));
          let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
          for (let i = 1; i < pts.length; i++) {
            const my = ((pts[i - 1][1] + pts[i][1]) / 2).toFixed(1);
            d += 'C' + pts[i - 1][0].toFixed(1) + ' ' + my + ' ' + pts[i][0].toFixed(1) + ' ' + my + ' ' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
          }
          const on = isSeen.get(e.to) && (isSeen.get(e.from) || a.id === chart.nodes[0].id);
          const guided = routeLinks.has(e.from + '>' + e.to);
          const path = svg('path', { d, class: 'fc-e' + (on ? ' on' : '') + (e.kind === 'if' ? ' if' : '') + (guided ? ' guide' : '') });
          if (on || guided) gEdges.appendChild(path); else gEdges.insertBefore(path, gEdges.firstChild);
          edgeEls.push([e, path]);
        }
        const nodeEls = new Map();
        for (const n of chart.nodes) {
          if (!vis.has(n.id)) continue;
          const seen = isSeen.get(n.id);
          const cls = 'fc-n ' + n.kind + (seen ? ' seen' : named(n) ? ' open' : ' unseen') + ' z-' + n.zoneKey + (n.id === t.current ? ' cur' : '') + (onRoute.has(n.id) ? ' onroute' : '');
          const g = svg('g', { class: cls, transform: 'translate(' + (n.x - n.w / 2).toFixed(1) + ',' + top(n) + ')' });
          g.dataset.id = n.id;
          if (n.kind === 'gate') {
            g.appendChild(svg('rect', { class: 'box', x: 4, y: 4, width: 18, height: 18, transform: 'rotate(45 13 13)' }));
          } else {
            g.appendChild(svg('rect', { class: 'box', x: 0, y: 0, width: n.w, height: n.h }));
            g.appendChild(svg('rect', { class: 'bar', x: 0, y: 0, width: 5, height: n.h }));
            if (named(n)) {
              const lines = wrap(nameOf(n), 23);
              lines.forEach((line, i) => g.appendChild(svg('text', { x: 15, y: (lines.length === 1 ? 32 : 23) + i * 18 }, line)));
            } else g.appendChild(svg('text', { x: n.w / 2 + 2, y: 31, 'text-anchor': 'middle' }, '·  ·  ·'));
            if (n.ends) {
              g.appendChild(svg('line', { class: 'endmark', x1: n.w / 2, y1: n.h, x2: n.w / 2, y2: n.h + 13 }));
              g.appendChild(svg('circle', { class: 'endmark', cx: n.w / 2, cy: n.h + 17, r: 4 }));
            }
            if (n.opens && n.opens.length && seen) g.appendChild(svg('circle', { class: 'opensmark', cx: n.w - 11, cy: 11, r: 4.5 }));
          }
          if (n.id === t.current) g.appendChild(svg('rect', { class: 'ring', x: -6, y: -6, width: n.w + 12, height: n.h + 12 }));
          gNodes.appendChild(g);
          nodeEls.set(n.id, g);
        }
        world.appendChild(root);
        view.appendChild(world);
        body.appendChild(view);

        // pan and zoom
        const VW = this.SW, VH = 750;
        const fitZ = Math.min(VW / chart.width, VH / chart.height);
        const minZ = Math.min(fitZ, 1), maxZ = Math.max(1.6, minZ);
        let z = Math.min(0.85, Math.max(minZ, 0.85)), tx = 0, ty = 0;
        const apply = () => {
          const w = chart.width * z, hgt = chart.height * z;
          tx = w <= VW ? (VW - w) / 2 : Math.min(120, Math.max(VW - w - 120, tx));
          ty = hgt <= VH ? (VH - hgt) / 2 : Math.min(120, Math.max(VH - hgt - 120, ty));
          world.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.toFixed(4) + ')';
        };
        const centre = (n, zoom) => {
          if (zoom) z = zoom;
          tx = VW / 2 - n.x * z;
          ty = VH / 2 - (n.y + 27) * z;
          apply();
        };
        // bring everything that is drawn into view
        const fit = () => {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const id of vis) {
            const n = chart.byId.get(id);
            x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2);
            y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y + n.h + 24);
          }
          if (!Number.isFinite(x0)) { z = minZ; apply(); return; }
          z = Math.max(minZ, Math.min(1.1, (VW - 120) / (x1 - x0), (VH - 100) / (y1 - y0)));
          tx = VW / 2 - ((x0 + x1) / 2) * z;
          ty = VH / 2 - ((y0 + y1) / 2) * z;
          apply();
        };
        const zoomAt = (factor, px, py) => {
          const nz = Math.min(maxZ, Math.max(minZ, z * factor));
          tx = px - ((px - tx) / z) * nz;
          ty = py - ((py - ty) / z) * nz;
          z = nz;
          apply();
        };
        const local = (e) => {
          const r = view.getBoundingClientRect();
          return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
        };

        // ---- the routes through a block: everything that can lead to it, and everything it can lead to
        const route = (id) => {
          world.classList.toggle('routing', !!id);
          if (!id) return;
          const walk = (start, step) => {
            const set = new Set([start]);
            const todo = [start];
            while (todo.length) for (const nx of step(todo.pop())) if (vis.has(nx) && !set.has(nx)) { set.add(nx); todo.push(nx); }
            return set;
          };
          const before = walk(id, (k) => inEdges.get(k).map((e) => e.from));
          const after = walk(id, (k) => chart.byId.get(k).outs.map((e) => e.to));
          for (const [e, path] of edgeEls) {
            const on = (before.has(e.from) && before.has(e.to)) || (after.has(e.from) && after.has(e.to));
            path.classList.toggle('route', on);
            if (on) gEdges.appendChild(path);
          }
          for (const [nid, g] of nodeEls) g.classList.toggle('dim', !before.has(nid) && !after.has(nid));
        };

        // ---- conditions in plain words (hints): which scenes raise the flag or count a branch asks for
        const refTo = (fid) => {
          const d = chart.byId.get(fid);
          const label = isSeen.get(fid) ? nameOf(d) : DOTS;
          if (!vis.has(fid)) return el('span', 'ref hidden', label);
          const b = el('button', 'ref', label);
          b.addEventListener('click', (ev) => { ev.stopPropagation(); select(fid); centre(d); });
          return b;
        };
        const condEl = (text) => {
          const box = el('span', 'how');
          parseCond(text).forEach((term, k) => {
            if (k) box.append(tr(' and '));
            const setters = (chart.setters.get(term.name) || []).filter((fid) => chart.byId.has(fid) && chart.byId.get(fid).kind === 'scene');
            const least = term.op === '>' ? term.n + 1 : term.n;
            const most = term.op === '<' ? term.n : term.n + 1;
            const up = term.op === '>=' || term.op === '>';
            const down = term.op === '<' || term.op === '<=';
            const many = up ? least > 1 : down ? most > 1 : true;
            box.append(tr(up ? (many ? 'after ' + least + ' of ' : 'after ') : down ? (many ? 'with fewer than ' + most + ' of ' : 'before ') : 'depending on '));
            if (!setters.length) box.append(tr('something outside the day'));
            else {
              setters.slice(0, 5).forEach((fid, n) => { if (n) box.append(tr(many ? ', ' : ' or ')); box.appendChild(refTo(fid)); });
              if (setters.length > 5) box.append(tr(' and ' + (setters.length - 5) + ' more'));
            }
            if (many && opts.value) box.append(tr(' (now ' + opts.value(term.name) + ')'));
          });
          return box;
        };
        const howEl = (e) => {
          if (e.kind === 'choice') return el('span', 'how', '“' + this.word(e.text) + '”');
          if (e.kind === 'if') return prefs.hints ? condEl(e.text) : el('span', 'how', 'depending on what has happened');
          return el('span', 'how', e.kind === 'else' ? 'otherwise' : 'then');
        };

        // the card for the block pointed at
        const card = el('div', 'fc-card');
        body.appendChild(card);
        let selected = null;
        const select = (id) => {
          if (selected && nodeEls.get(selected)) nodeEls.get(selected).classList.remove('sel');
          selected = id && nodeEls.has(id) ? id : null;
          card.innerHTML = '';
          card.classList.toggle('on', !!selected);
          route(selected);
          if (!selected) return;
          id = selected;
          const n = chart.byId.get(id);
          nodeEls.get(id).classList.add('sel');
          const seen = isSeen.get(id);
          if (n.kind === 'gate') {
            if (index === 0) {
              card.appendChild(el('div', 'fc-zone', 'A turn in the road'));
              card.appendChild(el('div', 'fc-name', 'The story goes on from here by what has happened so far.'));
            } else {
              card.appendChild(el('div', 'fc-zone z-' + chart.nodes[1].zoneKey, t.label));
              card.appendChild(el('div', 'fc-name', t.note || ''));
            }
          } else {
            card.appendChild(el('div', 'fc-zone z-' + n.zoneKey, named(n) ? n.zone || 'Scene' : index === 0 ? 'Scene' : t.label));
            card.appendChild(el('div', 'fc-name', named(n) ? nameOf(n) : index === 0 ? 'Not yet read.' : 'Not yet opened.'));
            if (index > 0) card.appendChild(el('div', 'fc-endnote', seen ? 'Read.' : named(n) ? 'Open on the game-start page, not yet read.' : 'Still closed.'));
          }
          const rows = (title, list) => {
            if (!list.length) return;
            const box = el('div', 'fc-outs');
            if (title) box.appendChild(el('div', 'fc-sub', title));
            for (const [how, to] of list) {
              const row = el('div', 'fc-out');
              const first = how.firstChild;
              if (first && first.nodeType === 3 && first.data) first.data = first.data[0].toUpperCase() + first.data.slice(1);
              row.appendChild(how);
              if (to) row.appendChild(to);
              box.appendChild(row);
            }
            card.appendChild(box);
          };
          const target = (fid) => {
            const to = chart.byId.get(fid);
            const b = el('button', 'to', isSeen.get(fid) ? (to.kind === 'gate' ? 'A turn in the road' : nameOf(to)) : to.kind === 'gate' ? 'A turn in the road' : DOTS);
            if (!vis.has(fid)) { b.disabled = true; return b; }
            b.addEventListener('click', (ev) => { ev.stopPropagation(); select(fid); centre(to); });
            return b;
          };
          // where it leads: a read scene's own choices always; a turn's branches and their conditions with hints
          if (index === 0 && (seen && n.kind === 'scene' ? true : n.kind === 'gate' && prefs.hints)) {
            rows(n.kind === 'gate' ? 'From here' : '', n.outs.map((e) => [howEl(e), target(e.to)]));
          } else if (index > 0 && seen && n.kind === 'scene') {
            rows('', n.outs.map((e) => [howEl(e), target(e.to)]));
          }
          // how to get to a scene not yet read (hints)
          if (index === 0 && prefs.hints && !seen && n.kind === 'scene') {
            const ways = inEdges.get(id).filter((e) => vis.has(e.from));
            rows('How to get here', ways.map((e) => {
              const how = howEl(e);
              how.prepend(e.kind === 'choice' ? tr('Choose ') : '');
              const from = chart.byId.get(e.from);
              const b = el('button', 'to', 'From ' + (from.kind === 'gate' ? 'a turn in the road' : isSeen.get(e.from) ? nameOf(from) : DOTS));
              b.addEventListener('click', (ev) => { ev.stopPropagation(); select(e.from); centre(from); });
              return [how, b];
            }));
          }
          if (index === 0 && prefs.hints && seen && n.sets && n.sets.length) card.appendChild(el('div', 'fc-endnote', 'Reading this counts towards something later.'));
          // links between the day and the dreams it opens
          const links = [];
          if (index === 0 && seen && n.opens && n.opens.length) {
            for (const key of n.opens) {
              const ti = tabs.findIndex((x, k) => k > 0 && x.chart.byId.has(key));
              if (ti > 0) links.push(['opens a dream', tabs[ti].chart.byId.get(key).name, ti, key]);
            }
          }
          if (index > 0 && n.openedBy && n.openedBy.length) {
            for (const fid of n.openedBy) {
              const d = tabs[0].chart.byId.get(fid);
              if (d) links.push(['opened in the day by', seenOf[0].get(fid) ? d.name || d.title || NONAME : DOTS, 0, fid]);
            }
          }
          rows('', links.map(([how, label, ti, id2]) => {
            const b = el('button', 'to', label);
            b.addEventListener('click', (ev) => { ev.stopPropagation(); show(ti, id2); });
            return [el('span', 'how', how), b];
          }));
          if (seen && n.ends) card.appendChild(el('div', 'fc-endnote', 'The day can end here.'));
          if (seen && n.kind === 'scene' && opts.canReplay) {
            const b = el('button', 'hm-link', 'Read this scene again');
            b.addEventListener('click', (ev) => { ev.stopPropagation(); ctl.done({ replay: n.scene }); });
            card.appendChild(b);
          }
        };

        let drag = null;
        view.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const [x, y] = local(e);
          drag = { x, y, tx, ty, moved: false, target: e.target };
          view.setPointerCapture(e.pointerId);
        });
        view.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const [x, y] = local(e);
          if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 5) return;
          drag.moved = true;
          view.classList.add('drag');
          tx = drag.tx + x - drag.x;
          ty = drag.ty + y - drag.y;
          apply();
        });
        const up = () => {
          if (!drag) return;
          if (!drag.moved) {
            const g = drag.target.closest ? drag.target.closest('.fc-n') : null;
            select(g ? g.dataset.id : null);
          }
          drag = null;
          view.classList.remove('drag');
        };
        view.addEventListener('pointerup', up);
        view.addEventListener('pointercancel', up);
        view.addEventListener('wheel', (e) => {
          e.preventDefault();
          const [x, y] = local(e);
          zoomAt(Math.exp(-e.deltaY * 0.0016), x, y);
        }, { passive: false });

        const toolsLeft = el('div', 'fc-tools left');
        const tools = el('div', 'fc-tools');
        const here = chart.byId.get(t.current);
        if (here && vis.has(here.id)) toolsLeft.appendChild(ctl.nav(el('button', 'fc-tool', 'Where I am'), () => { centre(here, Math.max(z, 0.85)); select(here.id); }));
        toolsLeft.appendChild(ctl.nav(el('button', 'fc-tool', 'Fit'), () => fit()));
        body.appendChild(toolsLeft);
        if (t.fog) {
          const toggle = (key, label, title) => {
            const b = el('button', 'fc-tool fc-switch' + (prefs[key] ? ' set' : ''), label);
            b.title = title;
            tools.appendChild(ctl.nav(b, () => { prefs[key] = !prefs[key]; if (opts.savePrefs) opts.savePrefs(); show(index, selected); }));
          };
          toggle('all', 'Everything', 'Draw the whole chart, or only what has been reached');
          toggle('hints', 'Hints', 'Say in plain words what each branch needs, and how to reach scenes not yet read');
        }
        body.appendChild(tools);
        ctl.items.push(backBtn);
        keys = (e) => {
          const step = 110;
          switch (e.key) {
            case 'ArrowLeft': tx += step; break;
            case 'ArrowRight': tx -= step; break;
            case 'ArrowUp': ty += step; break;
            case 'ArrowDown': ty -= step; break;
            case '+': case '=': zoomAt(1.2, VW / 2, VH / 2); return true;
            case '-': case '_': zoomAt(1 / 1.2, VW / 2, VH / 2); return true;
            case 'Tab': show((index + 1) % tabs.length); return true;
            default: return false;
          }
          apply();
          return true;
        };

        const target = focus && nodeEls.has(focus) ? chart.byId.get(focus) : here && vis.has(here.id) ? here : null;
        if (target) { centre(target, Math.max(minZ, 0.85)); select(target.id); }
        else fit();
      };

      ctl.onKey = (e) => (keys ? keys(e) : false);
      ctl.ready = () => show(0);
    });
  }

  // ---------------------------------------------------------------- opening page
  // tabs: [{ plate, build(panel) }]; the last tab's page starts the game.
  showHome({ art, brand, title, sub, line, foot, tabs, onStart, open = -1 }) {
    const home = this.home;
    this.homeOpen = true;
    this.syncModal();
    home.innerHTML = '';
    if (art) home.style.backgroundImage = 'url("' + art + '")'; else home.classList.add('fallback');
    home.appendChild(el('div', 'hm-brand', brand));
    const strip = el('div', 'hm-strip' + (tabs.length > 4 ? ' tight' : ''));     // a fifth plate: each a little narrower
    home.appendChild(strip);
    home.appendChild(el('div', 'hm-rule'));
    const intro = el('div', 'hm-intro');
    intro.appendChild(el('h1', null, title));
    intro.appendChild(el('div', 'sub', sub));
    intro.appendChild(el('div', 'bleed'));
    intro.appendChild(el('p', null, line));
    home.appendChild(intro);
    const panel = el('div', 'hm-panel paper');
    home.appendChild(panel);
    this.homeStatus = el('div', 'hm-status');
    home.appendChild(this.homeStatus);
    home.appendChild(el('div', 'hm-foot', foot));

    const plates = [];
    let tab = -1;
    const choose = (i) => {
      tab = i;
      plates.forEach((p, k) => p.classList.toggle('on', k === i));
      home.classList.toggle('tabbed', i >= 0);
      if (i >= 0) {
        panel.innerHTML = '';
        panel.className = 'hm-panel paper';      // a tab may add a class of its own (Play's hm-play)
        panel.scrollTop = 0;
        tabs[i].build(panel);
      }
    };
    this.homeRefresh = () => { if (tab >= 0) choose(tab); };
    tabs.forEach((t, i) => {
      const p = el('button', 'hm-plate', t.plate);
      p.addEventListener('click', () => choose(tab === i ? -1 : i));
      plates.push(p);
      strip.appendChild(p);
    });
    home.addEventListener('click', (e) => { if (e.target === home || e.target === intro) choose(-1); });
    if (open >= 0 && open < tabs.length) choose(open);
    this.homeKey = (e) => {
      if (e.target && e.target.tagName === 'INPUT') return false;
      const n = tabs.length;
      if (e.key === 'ArrowRight' || e.key === 'Tab') choose(tab < 0 ? 0 : (tab + 1) % n);
      else if (e.key === 'ArrowLeft') choose(tab < 0 ? n - 1 : (tab + n - 1) % n);
      else if (e.key === 'Escape') choose(-1);
      else if ((e.key === 'Enter' || e.key === ' ') && tab === n - 1) onStart();
      else if (e.key === 'ArrowDown') panel.scrollBy({ top: 90 });
      else if (e.key === 'ArrowUp') panel.scrollBy({ top: -90 });
      else return false;
      return true;
    };
  }
  setHomeStatus(text) { if (this.homeStatus) this.homeStatus.textContent = tr(text); }
  closeHome() {
    if (!this.home.isConnected) return;
    this.home.classList.add('leaving');
    this.homeOpen = false;
    this.syncModal();
    setTimeout(() => { this.home.remove(); }, 750);
  }
}

// small builders for the opening page's panels
export const h = {
  head: (panel, text) => panel.appendChild(el('h2', null, text)),
  p: (panel, text, cls) => panel.appendChild(el('p', cls || null, text)),
  rows: (panel, rows) => {
    const g = el('div', 'hm-rows');
    for (const [k, v] of rows) { g.appendChild(el('div', 'k', k)); g.appendChild(el('div', 'v', v)); }
    panel.appendChild(g);
  },
  facts: (panel, facts) => {
    const g = el('div', 'hm-facts');
    for (const [big, small] of facts) { const d = el('div'); d.appendChild(el('b', null, big)); d.appendChild(document.createTextNode(small)); g.appendChild(d); }
    panel.appendChild(g);
  },
  actions: (panel, actions) => {
    const g = el('div', 'hm-actions');
    for (const [label, fn, cls] of actions) { const b = el('button', 'hm-link' + (cls ? ' ' + cls : ''), label); b.addEventListener('click', fn); g.appendChild(b); }
    panel.appendChild(g);
  },
  // files to fetch: [[what it is for, the file's name, its address]]
  downloads: (panel, files) => {
    const g = el('div', 'hm-rows hm-files');
    for (const [k, name, href] of files) {
      g.appendChild(el('div', 'k', k));
      const a = document.createElement('a');
      a.className = 'hm-link';
      a.textContent = name;
      a.href = href;
      a.rel = 'noopener';
      g.appendChild(el('div', 'v')).appendChild(a);
    }
    panel.appendChild(g);
  },
  // a link that leaves the page
  link: (panel, lead, text, href) => {
    const p = el('p');
    if (lead) p.appendChild(document.createTextNode(lead + ' '));
    const a = el('a', 'hm-link', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    p.appendChild(a);
    panel.appendChild(p);
  },
  // one of a few: [[label, value]], the current value, and what to do when another is taken
  choice: (panel, label, options, current, fn) => {
    const g = el('div', 'hm-choice');
    g.appendChild(el('span', 'k', label));
    for (const [text, value] of options) {
      const b = el('button', 'hm-link' + (value === current ? ' on' : ''), text);
      if (value !== current) b.addEventListener('click', (e) => { e.stopPropagation(); fn(value); });
      g.appendChild(b);
    }
    panel.appendChild(g);
  },
  press: (panel, label, enabled, fn) => {
    const b = el('button', 'hm-press', label);
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', fn);
    panel.appendChild(b);
    return b;
  },
  // The Play page's space under its switches, down to the panel's foot, with "press any button" in
  // the middle: a click anywhere in it starts the game. Nothing above it does, so a click that
  // misses a switch is not taken for one.
  startArea: (panel, label, enabled, fn) => {
    const area = el('div', 'hm-start' + (enabled ? ' go' : ''));
    const b = h.press(area, label, enabled, fn);
    if (enabled) area.addEventListener('click', (e) => { if (e.target === area) fn(); });
    panel.appendChild(area);
    return b;
  },
};
