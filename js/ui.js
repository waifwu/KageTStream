// Everything that waits for the reader. The waits that belong to the story
// itself (click marks, picture buttons, choices) are drawn on the canvas; the
// menus around it (system menu, save / load, history, flowchart, settings)
// are pages of the shell.
import { Signal } from './engine.js';
import { cleanLabel } from './text.js';
import { parseFlow, layoutFlow, sideStories, simulateDay } from './flowchart-model.js';
import { similarity } from './guide.js';
import { findSkin } from './skins.js';

export class UI {
  constructor(host) {
    this.host = host;
    this.engine = null;
    this.waitGlyphs = 0;
    this.charts = null;
  }

  setPointer(on) {
    this.host.gfx.screen.style.cursor = on ? 'pointer' : 'default';
  }

  // ------------------------------------------------------------------ click wait
  async clickWait(kind, noCursor) {
    const { gfx, input, text, shell } = this.host;
    const e = this.engine;
    e.flushGlobals();
    const typed = Math.max(0, text.glyphs.length - this.waitGlyphs);
    this.waitGlyphs = kind === '\\' ? 0 : text.glyphs.length;
    if (e.skipping()) { await this.host.frame(); return; }

    const cur = noCursor ? null : e.cursors[kind === '@' ? 0 : 1];
    const sp = cur && cur.sprite;
    const cells = sp ? sp.data.cells : 1;
    const animated = cells > 1 && sp.data.loop !== 3;
    let cell = 0, dir = 1;
    const draw = () => {
      if (!sp) { gfx.blit(); return; }
      const x = cur.abs ? cur.x : text.cursorX() + cur.x;
      const y = cur.abs ? cur.y : text.cursorY() + cur.y;
      gfx.overlay((ctx) => gfx.drawSprite(ctx, sp, x, y, cell));
    };
    draw();
    shell.setContext('text');
    const started = performance.now();
    const autoDelay = (900 + typed * 45) * [1.7, 1, 0.55][e.autoPace];
    try {
      for (;;) {
        let timeout = animated ? sp.data.delays[cell] || 100 : null;
        if (e.autoMode) {
          const left = started + autoDelay - performance.now();
          if (left <= 0) break;
          timeout = timeout === null ? left : Math.min(timeout, left);
        }
        const ev = await input.next(timeout);
        if (ev.type === 'timeout') {
          if (animated) {
            if (sp.data.loop === 2) {
              if (cell + dir < 0 || cell + dir >= cells) dir = -dir;
              cell += dir;
            } else if (sp.data.loop === 1) cell = Math.min(cells - 1, cell + 1);
            else cell = (cell + 1) % cells;
            draw();
          }
          continue;
        }
        if (ev.type === 'click') break;
        if (ev.type === 'wheel') {
          if (ev.dy > 0) break;
          await this.lookback();
          draw();
          continue;
        }
        if (ev.type === 'key') {
          if (ev.key === 'ArrowUp' || ev.key === 'PageUp' || ev.key === 'ArrowLeft') { await this.lookback(); draw(); }
          else if (ev.key === 'ArrowDown' || ev.key === 'PageDown' || ev.key === 'ArrowRight') break;
          continue;
        }
        if (ev.type === 'rclick' || ev.type === 'sys') {
          const r = ev.type === 'sys' ? await this.systemAction(ev.action) : await this.systemMenu();
          gfx.present(e.textMode);
          draw();
          if (r === 'skip') break;
          continue;
        }
        if (e.skipping()) break;
      }
    } finally {
      shell.setContext('busy');
    }
    gfx.blit();
  }

