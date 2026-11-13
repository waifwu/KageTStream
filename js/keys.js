// Which key does what. The story's input (input.js) and the interface's pages (shell.js) both ask
// here, and Settings > Controls changes the answers. An action has up to two keys; a key does one
// thing only, so giving it to another action takes it from the one that had it.
//
// A key is known by what it types, as the browser reports it ("Enter", "ArrowUp", "s"), a letter
// always in its small form: what the page shows is then what is printed on the reader's own keys,
// whatever their layout.

// [action, what the Controls page calls it, the keys it comes with]
export const ACTIONS = [
  ['confirm', 'Go on / choose', ['Enter', ' ']],
  ['menu', 'Menu / back', ['Escape', 'Backspace']],
  ['hold', 'Fast-forward while held', ['Control']],
  ['skip', 'Fast-forward on / off', ['s']],
  ['auto', 'Auto-advance on / off', ['a']],
  ['up', 'Up', ['ArrowUp', 'k']],
  ['down', 'Down', ['ArrowDown', 'j']],
  ['left', 'Left', ['ArrowLeft', 'h']],
  ['right', 'Right', ['ArrowRight', 'l']],
  ['pageup', 'Text history / page up', ['PageUp']],
  ['pagedown', 'Page down', ['PageDown']],
  ['speed0', 'Text speed: slow', ['1']],
  ['speed1', 'Text speed: normal', ['2']],
  ['speed2', 'Text speed: fast', ['3']],
  ['mute', 'Sound on / off', ['m']],
  ['full', 'Fullscreen', ['f']],
  ['save', 'Save', []],
  ['load', 'Load', []],
  ['hide', 'Hide the text', []],
  ['config', 'Settings', []],
];
export const SLOTS = 2;
const DEFAULTS = Object.fromEntries(ACTIONS.map(([a, , keys]) => [a, keys]));
const LABELS = Object.fromEntries(ACTIONS.map(([a, label]) => [a, label]));
export const actionLabel = (a) => LABELS[a] || a;

// The actions a page of the interface knows, and the key it knows each by.
const PAGE_KEY = { confirm: 'Enter', menu: 'Escape', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown' };
export const pageKeyOf = (action) => PAGE_KEY[action] || null;

// Not to be given away: the system's own keys, the locks, Tab (the pages' own way of moving on),
// and what a keyboard sends while it is composing a character.
const REFUSED = new Set(['', 'Meta', 'OS', 'Super', 'Hyper', 'ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Tab', 'Process', 'Dead', 'Unidentified', 'Compose', 'AltGraph']);
export const bindable = (key) => !REFUSED.has(key);

let map = {};        // action -> [key or '', key or '']
let byKey = new Map();

const index = () => {
  byKey = new Map();
  for (const [a] of ACTIONS) for (const k of map[a]) if (k && !byKey.has(k)) byKey.set(k, a);
};

// The keys as they are kept in the settings (nothing kept: the ones the game comes with). An action
// the settings do not name keeps its own keys, unless one of them has been given to something else.
export function setBindings(saved) {
  const taken = new Set();
  map = {};
  const fill = (a, keys) => {
    map[a] = [];
    for (let i = 0; i < SLOTS; i++) {
      const k = Array.isArray(keys) && typeof keys[i] === 'string' && bindable(keys[i]) && !taken.has(keys[i]) ? keys[i] : '';
      if (k) taken.add(k);
      map[a].push(k);
    }
  };
  const ok = saved && typeof saved === 'object';
  for (const [a] of ACTIONS) if (ok && saved[a]) fill(a, saved[a]);
  for (const [a] of ACTIONS) if (!map[a]) fill(a, DEFAULTS[a]);
  index();
}
export const bindings = () => Object.fromEntries(ACTIONS.map(([a]) => [a, map[a].slice()]));
export const isDefault = () => ACTIONS.every(([a]) => map[a].every((k, i) => k === (DEFAULTS[a][i] || '')));
export function resetBindings() { setBindings(null); }

export function keyOf(e) {
  const k = e.key;
  if (typeof k !== 'string') return '';
  return k.length === 1 ? k.toLowerCase() : k;
}
export const actionOf = (key) => byKey.get(key) || null;
export const keysOf = (action) => (map[action] || []).filter(Boolean);
export const slotsOf = (action) => (map[action] || []).slice();

// Give `key` to an action's slot. Returns the action it was taken from, if it had another.
export function assign(action, slot, key) {
  if (!map[action] || !bindable(key)) return null;
  let from = null;
  for (const [a] of ACTIONS) {
    map[a].forEach((k, i) => {
      if (k !== key || (a === action && i === slot)) return;
      map[a][i] = '';
      if (a !== action) from = a;
    });
  }
  map[action][slot] = key;
  index();
  return from;
}
export function clear(action, slot) {
  if (!map[action] || !map[action][slot]) return false;
  map[action][slot] = '';
  index();
  return true;
}

// A key as it is written on the page.
const NAMES = { ' ': 'Space', Escape: 'Esc', Control: 'Ctrl', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Delete: 'Del', Insert: 'Ins' };
export const keyName = (key) => NAMES[key] || (key.length === 1 ? key.toUpperCase() : key);
export const names = (...actions) => actions.flatMap((a) => keysOf(a).map(keyName));

// A key pressed while a page of the interface is open, as the page is to read it. The pages are
// written for the keys they came with (Enter, Esc, the arrows, PageUp and PageDown), and those go
// on working there whatever is set, so no choice of keys can leave a page that cannot be worked or
// left. A key the reader has given to one of those actions is read as that action's own key; one
// that had the action from the start is passed as it is (the pages tell some of them apart: Space
// in the music player, K and J in the text history).
export function pageKey(e) {
  const key = keyOf(e), action = actionOf(key), std = PAGE_KEY[action];
  if (!std || DEFAULTS[action].includes(key)) return e.key;
  return std;
}
