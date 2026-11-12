// Music (streamed through one <audio> element) and sound effects (Web Audio buffers).
//
// Story music that loops starts on the <audio> element, so that it sounds at once. Meanwhile the
// track is fetched whole and decoded; when it is ready, a Web Audio buffer that loops by itself is
// set to start at the moment the element's first pass ends, and the element is let run out. An
// element restarting its stream leaves a gap at every loop; the buffer has none.

export class AudioSys {
  constructor(loader) {
    this.loader = loader;
    this.bgmEl = new Audio();
    this.bgmEl.preload = 'auto';
    this.onBgmEnded = null;
    this.bgmEl.addEventListener('ended', () => { if (!this.loopSrc && this.onBgmEnded) this.onBgmEnded(); });
    this.ctx = null;
    this.gain = null;
    this.seSource = null;
    this.seToken = 0;
    this.buffers = new Map();
    this.muted = false;
    this.bgmVolume = 1;
    this.seVolume = 1;
    this.bgmGain = null;      // the looping buffers' volume (the element has its own)
    this.decoded = null;      // { url, p }: the last track decoded for looping, kept for a return to it
    this.loopBuf = null;      // the decoded track waiting to take over from the element
    this.loopSrc = null;      // ... and the buffer source once it is set to (or does) play
    this.loopGain = null;     // that source's own gain, for a fade
    this.loopAt = 0;          // the AudioContext time at which it takes over
    this.loopTimer = 0;
    this.fade = null;
    this.pending = null;
    this.unlocked = false;
    // The music player's tracks are held whole (see playBgm): address -> promise of a blob: address.
    this.whole = new Map();
    this.bgmUrl = '';         // the track asked for last, by its own address whatever the element plays from
    this.bgmToken = 0;        // goes up with every change of track, so a slow load does not start a stale one
    this.loading = false;     // a whole track is on its way
    this.wantPlay = false;    // ... and whether it should sound when it arrives
  }

  // must be called from a user gesture
  unlock() {
    this.unlocked = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.ctx) {
        this.ctx = new AC();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
        this.gain.gain.value = this.muted ? 0 : this.seVolume;
        this.bgmGain = this.ctx.createGain();
        this.bgmGain.connect(this.ctx.destination);
        this.bgmGain.gain.value = this.muted ? 0 : this.bgmVolume;
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { console.warn('audio unavailable', e); }
    if (this.pending) { const p = this.pending; this.pending = null; this.playBgm(p.file, p.loop, p.whole); }
  }

  setMuted(m) {
    this.muted = m;
    this.bgmEl.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this.seVolume;
    if (this.bgmGain) this.bgmGain.gain.value = m ? 0 : this.bgmVolume;
  }
  setVolumes(bgm, se) {
    this.bgmVolume = Math.max(0, Math.min(1, bgm));
    this.seVolume = Math.max(0, Math.min(1, se));
    if (!this.fade) this.bgmEl.volume = this.bgmVolume;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.seVolume;
    if (this.bgmGain) this.bgmGain.gain.value = this.muted ? 0 : this.bgmVolume;
  }
  track() {
    const m = /track(\d+)\.\w+$/.exec(this.bgmUrl);
    return m && (!this.bgmEl.paused || this.loopSrc) ? 'Track ' + parseInt(m[1], 10) : '';
  }

  // A track in full, as a blob: address. A server that does not answer byte ranges (the site's host
  // does not) leaves a streamed track with nowhere to seek to and a guessed length; played from
  // memory it has its true length and can be moved anywhere. The last few are kept.
  wholeUrl(url) {
    let p = this.whole.get(url);
    if (p) { this.whole.delete(url); this.whole.set(url, p); return p; }      // used again: newest
    p = fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then((b) => URL.createObjectURL(b));
    p.catch(() => { if (this.whole.get(url) === p) this.whole.delete(url); });
    this.whole.set(url, p);
    for (const [u, old] of this.whole) {
      if (this.whole.size <= 4) break;
      if (u === url || u === this.bgmUrl) continue;
      this.whole.delete(u);
      old.then((src) => URL.revokeObjectURL(src), () => {});
    }
    return p;
  }