  // ------------------------------------------------------------------ image buttons
  // One of the game's own menus (skins.js), drawn as a page of the interface. The answer is the
  // number of the script's button, so the script goes on exactly as if that button had been pressed.
  async skinned(skin, buttons) {
    const { shell } = this.host;
    const has = (no) => buttons.some((b) => b.no === no);
    const items = skin.items.filter((i) => has(i.no));
    if (skin.kind === 'title') {
      const entries = skin.items.filter((i) => i.action || has(i.no));
      for (;;) {
        const r = await shell.gameTitle({ items: entries, secret: skin.secret && has(skin.secret.no) ? skin.secret : null, note: skin.note });
        if (r === 'config') { await this.host.openConfig(); continue; }
        if (r === 'gallery') { await this.gallery(); continue; }
        return r;
      }
    }
    // on the story's page the guide marks the entry the day begins with (and first asks which ending it is for)
    const guide = this.host.guide;
    let marked = items;
    if (guide && guide.on && skin.entries) {
      if (guide.needsEnding) {
        const e = await shell.ask('Which ending shall the guide lead to?', 'The walkthrough gives both. This can be changed on the Guide page.', [['Normal', 'normal'], ['True', 'true']], 0);
        if (e) guide.setEnding(e);
      }
      const offered = Object.keys(skin.entries).filter((k) => has(skin.entries[k]));
      const entry = guide.entryAmong(offered);
      if (entry) marked = items.map((i) => (i.no === skin.entries[entry] ? Object.assign({ guide: true }, i) : i));
    }
    for (;;) {
      const no = await shell.gamePage({ title: skin.title, items: marked, aside: skin.aside && has(skin.aside.no) ? skin.aside : null });
      const item = no === null ? null : skin.items.find((i) => i.no === no);
      if (item && item.action === 'config') { await this.host.openConfig(); continue; }
      // The script takes over from here. If it brings up another of these pages, this one stays
      // until that one is in, as between the gallery's pages; main.js lets it go as soon as the
      // script changes the picture to something else.
      shell.holdLeaving();
      if (no === null) return has(skin.back) ? skin.back : -1;
      return no;
    }
  }

  async buttonWait(buttons, img, name) {
    const skin = findSkin(name);
    if (skin) return this.skinned(skin, buttons);
    const { gfx, input } = this.host;
    input.flush();
    // The buttons are places on the background picture. Enlarged to fill a 16:9 view it loses its
    // top and foot; if a button lies there, the picture goes back to its own size while the
    // script keeps these buttons (the engine lets go at the next "btndef").
    if (buttons.some((b) => !gfx.backShown(b.x, b.y, b.w, b.h))) {
      gfx.setPlainOnly(true);
      gfx.present(this.engine.textMode);
    }
    const hit = (gx, gy) => {
      const { x, y } = gfx.toBack(gx, gy);
      for (let i = buttons.length - 1; i >= 0; i--) {
        const b = buttons[i];
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return i;
      }
      return -1;
    };
    let hover = hit(input.x, input.y);
    const draw = () => {
      gfx.overlay((ctx) => {
        if (hover >= 0 && img) {
          const b = buttons[hover];
          ctx.drawImage(img, b.sx, b.sy, b.w, b.h, b.x, b.y, b.w, b.h);
        }
      }, 'back');
      this.setPointer(hover >= 0);
    };
    draw();
    try {
      for (;;) {
        const ev = await input.next(null);
        if (ev.type === 'move') {
          const h = hit(ev.x, ev.y);
          if (h !== hover) { hover = h; draw(); }
        } else if (ev.type === 'click') {
          if (ev.key) {
            if (hover >= 0) return buttons[hover].no;
            continue;
          }
          hover = hit(ev.x, ev.y);
          draw();
          return hover >= 0 ? buttons[hover].no : 0;
        } else if (ev.type === 'rclick') {
          return -1;
        } else if (ev.type === 'key' && buttons.length) {
          const order = buttons.map((b, i) => i).sort((a, b) => buttons[a].no - buttons[b].no);
          let k = order.indexOf(hover);
          const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' || ev.key === 'PageUp';
          k = k < 0 ? (back ? order.length - 1 : 0) : (k + (back ? -1 : 1) + order.length) % order.length;
          hover = order[k];
          draw();
        }
      }
    } finally {
      this.setPointer(false);
    }
  }

