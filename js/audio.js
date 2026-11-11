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
    if (this.pending) { const p = this.pending; this.pending = null; this.playBgm(p.file, p.loop); }
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
    const m = /track(\d+)\.\w+$/.exec(this.bgmEl.src || '');
    return m && !this.bgmEl.paused ? 'Track ' + parseInt(m[1], 10) : '';
  }

  pauseBgm() { this.cancelFade(); this.bgmEl.volume = this.bgmVolume; this.bgmEl.pause(); }
  resumeBgm() {
    if (!this.bgmEl.src) return;
    const p = this.bgmEl.play();
    if (p && p.catch) p.catch(() => {});
  }
  seekBgm(seconds) { try { this.bgmEl.currentTime = seconds; } catch (e) { /* not seekable yet */ } }
  bgmState() {
    const el = this.bgmEl;
    return { time: el.currentTime || 0, duration: Number.isFinite(el.duration) ? el.duration : 0, paused: el.paused };
  }

  cancelFade() {
    if (this.fade) { clearInterval(this.fade); this.fade = null; }
  }

  playBgm(file, loop) {
    this.cancelFade();
    const url = this.loader.findAudio(file);
    const el = this.bgmEl;
    if (!url) { console.warn('music not found:', file); el.pause(); return; }
    if (!this.unlocked) { this.pending = { file, loop }; return; }
    el.src = url;
    el.loop = loop;
    el.volume = this.bgmVolume;
    el.muted = this.muted;
    const p = el.play();
    if (p && p.catch) p.catch((e) => { if (e.name !== 'AbortError') console.warn('music playback failed', e.message); });
  }

  stopBgm(fadeMs) {
    this.cancelFade();
    this.pending = null;
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
