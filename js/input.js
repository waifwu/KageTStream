// Mouse / touch / keyboard -> a small queue of logical events the engine awaits.
//   click   left button, tap, the "go on" keys (Enter, Space)
//   rclick  right button, two-finger tap, the "menu" keys (Escape)
//   move    pointer moved (only delivered to someone waiting)
//   wheel   dy < 0 up, dy > 0 down
//   key     arrows / page keys
//   wake    something changed (Ctrl, a finger held down, skip toggle) - re-check state
// A finger held on the picture fast-forwards for as long as it stays there, as Ctrl held does.
// Which key is which is the reader's to set (keys.js, Settings > Controls); the keys named here
// are the ones the game comes with.
import { W, H } from './gfx.js';
import { keyOf, actionOf, pageKeyOf } from './keys.js';

export class Input {
  // onShortcut(action) -> true if it was taken: the actions that are neither a click nor a movement
  constructor(canvas, onShortcut) {
    this.canvas = canvas;
    this.q = [];
    this.waiter = null;
    this.x = -1;
    this.y = -1;
    this.ctrl = false;        // fast-forwarding for as long as something is held: the key for it, or a finger
    this.modal = false;       // true while the interface has a page open: its own handlers take the keys
    this.onShortcut = onShortcut;
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
    // The right button opens the menu on "contextmenu", which the browser sends once it is done with
    // the press (as it goes down on macOS and Linux, as it comes up on Windows). Taken on the press
    // itself, the menu's page would be up before that event, the event would land on the page, and
    // there a right-click means "close": the menu would shut in the same click that opened it.
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.pointerType === 'touch' || touches.size) return;   // a finger held down fast-forwards instead
      this.push({ type: 'rclick' });
    });
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
      const action = actionOf(keyOf(e));
      if (action === 'hold') {
        if (this.modal) return;
        e.preventDefault();
        if (!this.ctrl) { this.ctrl = true; this.push({ type: 'wake' }); }
        return;
      }
      if (e.metaKey || e.altKey || this.modal || !action) return;
      switch (action) {
        case 'confirm':
          e.preventDefault();
          if (!e.repeat) this.push({ type: 'click', key: true });
          return;
        case 'menu':
          e.preventDefault();
          if (!e.repeat) this.push({ type: 'rclick' });
          return;
        case 'up': case 'down': case 'left': case 'right': case 'pageup': case 'pagedown':
          e.preventDefault();
          this.push({ type: 'key', key: pageKeyOf(action) });
          return;
      }
      if (!e.repeat && this.onShortcut && this.onShortcut(action)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { if (actionOf(keyOf(e)) === 'hold') this.ctrl = false; });
    window.addEventListener('blur', () => { holding = false; this.ctrl = false; });
  }
}