  // ------------------------------------------------------------------ text choices
  async select(texts, labels) {
    const { gfx, input, text, shell } = this.host;
    const e = this.engine;
    input.flush();
    const [on, off] = e.selectColor;
    const saved = text.color;
    const spans = [];
    text.color = off;
    texts.forEach((t, index) => {
      if (!t) return;
      const from = text.glyphs.length;
      text.putWords(t);
      spans.push({ index, from, to: text.glyphs.length, rects: text.rectsOf(from, text.glyphs.length) });
      text.newline();
    });
    text.color = saved;
    const hit = (x, y) => spans.findIndex((s) => s.rects.some((r) => x >= r.x - 4 && x < r.x2 + 4 && y >= r.y && y < r.y + r.h));
    let hover = hit(input.x, input.y);
    // the guide's choice, if it is on and has one for this: a small moon before the option
    const guide = this.host.guide;
    // (a story in another language than the walkthrough's: the same options, in its wording)
    const told = this.host.guideTexts ? this.host.guideTexts(texts, labels) : texts;
    const wanted = guide ? guide.suggest(told) : -1;
    const paint = () => {
      spans.forEach((s, i) => {
        text.recolor(s.from, s.to, i === hover ? on : off);
        s.rects = text.rectsOf(s.from, s.to);      // (the page may have been set again in another font)
      });
      text.redraw();
      gfx.present(true);
      const mark = spans.find((sp) => sp.index === wanted);
      if (mark && mark.rects.length) {
        const r = mark.rects[0];
        const cx = Math.max(6 - gfx.OX, r.x - 9), cy = r.y + Math.min(r.h, text.win.fh) / 2 + 1;
        gfx.overlay((ctx) => {
          ctx.fillStyle = '#f4cf7c';
          ctx.shadowColor = 'rgba(0,0,0,.8)';
          ctx.shadowBlur = 3;
          ctx.beginPath();
          ctx.arc(cx, cy, 5.2, 0, Math.PI * 2);
          ctx.arc(cx - 1.8, cy, 3.9, 0, Math.PI * 2);
          ctx.fill('evenodd');
          ctx.shadowBlur = 0;
        });
      }
      this.setPointer(hover >= 0);
    };
    const chosen = (index) => {
      if (guide && guide.chose(told, index) === 'left') shell.toast('Not the guide\u2019s choice: no more marks this play-through, and the same Day stays next up.');
      return index;
    };
    paint();
    shell.setContext('text');
    try {
      for (;;) {
        const ev = await input.next(null);
        if (ev.type === 'move') {
          const h = hit(ev.x, ev.y);
          if (h !== hover) { hover = h; paint(); }
        } else if (ev.type === 'click') {
          if (!ev.key) { hover = hit(ev.x, ev.y); paint(); }
          if (hover >= 0) return chosen(spans[hover].index);
        } else if (ev.type === 'key') {
          const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
          if (ev.key === 'PageUp') { await this.lookback(); paint(); continue; }
          hover = hover < 0 ? (back ? spans.length - 1 : 0) : (hover + (back ? -1 : 1) + spans.length) % spans.length;
          paint();
        } else if (ev.type === 'wheel' && ev.dy < 0) {
          await this.lookback();
          paint();
        } else if (ev.type === 'rclick') {
          await this.systemMenu();
          paint();
        } else if (ev.type === 'sys') {
          await this.systemAction(ev.action);
          paint();
        }
      }
    } finally {
      shell.setContext('busy');
      this.setPointer(false);
      this.waitGlyphs = 0;
    }
  }

  // ------------------------------------------------------------------ system menu
  async systemMenu() {
    const e = this.engine;
    const { shell, audio } = this.host;
    // the script's own list, with this port's pages before its last entry
    const items = e.rmenu.map((r) => ({ label: cleanLabel(r.label), value: r.action }));
    const extra = [{ label: 'Flowchart', value: 'flowchart' }];
    if (this.host.guide && this.host.guide.available) extra.push({ label: 'Guide', value: 'guide' });
    extra.push({ label: 'Settings', value: 'config' });
    const at = items.findIndex((i) => i.value === 'reset');
    items.splice(at < 0 ? items.length : at, 0, ...extra);
    for (;;) {
      const action = await shell.menu(items, { title: e.replaying ? 'Reading a scene again' : cleanLabel(e.caption.split('//')[0].trim()), track: audio.track() });
      if (!action) return null;
      const r = await this.systemAction(action);
      if (action === 'config' || action === 'flowchart' || action === 'guide') continue;   // back to the menu from its own pages
      return r;
    }
  }

