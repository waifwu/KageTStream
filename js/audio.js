// Music (streamed through one <audio> element) and sound effects (Web Audio buffers).

export class AudioSys {
  constructor(loader) {
    this.loader = loader;
    this.bgmEl = new Audio();
    this.bgmEl.preload = 'auto';
    this.onBgmEnded = null;
    this.bgmEl.addEventListener('ended', () => { if (this.onBgmEnded) this.onBgmEnded(); });
    this.ctx = null;
    this.gain = null;
    this.seSource = null;
    this.seToken = 0;
    this.buffers = new Map();
    this.muted = false;
    this.bgmVolume = 1;
    this.seVolume = 1;
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
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { console.warn('audio unavailable', e); }
    if (this.pending) { const p = this.pending; this.pending = null; this.playBgm(p.file, p.loop, p.whole); }
  }

  setMuted(m) {
    this.muted = m;
    this.bgmEl.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this.seVolume;
  }
  setVolumes(bgm, se) {
    this.bgmVolume = Math.max(0, Math.min(1, bgm));
    this.seVolume = Math.max(0, Math.min(1, se));
    if (!this.fade) this.bgmEl.volume = this.bgmVolume;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.seVolume;
  }
  track() {
    const m = /track(\d+)\.\w+$/.exec(this.bgmUrl);
    return m && !this.bgmEl.paused ? 'Track ' + parseInt(m[1], 10) : '';
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
    if (!whole) { begin(url); return; }
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
