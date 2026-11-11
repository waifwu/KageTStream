// Save data lives in localStorage (falls back to memory if it is unavailable).

export class Storage {
  constructor(prefix) {
    this.prefix = prefix;
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
  loadGlobals() { return this.get('global'); }
  saveGlobals(g) { return this.set('global', g); }
  saveSlot(no, data) { return this.set('save' + no, data); }
  loadSlot(no) { return this.get('save' + no); }
  slotInfo(no) {
    const d = this.get('save' + no);
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
  importAll(obj) {
    for (const k in obj) {
      if (typeof obj[k] !== 'string') continue;
      if (this.ls) this.ls.setItem(this.prefix + k, obj[k]); else this.mem.set(k, obj[k]);
    }
  }
}