  async systemCall(what) {
    const r = await this.systemAction(what);
    this.host.gfx.present(this.engine.textMode);
    return r;
  }

  async systemAction(action) {
    const e = this.engine;
    const { shell } = this.host;
    switch (action) {
      case 'skip': e.setSkip(true); return 'skip';
      case 'windowerase': await this.windowErase(); return null;
      case 'lookback': await this.lookback(); return null;
      case 'save': await this.saveMenu(); return null;
      case 'load': await this.loadMenu(); return null;
      case 'config': await this.host.openConfig(); return null;
      case 'flowchart': await this.flowchart(); return null;
      case 'guide': if (this.host.guide) await shell.guidePage(this.host.guide); return null;
      case 'reset':
        if (await shell.confirm('Return to the title screen?', 'The day so far is kept only if it has been saved.')) throw new Signal('reset');
        return null;
      case 'rmenu': return this.systemMenu();
      case 'automode': e.autoMode = true; this.host.onState(); return 'skip';
      case 'end':
        if (await shell.confirm('Leave the game?')) throw new Signal('end');
        return null;
      default: return null;
    }
  }

  slots(forLoad) {
    const e = this.engine;
    const out = [];
    for (let no = 1; no <= e.saveNumber; no++) {
      const d = this.host.storage.loadSlot(no);
      const info = d ? { time: d.time, thumb: d.thumb, excerpt: d.excerpt } : null;
      out.push({ no, info, disabled: forLoad && (!d || d.scriptLen !== e.scriptLen) });
    }
    return out;
  }

  async saveMenu() {
    const e = this.engine;
    const { shell } = this.host;
    if (!e.snapshot) { shell.toast('There is nothing to save yet.'); return; }
    const slots = this.slots(false);
    const no = await shell.saves(cleanLabel(e.saveName[0]).replace(/[■□]/g, '').replace(/\s+/g, ' ').trim() || 'Save game', 'Choose where to keep this page', slots);
    if (!no) return;
    if (slots[no - 1].info && !(await shell.confirm('Write over No. ' + String(no).padStart(2, '0') + '?'))) return;
    if (e.saveToSlot(no)) shell.toast('Saved in No. ' + String(no).padStart(2, '0') + '.');
    else await shell.notice('The save could not be written.', "The browser's storage is full or turned off.");
  }

  async loadMenu() {
    const e = this.engine;
    const { shell, storage } = this.host;
    const no = await shell.saves(cleanLabel(e.saveName[1]).replace(/[■□]/g, '').replace(/\s+/g, ' ').trim() || 'Load game', 'Choose a page to return to', this.slots(true));
    if (!no) return;
    if (!(await shell.confirm('Return to No. ' + String(no).padStart(2, '0') + '?', 'Anything not saved since is left behind.'))) return;
    const data = storage.loadSlot(no);
    if (data) throw new Signal('load', data);
  }

  async windowErase() {
    const { gfx, input } = this.host;
    gfx.present(false);
    input.flush();
    for (;;) {
      const ev = await input.next(null);
      if (ev.type === 'click' || ev.type === 'rclick') break;
    }
    gfx.present(this.engine.textMode);
  }

  // ------------------------------------------------------------------ text history
  async lookback() {
    const { text, shell } = this.host;
    const pages = text.history.map((p) => ({ lines: text.historyLines(p), now: false }));
    const now = text.linesOf(text.glyphs);
    if (now.some((l) => l.trim())) pages.push({ lines: now, now: true });
    if (!pages.length) { shell.toast('Nothing has been read yet.'); return; }
    await shell.log(pages, this.engine.lookbackColor);
  }

