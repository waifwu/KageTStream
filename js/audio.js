// Music (streamed through one <audio> element) and sound effects (Web Audio buffers).
//
// Story music that loops starts on the <audio> element, so that it sounds at once. Meanwhile the
// track is fetched whole and decoded; when it is ready, a Web Audio buffer that loops by itself is
// set to start at the moment the element's first pass ends, and the element is let run out. An
// element restarting its stream leaves a gap at every loop; the buffer has none.
//
// Only one of the two is ever to sound. The moment is worked out from where the element is, and
// the element can be held up after that (its stream waiting for more, a phone pausing it for a
// call or for another app and starting it again): so until the buffer has taken over, the element
// is checked against the time set for it, and the time is set again if it no longer fits. Once
// the buffer has taken over, the element is kept from starting again under it.
//
// The track is not fetched and decoded as it starts, but once it has played a few seconds
// (ARM_AFTER). A decoded track is some 50 MB; fast-forward goes through a change of music every
// second or two, and decoding each one made 375 MB of them in 25 seconds, every one but the last
// thrown away as soon as it was made, for the browser to clear up when it gets to it. A track that
// is gone again within those seconds is now never decoded. Its first pass is far longer than the
// wait, so the buffer is still ready well before it is wanted.

const ARM_AFTER = 4000;

export class AudioSys {
  constructor(loader) {
    this.loader = loader;
    this.bgmEl = new Audio();
    this.bgmEl.preload = 'auto';
    this.onBgmEnded = null;
    this.bgmEl.addEventListener('ended', () => { if (!this.loopSrc && this.onBgmEnded) this.onBgmEnded(); });
    // the element started by something other than this file (a headset's button, the system going on
    // with what it had paused) while the looping buffer is the one playing: it stays silent
    this.bgmEl.addEventListener('play', () => { if (this.loopOwns()) this.bgmEl.pause(); });
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
    this.loopOff = 0;         // checks in a row that found the element off that time (watchLoop)
    this.loopTimer = 0;
    this.armTimer = 0;        // the wait before a track is fetched whole and decoded (ARM_AFTER)
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

  // The Android app in the background (main.js appSuspend): the music and the sound effects stop where they are,
  // and go on from there when it comes back.
  sleep() {
    if (this.asleep) return;
    this.asleep = { el: !this.bgmEl.paused };
    this.bgmEl.pause();
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
  wake() {
    const was = this.asleep;
    this.asleep = null;
    if (!was) return;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (was.el) { const p = this.bgmEl.play(); if (p && p.catch) p.catch(() => {}); }
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
      // (the track decoded last is at hand: nothing to wait for)
      if (loop) {
        if (this.decoded && this.decoded.url === url) this.armLoop(token, url);
        else this.armTimer = setTimeout(() => { if (token === this.bgmToken && this.wantPlay) this.armLoop(token, url); }, ARM_AFTER);
      }
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
    const later = (ms) => { this.loopTimer = setTimeout(() => this.handOver(token), ms); };
    // a moment can only be set on a clock that is running, for an element that is playing
    if (this.asleep || this.ctx.state !== 'running') { later(250); return; }
    let left = 0;
    // (an element that has ended let its pass run out with no buffer to follow it, the time set
    // for one having been taken back: the buffer begins now)
    if (!el.ended) {
      if (el.paused || el.readyState < 2) { later(250); return; }
      left = buf.duration - el.currentTime;
      if (!(left > 0.3)) {
        // too near the end to time it: let the element come round, and try again
        later((Math.max(0, left) + 0.5) * 1000);
        return;
      }
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
    this.loopOff = 0;
    this.watchLoop(token);
  }

  // The looping buffer is the one playing (not merely set to).
  loopOwns() { return !!this.loopSrc && this.ctx.currentTime >= this.loopAt - 0.05; }

  // Between the moment being set and the buffer taking over: the element must still be on its way
  // to ending at that moment. If it is not (held up, paused, or its pass already over), the time
  // is taken back and set again from where the element now is.
  watchLoop(token) {
    clearTimeout(this.loopTimer);
    // (asleep, both stand still and go on together: there is nothing to check until then)
    if (this.asleep) { this.loopTimer = setTimeout(() => this.watchLoop(token), 250); return; }
    const until = this.loopAt - this.ctx.currentTime;
    this.loopTimer = setTimeout(() => {
      const el = this.bgmEl, src = this.loopSrc;
      if (token !== this.bgmToken || !src) return;
      if (this.asleep) { this.watchLoop(token); return; }
      const now = this.ctx.currentTime;
      if (now >= this.loopAt) {
        if (!el.paused) el.pause();                   // the buffer has it: whatever is left of the element's pass is cut
        return;
      }
      // (how far the element is from ending at that moment. Read in Safari it wavers by a tenth of
      // a second either way with nothing wrong, so it counts only when it is more and stays more;
      // what is left of a smaller one is cut off above, as the buffer takes over)
      const drift = (src.buffer.duration - el.currentTime) - (this.loopAt - now);
      this.loopOff = Math.abs(drift) > 0.2 ? this.loopOff + 1 : 0;
      if (el.ended || el.paused || this.ctx.state !== 'running' || this.loopOff >= 2) {
        this.unsetLoop();
        this.handOver(token);
        return;
      }
      this.watchLoop(token);
    }, until > 0.25 ? 200 : Math.max(0, until * 1000) + 30);
  }

  // Take back a buffer that was set to start and has not yet: the element loops by itself again.
  unsetLoop() {
    const src = this.loopSrc, g = this.loopGain;
    this.loopSrc = null;
    this.loopGain = null;
    if (!src) return;
    try { src.stop(); } catch (e) { /* already stopped */ }
    src.disconnect();
    g.disconnect();
    // (not an element whose pass is already over: told to loop it would no longer count as ended,
    // and would stay where it is, silent, with handOver waiting for it to play)
    if (!this.bgmEl.ended) this.bgmEl.loop = true;
  }

  // Stop a looping buffer (fading it over fadeMs if it has taken over) and forget the one waiting.
  dropLoop(fadeMs) {
    clearTimeout(this.loopTimer);
    clearTimeout(this.armTimer);
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
