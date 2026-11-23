// Save data lives in localStorage (falls back to memory if it is unavailable).

export class Storage {
  constructor(prefix) {
    this.prefix = prefix;
    this.slotPrefix = '';       // saved games are a script's own: another language keeps its own set
    this.mem = new Map();
    try {
      localStorage.setItem(prefix + 'probe', '1');
      localStorage.removeItem(prefix + 'probe');
      this.ls = localStorage;
    } catch (e) {
      this.ls = null;
      console.warn('localStorage unavailable; progress will not persist');
    }
  }
  get(key) {
    try {
      const v = this.ls ? this.ls.getItem(this.prefix + key) : this.mem.get(key);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }
  set(key, val) {
    const v = JSON.stringify(val);
    try {
      if (this.ls) this.ls.setItem(this.prefix + key, v); else this.mem.set(key, v);
      return true;
    } catch (e) {
      console.warn('could not write save data', e);
      return false;
    }
  }
  remove(key) {
    try { if (this.ls) this.ls.removeItem(this.prefix + key); else this.mem.delete(key); } catch (e) { /* nothing to remove */ }
  }
  loadGlobals() { return this.get('global'); }
  saveGlobals(g) { return this.set('global', g); }
  saveSlot(no, data) { return this.set(this.slotPrefix + 'save' + no, data); }
  loadSlot(no) { return this.get(this.slotPrefix + 'save' + no); }
  slotInfo(no) {
    const d = this.get(this.slotPrefix + 'save' + no);
    return d ? { time: d.time, scriptLen: d.scriptLen } : null;
  }
  loadSettings() { return this.get('settings') || {}; }
  saveSettings(s) { return this.set('settings', s); }

  exportAll() {
    const out = {};
    if (this.ls) {
      for (let i = 0; i < this.ls.length; i++) {
        const k = this.ls.key(i);
        if (k.startsWith(this.prefix)) out[k.slice(this.prefix.length)] = this.ls.getItem(k);
      }
    } else for (const [k, v] of this.mem) out[k] = v;
    return out;
  }
  eraseAll() {
    if (this.ls) {
      const keys = [];
      for (let i = 0; i < this.ls.length; i++) { const k = this.ls.key(i); if (k.startsWith(this.prefix)) keys.push(k); }
      for (const k of keys) this.ls.removeItem(k);
    } else this.mem.clear();
  }
  // What exportAll writes: an object of names and the texts kept under them, which are JSON (set).
  // Anything else (a list, a number, another program's file) is not taken, and an empty one neither.
  // One text that reads as JSON is enough: a real export is not turned away for an odd entry in it.
  isExport(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const texts = Object.values(obj);
    return texts.length > 0 && texts.every((v) => typeof v === 'string')
      && texts.some((v) => { try { JSON.parse(v); return true; } catch (e) { return false; } });
  }
  importAll(obj) {
    for (const k in obj) {
      if (typeof obj[k] !== 'string') continue;
      if (this.ls) this.ls.setItem(this.prefix + k, obj[k]); else this.mem.set(k, obj[k]);
    }
  }
}