  // ------------------------------------------------------------------ gallery (from the title)
  async gallery() {
    const e = this.engine;
    const { shell, audio } = this.host;
    try {
      for (;;) {
        const guide = this.host.guide;
        const entries = [{ no: 'cg', label: 'Graphics mode' }, { no: 'flow', label: 'Flowchart' }, { no: 'music', label: 'Music player' }];
        if (guide && guide.available) entries.push({ no: 'guide', label: 'Guide' });
        const pick = await shell.gamePage({ title: 'Gallery', items: entries });
        if (pick === null) return;
        if (pick === 'guide') { await shell.guidePage(guide); continue; }
        if (pick === 'cg') await shell.cgGallery(this.pictures());
        else if (pick === 'flow') await this.flowchart();
        else if (pick === 'music') await this.musicPlayer();
      }
    } finally {
      // (the music player's track keeps playing on the title and through the menus: releaseMusic
      // stops it when the story itself begins, or when the script starts or stops music of its own)
    }
  }

  // The music player lets go of the music. `stop` when nothing else is about to take it over.
  releaseMusic(stop) {
    if (!this.playing) return;
    this.playing = 0;
    this.host.audio.onBgmEnded = null;
    if (stop) this.host.audio.stopBgm(600);
  }

  // "Unlock everything" (Settings) is on: the galleries, the music player and the flowchart show
  // everything as open. Nothing of the reader's own progress is changed by it, and that progress
  // goes on being kept, so turning the switch off shows it again as it really stands.
  unlocked() { return !!(this.host.unlocked && this.host.unlocked()); }

  // The script the flowchart and the track names are read from: the English one, also while the
  // story runs in another language (the two have the same scenes under the same labels).
  refSrc() { return this.host.refScript || this.engine.src; }

  // Whether a scene has been read through: its closing label "*se<N>" has been passed. A scene
  // whose closing label only one of the scripts has counts as read once it has been entered.
  entered(scene) {
    const e = this.engine;
    const end = 'se' + scene.slice(1);
    if (!this.refLabels) {
      this.refLabels = new Set();
      for (const m of this.refSrc().matchAll(/^[ \t]*\*([A-Za-z0-9_]+)/gm)) this.refLabels.add(m[1].toLowerCase());
    }
    if (e.labels.has(end) && this.refLabels.has(end)) return e.labelLog.has(end);
    return e.labelLog.has(end) || e.labelLog.has(scene);
  }

  // The game's four galleries, read from the script: each fills in a page's nine pictures (and,
  // for two of them, names and the flags that open them) before it shows the page, and that
  // stretch of script is simply run for every page. What opens a picture differs by gallery:
  // having been shown in the story, a flag set by the story, or how often the game has been started.
  pictures() {
    const e = this.engine;
    const { loader } = this.host;
    const all = this.unlocked();
    const clean = (t) => cleanLabel(t || '').trim();
    const started = e.numalias.has('execution_cnt') ? e.getNum(e.numalias.get('execution_cnt')) : 0;
    const keep = [e.getNum(4020), e.getNum(4025), e.getNum(4012)];
    const cats = [];
    for (const [label, name, rule] of [['ren_event_gallery', 'Events', 'shown'], ['yume_event_gallery', 'Ten Nights of Dream', 'shown'],
      ['post_gallery', 'Submitted art', 'starts'], ['guest_gallery', 'Guest art', 'flag']]) {
      if (!e.labels.has(label)) continue;
      const items = [];
      for (let page = 1; page <= 40; page++) {
        e.setNum(4020, page);
        e.evalUntilGosub(label);
        if (e.getNum(4020) !== page) break;          // past the last page: the script wraps round
        for (let k = 1; k <= 9; k++) {
          const file = e.getStr(4000 + k);
          if (!file || file[0] === '*') continue;
          const url = loader.resolve(file);
          if (!url) continue;
          const unlocked = all ? true : rule === 'shown' ? e.fileLog.has(file.replace(/\\/g, '/').toLowerCase())
            : rule === 'flag' ? e.getNum(4040 + k) !== 0 : started >= e.getNum(4060 + k);
          items.push({ url, unlocked, title: rule === 'shown' ? '' : clean(e.getStr(4040 + k)), artist: rule === 'shown' ? '' : clean(e.getStr(4050 + k)) });
        }
      }
      if (items.length) cats.push({ label: name, items });
    }
    e.setNum(4020, keep[0]);
    e.setNum(4025, keep[1]);
    e.setNum(4012, keep[2]);
    return cats;
  }