  pauseBgm() { this.cancelFade(); this.wantPlay = false; this.bgmEl.volume = this.bgmVolume; this.bgmEl.pause(); }
  resumeBgm() {
    this.wantPlay = true;
    if (this.loading || !this.bgmEl.src) return;
    const p = this.bgmEl.play();
    if (p && p.catch) p.catch(() => {});
  }
  seekBgm(seconds) {
    const el = this.bgmEl;
    if (this.loading) return;
    const s = el.seekable;
    let can = false;
    for (let i = 0; i < s.length; i++) if (seconds >= s.start(i) - 0.01 && seconds <= s.end(i) + 0.01) can = true;
    if (can || !this.bgmUrl || el.src.startsWith('blob:')) {
      try { el.currentTime = seconds; } catch (e) { /* not seekable yet */ }
      return;
    }
    // a streamed track that cannot go there: take it whole, then go
    const token = this.bgmToken, paused = el.paused, loop = el.loop;
    this.wholeUrl(this.bgmUrl).then((src) => {
      if (token !== this.bgmToken) return;
      el.src = src;
      el.loop = loop;
      el.currentTime = seconds;
      if (!paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
    }, () => {});
  }
  bgmState() {
    const el = this.bgmEl;
    if (this.loading) return { time: 0, duration: 0, paused: !this.wantPlay };
    return { time: el.currentTime || 0, duration: Number.isFinite(el.duration) ? el.duration : 0, paused: el.paused };
  }

  cancelFade() {
    if (this.fade) { clearInterval(this.fade); this.fade = null; }
  }

  // `whole`: fetch the track in full before it starts (the music player, whose bar must be able to
  // go anywhere). The story's music is streamed, so that it starts at once.
  playBgm(file, loop, whole) {
    this.cancelFade();
    this.dropLoop();
    const token = ++this.bgmToken;
    this.loading = false;
    const url = this.loader.findAudio(file);
    const el = this.bgmEl;
    if (!url) { console.warn('music not found:', file); el.pause(); return; }
    if (!this.unlocked) { this.pending = { file, loop, whole }; return; }
    this.bgmUrl = url;
    this.wantPlay = true;
    const begin = (src) => {
      el.src = src;
      el.loop = loop;
      el.volume = this.bgmVolume;
      el.muted = this.muted;
      if (!this.wantPlay) return;       // paused while it was on its way
      const p = el.play();
      if (p && p.catch) p.catch((e) => { if (e.name !== 'AbortError') console.warn('music playback failed', e.message); });
    };
    if (!whole) {
      begin(url);
      if (loop) this.armLoop(token, url);
      return;
    }
    el.pause();
    this.loading = true;
    // if it cannot be had whole, it is streamed after all
    this.wholeUrl(url).catch(() => url).then((src) => {
      if (token !== this.bgmToken) return;
      this.loading = false;
      begin(src);
    });
  }

  stopBgm(fadeMs) {
    this.cancelFade();
    this.pending = null;
    this.bgmToken++;
    this.loading = false;
    this.wantPlay = false;
    this.dropLoop(fadeMs);
    const el = this.bgmEl;
    if (el.paused) return;
    if (!fadeMs) { el.pause(); return; }
    const t0 = performance.now();
    this.fade = setInterval(() => {
      const t = (performance.now() - t0) / fadeMs;
      if (t >= 1) { this.cancelFade(); el.pause(); el.volume = this.bgmVolume; }
      else el.volume = this.bgmVolume * (1 - t);
    }, 40);
  }

  // ---- gapless loops (see the top of this file)

  armLoop(token, url) {
    if (!this.ctx || !this.bgmGain) return;           // no Web Audio: the element loops by itself
    let p = this.decoded && this.decoded.url === url ? this.decoded.p : null;
    if (!p) {
      p = fetch(url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((b) => this.ctx.decodeAudioData(b));
      this.decoded = { url, p };                      // one track at a time: a decoded track is large
      p.catch(() => { if (this.decoded && this.decoded.p === p) this.decoded = null; });
    }
    p.then((buf) => {
      if (token !== this.bgmToken) return;
      this.loopBuf = buf;
      this.handOver(token);
    }, () => {});                                     // could not be had: the element goes on looping
  }

  handOver(token) {
    clearTimeout(this.loopTimer);
    const el = this.bgmEl, buf = this.loopBuf;
    if (token !== this.bgmToken || !buf || this.loopSrc || !this.wantPlay) return;
    if (el.paused || el.readyState < 2) { this.loopTimer = setTimeout(() => this.handOver(token), 250); return; }
    const left = buf.duration - el.currentTime;
    if (!(left > 0.3)) {
      // too near the end to time it: let the element come round, and try again
      this.loopTimer = setTimeout(() => this.handOver(token), (Math.max(0, left) + 0.5) * 1000);
      return;
    }
    const g = this.ctx.createGain();
    g.connect(this.bgmGain);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(g);
    this.loopAt = this.ctx.currentTime + left;
    src.start(this.loopAt);
    el.loop = false;                                  // the element plays its first pass out, then stops
    this.loopSrc = src;
    this.loopGain = g;
  }

  // Stop a looping buffer (fading it over fadeMs if it has taken over) and forget the one waiting.
  dropLoop(fadeMs) {
    clearTimeout(this.loopTimer);
    this.loopBuf = null;
    const src = this.loopSrc, g = this.loopGain;
    this.loopSrc = null;
    this.loopGain = null;
    if (!src) return;
    const now = this.ctx.currentTime;
    const end = fadeMs && now >= this.loopAt ? now + fadeMs / 1000 : now;
    try {
      if (end > now) { g.gain.setValueAtTime(1, now); g.gain.linearRampToValueAtTime(0, end); }
      src.stop(end);
    } catch (e) { /* already stopped */ }
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  async playSe(file, loop) {
    this.stopSe();
    const token = this.seToken;
    const url = this.loader.findAudio(file);
    if (!url) { console.warn('sound not found:', file); return; }
    if (!this.ctx) return;
    try {
      let buf = this.buffers.get(url);
      if (!buf) {
        const res = await fetch(url);
        buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(url, buf);
      }
      if (token !== this.seToken) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.connect(this.gain);
      src.start();
      this.seSource = src;
    } catch (e) { console.warn('sound playback failed', file, e); }
  }

  stopSe() {
    this.seToken++;
    if (this.seSource) {
      try { this.seSource.stop(); } catch (e) { /* already stopped */ }
      this.seSource = null;
    }
  }
}
