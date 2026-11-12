// Mouse / touch / keyboard -> a small queue of logical events the engine awaits.
//   click   left button, tap, Enter, Space
//   rclick  right button, two-finger tap, Escape
//   move    pointer moved (only delivered to someone waiting)
//   wheel   dy < 0 up, dy > 0 down
//   key     arrows / page keys
//   wake    something changed (Ctrl, a finger held down, skip toggle) - re-check state
// A finger held on the picture fast-forwards for as long as it stays there, as Ctrl held does.
import { W, H } from './gfx.js';

export class Input {
  constructor(canvas, onGlobalKey) {
    this.canvas = canvas;
    this.q = [];
    this.waiter = null;
    this.x = -1;
    this.y = -1;
    this.ctrl = false;
    this.modal = false;       // true while the interface has a page open: its own handlers take the keys
    this.onGlobalKey = onGlobalKey;
    this.vw = W;              // the view's width in the game's pixels, and where the game's 640
    this.ox = 0;              // begins in it (main.js sets both when the picture is 16:9)
    this.attach();
  }

  // the pointer in the game's 640 x 480; at 16:9 x runs past both ends of that
  pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    this.x = ((ev.clientX - r.left) / r.width) * this.vw - this.ox;
    this.y = ((ev.clientY - r.top) / r.height) * H;
    return { x: this.x, y: this.y };
  }

  push(ev) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
    } else if (ev.type !== 'move' && ev.type !== 'wake') {
      this.q.push(ev);
      if (this.q.length > 4) this.q.shift();
    }
  }
  flush() { this.q.length = 0; }
  takeClick() {
    const i = this.q.findIndex((e) => e.type === 'click' || e.type === 'sys');
    if (i >= 0 && this.q[i].type === 'sys') return false;   // a request for a menu waits for the next pause
    if (i < 0) return false;
    this.q.splice(i, 1);
    return true;
  }
  next(timeout) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((resolve) => {
      let timer = null;
      const w = (ev) => { if (timer !== null) clearTimeout(timer); resolve(ev); };
      this.waiter = w;
      if (timeout !== null && timeout !== undefined) {
        timer = setTimeout(() => {
          if (this.waiter === w) { this.waiter = null; resolve({ type: 'timeout' }); }
        }, Math.max(0, timeout));
      }
    });
  }

  attach() {
    const c = this.canvas;
    let longPress = null;
    let longFired = false;        // this touch has been taken as something other than a tap
    let holding = false;          // a finger is held down: fast-forwarding, as with Ctrl
    const touches = new Set();
    const letGo = () => {
      clearTimeout(longPress);
      if (!holding) return;
      holding = false;
      this.ctrl = false;
      this.push({ type: 'wake' });
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      const p = this.pos(e);
      if (e.pointerType === 'touch') {
        touches.add(e.pointerId);
        longFired = false;
        clearTimeout(longPress);
        if (touches.size >= 2) { longFired = true; letGo(); this.push({ type: 'rclick' }); return; }
        this.push({ type: 'move', x: p.x, y: p.y });
        longPress = setTimeout(() => {
          longFired = true;
          if (this.modal) return;
          holding = true;
          this.ctrl = true;
          this.push({ type: 'wake' });
        }, 450);
        return;
      }
      if (e.button === 0) this.push({ type: 'click', x: p.x, y: p.y });
      else if (e.button === 2) this.push({ type: 'rclick' });
      e.preventDefault();
    });
    c.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.delete(e.pointerId);
      letGo();
      if (!longFired && touches.size === 0) {
        const p = this.pos(e);
        this.push({ type: 'click', x: p.x, y: p.y });
      }
    });
    c.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); letGo(); });
    c.addEventListener('pointermove', (e) => {
      const p = this.pos(e);
      this.push({ type: 'move', x: p.x, y: p.y });
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY) this.push({ type: 'wheel', dy: e.deltaY });
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control') {
        if (!this.ctrl && !this.modal) { this.ctrl = true; this.push({ type: 'wake' }); }
        return;
      }
      if (e.metaKey || e.altKey || this.modal) return;
      switch (e.key) {
        case 'Enter': case ' ':
          e.preventDefault();
          if (!e.repeat) this.push({ type: 'click', key: true });
          return;
        case 'Escape': case 'Backspace':
          e.preventDefault();
          if (!e.repeat) this.push({ type: 'rclick' });
          return;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'PageUp': case 'PageDown':
        case 'k': case 'j': case 'h': case 'l':
          e.preventDefault();
          this.push({ type: 'key', key: ({ k: 'ArrowUp', j: 'ArrowDown', h: 'ArrowLeft', l: 'ArrowRight' })[e.key] || e.key });
          return;
      }
      if (!e.repeat && this.onGlobalKey && this.onGlobalKey(e.key.toLowerCase())) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { if (e.key === 'Control') this.ctrl = false; });
    window.addEventListener('blur', () => { holding = false; this.ctrl = false; });
  }
}