  // The tracks, as the script's own music room names them ("*mp_play<N>": play "*<N>", "Now playing: ...").
  tracks() {
    if (this.trackList) return this.trackList;
    const src = this.refSrc();
    const out = [];
    for (const m of src.matchAll(/^[ \t]*\*mp_play\d+\b/gm)) {
      const end = src.indexOf('\n*', m.index + 1);
      const block = src.slice(m.index, end < 0 ? m.index + 600 : end);
      const play = /play\w*\s+"\*(\d+)"/.exec(block);
      const title = /Now playing:\s*([^\n]*)/.exec(block);
      if (!play) continue;
      const no = parseInt(play[1], 10);
      out.push({ no, title: title ? title[1].replace(/!sd|!s\d+|`/g, '').trim() : 'Track ' + no });
    }
    if (!out.length) for (let no = 2; no <= 18; no++) out.push({ no, title: 'Track ' + no });
    out.sort((a, b) => a.no - b.no);
    this.trackList = out.filter((t) => this.host.loader.findAudio('cd/track' + String(t.no).padStart(2, '0')));
    return this.trackList;
  }

  // The track numbers the reader has met in the story. The engine notes each one as the story
  // plays it; for progress made before it kept that note, the scenes already read are gone
  // through for the music they play (a scene runs from "*s<N>" to "*se<N>").
  heardTracks() {
    const e = this.engine;
    if (this.unlocked()) return new Set(this.tracks().map((t) => t.no));
    const heard = new Set();
    for (const f of e.musicLog) { const m = /track0*(\d+)$/.exec(f); if (m) heard.add(parseInt(m[1], 10)); }
    if (!this.sceneMusic) {
      this.sceneMusic = new Map();          // scene id -> track numbers played in it
      let scene = null;
      for (const line of e.src.split('\n')) {
        const l = /^\s*\*(se?)(\d+)\b/.exec(line);
        if (l) { scene = l[1] === 's' ? 's' + l[2] : null; continue; }
        if (/^\s*\*/.test(line)) { scene = null; continue; }
        if (!scene) continue;
        for (const p of line.matchAll(/(?:^|:)\s*play\w*\s+"\*0*(\d+)"/g)) {
          if (!this.sceneMusic.has(scene)) this.sceneMusic.set(scene, new Set());
          this.sceneMusic.get(scene).add(parseInt(p[1], 10));
        }
      }
    }
    for (const [scene, nos] of this.sceneMusic) if (this.entered(scene)) for (const no of nos) heard.add(no);
    return heard;
  }

  async musicPlayer() {
    const { shell, audio } = this.host;
    // a track the reader has not met in the story yet keeps its name to itself and cannot be played
    const heard = this.heardTracks();
    const all = this.tracks().map((t) => (heard.has(t.no) ? t : { no: t.no, title: '', locked: true }));
    const tracks = all.filter((t) => !t.locked);
    if (!this.mp) this.mp = { repeat: true };
    const mp = this.mp;
    const file = (no) => 'cd/track' + String(no).padStart(2, '0');
    const step = (d) => {
      const i = tracks.findIndex((t) => t.no === this.playing);
      return tracks[(i < 0 ? (d > 0 ? 0 : tracks.length - 1) : i + d + tracks.length) % tracks.length].no;
    };
    const api = {
      play: (no) => { this.playing = no; audio.playBgm(file(no), false, true); },     // whole: the bar can go anywhere
      toggle: () => {
        if (!tracks.length) return;
        if (!(this.playing > 0)) { api.play(tracks[0].no); return; }
        if (audio.bgmState().paused) audio.resumeBgm(); else audio.pauseBgm();
      },
      next: () => { if (tracks.length) api.play(step(1)); },
      prev: () => {
        if (!tracks.length) return;
        // back to the start of this track first, as players do, then to the one before
        if (this.playing > 0 && audio.bgmState().time > 3) audio.seekBgm(0); else api.play(step(-1));
      },
      seek: (f) => { const st = audio.bgmState(); if (st.duration) audio.seekBgm(f * st.duration); },
      state: () => Object.assign({ no: this.playing > 0 ? this.playing : 0 }, audio.bgmState()),
      get repeat() { return mp.repeat; },
      set repeat(v) { mp.repeat = v; },
    };
    // when a track ends it plays again or the next one follows, whether or not this page is still open
    audio.onBgmEnded = () => { if (this.playing > 0) api.play(mp.repeat ? this.playing : step(1)); };
    await shell.musicPlayer(all, api);
  }

  // ------------------------------------------------------------------ flowchart
  async flowchart() {
    const e = this.engine;
    const { shell } = this.host;
    if (!this.charts) {
      const flow = parseFlow(this.refSrc());
      this.charts = { model: flow, day: layoutFlow(flow, { bands: true }), side: sideStories(this.refSrc(), flow) };
      // the chart is laid out from the reference script; where the story runs in another language
      // its scenes carry the names that script gives them
      const names = this.host.sceneNames;
      if (names) {
        for (const n of this.charts.day.nodes) {
          const own = n.scene && names.get(n.scene);
          if (own) { n.name = own.name; n.zone = own.zone; }
        }
      }
    }
    const day = this.charts.day;
    if (!day.nodes.length) { shell.toast('This story has no flowchart.'); return; }
    const flag = (name) => (name && e.numalias.has(name) ? e.getNum(e.numalias.get(name)) : 0);
    const entered = (scene) => this.entered(scene);
    const all = this.unlocked();
    const seen = new Set();
    for (const n of day.nodes) if (n.kind === 'scene' && (all || entered(n.scene))) seen.add(n.id);
    const tabs = [{ label: 'The day', chart: day, seen, open: null, current: e.replaying ? null : e.currentFlow, fog: true }];
    // With the guide on, the way its choices lead through today: the flow is followed block by
    // block from the values the day began with (kept by main.js when "*f500" is passed).
    const guide = this.host.guide;
    if (guide && guide.on && guide.today && guide.today.entry === 'a day' && !(guide.active && guide.lost)) {
      const t = guide.today;
      const began = guide.active && this.host.dayStart ? this.host.dayStart : null;
      const value = (name) => { const i = e.numalias.get(name); return i === undefined ? 0 : began ? began[i] | 0 : e.getNum(i); };
      let k = 0;
      const walk = simulateDay(this.charts.model, value, (texts) => {
        const st = t.steps[k];
        if (!st) return -1;
        let best = -1, score = 0;
        texts.forEach((opt, i) => {
          const sc = similarity(st.text, opt) + (new RegExp('^\\s*' + st.k + '\\.').test(opt) ? 0.15 : 0);
          if (sc > score) { score = sc; best = i; }
        });
        if (score < 0.6) return -1;
        k++;
        return best;
      }, { quizPass: Array.isArray(t.quiz) });
      tabs[0].route = walk.path;
      tabs[0].note = 'In amber: the guide\u2019s way through day ' + t.n + '.';
    }
    for (const s of this.charts.side) {
      const read = new Set(), open = new Set();
      for (const n of s.chart.nodes) {
        if (n.kind !== 'scene') continue;
        if (all || (n.fin ? flag(n.fin) > 0 : entered(n.scene))) read.add(n.id);
        if ((all || flag(n.flag) > 0) && n.fin) open.add(n.id);
      }
      tabs.push({ label: s.label, note: s.note, chart: s.chart, seen: read, open, current: null, fog: false });
    }
    const prefs = this.host.flowPrefs;
    const r = await shell.flowchart(tabs, { canReplay: true, value: flag, prefs, savePrefs: this.host.saveFlowPrefs, unlocked: all });
    if (r && r.replay) {
      if (await shell.confirm('Read this scene again?', 'It plays by itself and then returns to the title. The day so far is kept only if it has been saved.')) {
        throw new Signal('replay', r.replay);
      }
      return this.flowchart();
    }
  }
}
