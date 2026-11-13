// Boot: load the extracted game data, show the opening page, wire the engine to the shell.
import { Engine } from './engine.js';
import { Gfx, Loader, W, H } from './gfx.js';
import { TextLayer, FONTS, setStoryFont } from './text.js';
import { AudioSys } from './audio.js';
import { Input } from './input.js';
import { Storage } from './storage.js';
import { UI } from './ui.js';
import { Shell, h } from './shell.js';
import { bgOverride, hideSprite } from './skins.js';
import { Guide, choiceTranslator, choiceBack } from './guide.js';
import { setLang, t } from './i18n.js';

const DATA = 'data/';
const LANGUAGES = [['English', 'en'], ['\u65e5\u672c\u8a9e', 'ja']];

// What the Japanese script calls its scenes. Each says so in the question it asks before a re-read
// ("ここは、「学校・昼休み～食堂。…」のシーンです。"): the place before the first "・", then the name.
function sceneNames(src) {
  const out = new Map();
  const re = /^[ \t]*\*(s\d+)\b[^\n]*\n(?:(?![ \t]*\*)[^\n]*\n){0,10}?[ \t\u3000;]*ここは_?、「(.*?)_?」のシーンです/gm;
  for (const m of src.matchAll(re)) {
    const title = m[2].replace(/_/g, '');
    const cut = title.indexOf('・');
    out.set(m[1].toLowerCase(), cut > 0 && cut <= 8 ? { zone: title.slice(0, cut), name: title.slice(cut + 1) } : { zone: '', name: title });
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => (document.hidden ? setTimeout(r, 16) : requestAnimationFrame(() => r())));

const CONTROLS = [
  ['Click, tap, Enter, Space', 'Go on to the next line, or take what is pointed at.'],
  ['Right-click, two-finger tap, Esc', 'The menu: save, load, history, flowchart, guide, settings, title.'],
  ['Wheel up, ↑, PageUp', 'Text history. Scroll past its end to return.'],
  ['Ctrl, or a finger, held down', 'Fast-forward for as long as it is held.'],
  ['S', 'Fast-forward on and off. It stops at a choice; a click stops it too.'],
  ['A', 'Let the story advance by itself.'],
  ['1, 2, 3', 'Text speed: slow, normal, fast.'],
  ['M, F', 'Mute, fullscreen.'],
  ['Top edge', 'The quick bar appears while the story waits for you. On a touch screen, tap the small moon at the corner.'],
];

// The desktop program (desktop/main.js) serves these same pages over its own scheme. It is only the
// game: there the opening page is passed over, and the story begins as the window opens.
const DESKTOP = location.protocol === 'app:';
const RELEASES = 'https://github.com/waifwu/KageTStream/releases';

// A phone. The controls are a mouse's and a keyboard's, and the stage is scaled to the window as
// a whole, so on a phone the picture is a few centimetres across and the pages' lettering too
// small to read. The reader is asked, before anything else, to play on a desktop or PC instead. It is a request and not a lock: "Continue
// anyway" lets them in. The notice stands outside the stage, which would make it as small as
// the rest (css/shell.css, #phone-note).
const onPhone = () => {
  if (DESKTOP) return false;
  const coarse = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return /Mobi|iPhone|iPod/i.test(navigator.userAgent) || (coarse && Math.min(window.screen.width, window.screen.height) < 600);
};
function phoneNotice() {
  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = t(text);
    return e;
  };
  const box = make('div');
  box.id = 'phone-note';
  box.setAttribute('role', 'alertdialog');
  const card = make('div', 'card paper');
  card.appendChild(make('h1', null, 'For desktop or PC only'));
  card.appendChild(make('p', null, 'Please do not play this on a phone or another mobile device. The controls are built for a mouse and a keyboard, not for a touch screen, and the picture and the text come out too small to read.'));
  card.appendChild(make('p', null, 'Open it on a desktop or PC instead.'));
  const go = make('button', null, 'Continue anyway');
  go.addEventListener('click', () => box.remove());
  card.appendChild(go);
  box.appendChild(card);
  document.body.appendChild(box);
}

async function boot() {
  const shell = new Shell();
  const canvas = document.getElementById('screen');
  const autostart = DESKTOP || new URLSearchParams(location.search).has('autostart');

  // -------------------------------------------------------------- data
  // The story runs from one script. Where the data also holds the Japanese one (script-ja.txt,
  // see tools/extract.py --ja) Settings offers the choice, and `lang` is the one in use. The English
  // script is read either way: the flowchart, the track names and the guide are made from it, so
  // those pages are the same in both languages.
  let manifest = null, script = null, refScript = null, lang = 'en', failed = false, guideText = '';
  const loading = (async () => {
    try {
      const [m, s] = await Promise.all([fetch(DATA + 'manifest.json'), fetch(DATA + 'script.txt')]);
      if (!m.ok || !s.ok) throw new Error('missing');
      manifest = await m.json();
      script = refScript = await s.text();
      if (settings.lang === 'ja' && manifest.files.includes('script-ja.txt')) {
        try {
          const j = await fetch(DATA + 'script-ja.txt');
          if (j.ok) { script = await j.text(); lang = 'ja'; }
        } catch (e) { /* the English script stands */ }
      }
      if (manifest.files.includes('guide.txt')) {
        try { const g = await fetch(DATA + 'guide.txt'); if (g.ok) guideText = await g.text(); } catch (e) { /* no guide */ }
      }
      try {
        const font = new FontFace('NSFont', 'url(' + DATA + 'default.ttf)');
        document.fonts.add(await font.load());
      } catch (e) { console.warn('default.ttf could not be loaded; using a system font', e); }
    } catch (e) { failed = true; }
  })();

  const storage = new Storage('nsweb:game:');
  const settings = Object.assign({ muted: false, speed: 1, autoPace: 1, bgmVol: 1, seVol: 1, ambient: true, ambientWide: false, wide: false, font: 'original', flowAll: false, flowHints: false }, storage.loadSettings());
  // The picture at the game's own 4:3, or at 16:9 with nothing bare at its sides. The stage takes
  // its shape at once, the opening page with it; the game's picture when it is made (below).
  // The glow around the picture is kept for each shape by itself: on at 4:3, where it softens the
  // bare sides of a wide window, and off at 16:9 until the reader turns it on there.
  const glowKey = () => (settings.wide ? 'ambientWide' : 'ambient');
  let applyWide = () => { shell.setWide(settings.wide); shell.setAmbient(settings[glowKey()]); };
  // 16:9 fills the screen by cutting into the pictures: the reader is told so before it is taken
  // (it is what they asked for, so "Yes" is the answer pointed at)
  const confirmWide = async () => (await shell.ask('Switch the picture to 16:9?',
    'Backgrounds and event pictures are enlarged to fill the screen, so some of them are cut off at the top and the bottom. '
    + 'The Gallery still shows every picture whole, and 4:3 can be chosen again at any time.', undefined, 0)) === true;
  shell.setWide(settings.wide);
  // The interface speaks the story's language. The setting is known at once; whether the data
  // really holds the Japanese script is known when it has loaded, and is put right then.
  const wording = (l) => {
    setLang(l);
    document.documentElement.lang = l;
    // the parts of the page that are written in index.html
    for (const n of document.querySelectorAll('#quickbar .plate, #modes .chip, #qb-handle')) {
      for (const c of n.childNodes) if (c.nodeType === 3 && c.data.trim()) { n.dataset.en = n.dataset.en || c.data.trim(); c.data = t(n.dataset.en); }
      for (const a of ['title', 'aria-label']) {
        if (!n.hasAttribute(a)) continue;
        const key = 'en' + a.replace('-', '');
        n.dataset[key] = n.dataset[key] || n.getAttribute(a);
        n.setAttribute(a, t(n.dataset[key]));
      }
    }
  };
  wording(settings.lang === 'ja' ? 'ja' : 'en');
  if (onPhone()) phoneNotice();
  const applyFont = () => {
    if (!FONTS[settings.font]) settings.font = 'original';
    setStoryFont(settings.font);
    document.documentElement.style.setProperty('--story-font', FONTS[settings.font].stack);
  };
  applyFont();
  // until the game is running the glow comes from the opening page's picture
  const homeArt = new Image();
  homeArt.src = DATA + 'arc/image/gamestart/load.jpg';
  shell.ambientSource = () => (homeArt.complete && homeArt.naturalWidth ? homeArt : null);
  shell.setAmbient(settings[glowKey()]);

  // -------------------------------------------------------------- opening page
  let ready = false;
  let start = () => {};
  // Everything kept here (saves, progress, settings) as one file, and back again. Both are offered
  // on the opening page and in Settings, so they are at hand where there is no opening page.
  const exportSaves = () => {
    const blob = new Blob([JSON.stringify(storage.exportAll())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kagetsu-tohya-saves.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  let replaced = false;       // the store was just filled from a file: nothing in memory is written over it
  const saveCount = () => {
    let n = 0;
    for (let i = 1; i <= 20; i++) if (storage.loadSlot(i)) n++;
    return n;
  };
  const tabs = [
    { plate: 'About', build(p) {
      h.head(p, 'What this is');
      h.p(p, 'Kagetsu Tohya, playing in a web browser. A small engine written in JavaScript reads the game’s own script, pictures, sound and music as they are in your copy; nothing in them was rewritten or re-encoded.');
      h.p(p, 'An unofficial fan project, not affiliated with TYPE-MOON. Please support the official release.', 'fine');
      h.link(p, 'The source is on GitHub:', 'github.com/waifwu/KageTStream', 'https://github.com/waifwu/KageTStream');
      h.head(p, 'How it was taken apart');
      h.rows(p, [
        ['The program', 'ONScripter-EN, an open reimplementation of NScripter. Its behaviour was followed from its public source.'],
        ['The script', 'One file of about 72,000 lines, hidden by a single XOR. It is run as written.'],
        ['The archives', 'Two NSA archives holding 1,194 pictures and sound effects.'],
        ['The music', 'Seventeen tracks, which the script asks for by number.'],
      ]);
      h.head(p, 'What is new here');
      h.rows(p, [
        ['The menus', 'The title, Start game and each story\u2019s page are redrawn to match one another. The script still decides what every entry does and what is unlocked.'],
        ['Gallery', 'On the title, in place of End game: the game\u2019s four picture galleries in one place, the flowchart, the guide, and a music player for the tracks you have heard in the story.'],
        ['Flowchart', 'Drawn from the script\u2019s own flow and laid out by place and time. It shows what you have reached; choosing a scene lights the ways to it and on from it, and hints, if you turn them on, say how to reach the rest.'],
        ['Guide', 'Optional, and off until you turn it on. It follows the walkthrough that came with the copy, one day at a time, and marks the choice to take.'],
        ['Settings', 'One page for everything: the story\u2019s font, text speed, sound, and the game\u2019s own four switches.'],
        ['Saves', 'Twenty slots with a picture and a line of the page, kept in this browser.'],
        ['History', 'Everything read this session, as one scroll.'],
        ['16:9', 'An option, on the Play page and in Settings: the picture fills a wide screen, with nothing bare at its sides. Backgrounds are enlarged to fit, so some are cut off at the top and the bottom; the title and every menu are laid out for the wider shape.'],
      ]);
    } },
    { plate: 'Controls', build(p) {
      h.head(p, 'Mouse, keyboard and touch');
      h.rows(p, CONTROLS);
    } },
    { plate: 'Save data', build(p) {
      h.head(p, 'Kept in this browser');
      // scenes read: the script marks the end of each scene with a label "se<N>", and the engine keeps the labels passed
      const g = storage.loadGlobals();
      const read = g && g.labelLog ? g.labelLog.filter((l) => /^se\d+$/.test(l)).length : 0;
      h.facts(p, [[String(saveCount()), 'saves of 20'], [String(read), read === 1 ? 'scene read' : 'scenes read']]);
      h.p(p, 'Saves, progress and settings live in this browser, for this address. Clearing the site’s data removes them, and another browser starts empty, so a file is the way to carry them across or to keep a copy.');
      h.actions(p, [
        ['Export to a file', () => exportSaves()],
        ['Import from a file', () => document.getElementById('import-file').click()],
        ['Erase everything', async () => {
          if (await shell.confirm('Erase every save and all progress?', 'This cannot be undone.')) { storage.eraseAll(); location.reload(); }
        }, 'warn'],
      ]);
    } },
    // The game as a program (desktop/), for those who would rather keep it than visit it.
    { plate: 'Download', build(p) {
      h.head(p, 'The game as a program');
      h.p(p, 'The same port in a window of its own, with every file inside it: about 330 MB, and it plays with no connection.');
      h.downloads(p, [
        ['Windows', 'Kagetsu-Tohya-Setup.exe', RELEASES + '/latest/download/Kagetsu-Tohya-Setup.exe'],
        ['macOS · Apple silicon', 'Kagetsu-Tohya-mac-arm64.dmg', RELEASES + '/latest/download/Kagetsu-Tohya-mac-arm64.dmg'],
        ['macOS · Intel', 'Kagetsu-Tohya-mac-x64.dmg', RELEASES + '/latest/download/Kagetsu-Tohya-mac-x64.dmg'],
        ['Linux · x86-64', 'Kagetsu-Tohya-linux-x86_64.AppImage', RELEASES + '/latest/download/Kagetsu-Tohya-linux-x86_64.AppImage'],
      ]);
      h.p(p, 'The programs are not signed, so each system asks once. Windows: “More info”, then “Run anyway”. macOS: open it once, then allow it under System Settings, Privacy & Security, “Open Anyway”.', 'fine');
      h.p(p, 'Linux: allow the file to run as a program (in its Properties, or chmod +x), then open it. On Ubuntu 22.04 and later, install the libfuse2 package first.', 'fine');
      h.p(p, 'It opens straight into the game, and keeps its saves apart from this browser’s. Settings has Save data: export to a file here, import it there, or the other way.', 'fine');
      h.link(p, 'Every version is on GitHub:', 'github.com/waifwu/KageTStream/releases', RELEASES);
    } },
    { plate: 'Play', build(p) {
      p.classList.add('hm-play');        // "press any button" stands in the middle of the space below
      h.head(p, 'Play here, in the browser');
      h.p(p, 'Nothing to install. The game’s files arrive as you play, and the day you are on is saved by itself each time it ends.');
      if (failed) h.p(p, 'The game data was not found. Run  python3 tools/extract.py "<path to the Game folder>"  and reload.', 'fine');
      if (manifest && manifest.files.includes('script-ja.txt')) {
        h.choice(p, 'Language', LANGUAGES, lang, (value) => {
          settings.lang = value;
          storage.saveSettings(settings);
          location.replace(location.pathname + '#play');
          location.reload();
        });
      }
      // the same switch as Settings > Picture shape, here before the game begins
      h.choice(p, 'Picture shape', [['4:3', false], ['16:9', true]], !!settings.wide, async (value) => {
        if (value && !(await confirmWide())) return;
        settings.wide = value;
        storage.saveSettings(settings);
        applyWide();
        if (shell.homeRefresh) shell.homeRefresh();
      });
      h.press(p, failed ? 'No game data' : ready ? 'press any button' : 'Loading…', ready, () => start());
      p.addEventListener('click', (e) => { if (ready && e.target === p) start(); });
    } },
  ];
  if (!autostart) {
    shell.showHome({
      art: DATA + 'arc/image/gamestart/load.jpg',
      brand: 'Tsukihime fan disc',
      title: 'Kagetsu Tohya',
      sub: 'in the browser',
      line: 'An unofficial browser port that plays the game’s own files. Choose a page above: About, Controls, Save data, or Play to begin.',
      foot: 'Unofficial · not affiliated with TYPE-MOON',
      tabs,
      onStart: () => { if (ready) start(); },
      open: location.hash === '#play' ? tabs.length - 1 : -1,     // back from changing the language there
    });
    if (location.hash === '#play') history.replaceState(null, '', location.pathname + location.search);
    shell.setHomeStatus('Loading the game’s script…');
  }
  document.getElementById('import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      storage.importAll(JSON.parse(await f.text()));
      replaced = true;
      location.reload();
    } catch (e) { shell.notice('That file is not a save export.'); }
  });

  await loading;
  if (failed) {
    shell.setHomeStatus('Game data not found — see the Play page.');
    if (shell.homeRefresh) shell.homeRefresh();
    return;
  }

  // -------------------------------------------------------------- engine
  const fitScale = Math.min(window.innerWidth / W, window.innerHeight / H);
  const scale = Math.max(1, Math.min(3, Math.ceil(fitScale * (window.devicePixelRatio || 1) - 0.25)));
  storage.slotPrefix = lang === 'ja' ? 'ja:' : '';
  wording(lang);
  if (lang === 'ja') {
    // the story's own words for what the flowchart and the walkthrough have in English
    const back = choiceBack(script, refScript);
    shell.word = (s) => back.exact(s) || s;
    shell.stepWord = (s) => back.near(s) || s;
  }
  const loader = new Loader(DATA, manifest);
  const gfx = new Gfx(canvas, loader, scale, settings.wide);
  const text = new TextLayer(gfx);
  gfx.text = text;
  gfx.bgOverride = bgOverride;      // the game's menu screens are redrawn (skins.js)
  gfx.hideSprite = hideSprite;
  gfx.onBgChange = (same) => { if (!same) shell.releaseLeaving(); };   // a real change of picture: no menu page stays over it
  const audio = new AudioSys(loader);
  audio.setMuted(settings.muted);
  audio.setVolumes(settings.bgmVol, settings.seVol);

  let engine = null;
  const saveSettings = () => storage.saveSettings(settings);
  const refresh = () => { if (engine) shell.setModes({ skip: engine.skipMode, auto: engine.autoMode }); };
  const fullscreen = (on) => {
    const is = !!document.fullscreenElement;
    if (on === undefined) on = !is;
    if (on && !is && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!on && is) document.exitFullscreen();
  };
  const actions = {
    skip() { engine.setSkip(!engine.skipMode); input.push({ type: 'wake' }); },
    auto() { engine.autoMode = !engine.autoMode; input.push({ type: 'wake' }); refresh(); shell.toast(engine.autoMode ? 'Advancing by itself.' : 'Auto off.'); },
    mute() { settings.muted = !settings.muted; audio.setMuted(settings.muted); saveSettings(); shell.toast(settings.muted ? 'Sound off.' : 'Sound on.'); },
    speed(n) { settings.speed = n; engine.textSpeedNo = n; saveSettings(); shell.toast('Text speed: ' + ['slow', 'normal', 'fast'][n] + '.'); },
    full() { fullscreen(); },
    menu() { input.push({ type: 'rclick' }); },
    log() { input.push({ type: 'sys', action: 'lookback' }); },
    save() { input.push({ type: 'sys', action: 'save' }); },
    load() { input.push({ type: 'sys', action: 'load' }); },
    hide() { input.push({ type: 'sys', action: 'windowerase' }); },
    config() { input.push({ type: 'sys', action: 'config' }); },
  };
  const onKey = (k) => {
    switch (k) {
      case 's': actions.skip(); break;
      case 'a': actions.auto(); break;
      case 'm': actions.mute(); break;
      case 'f': actions.full(); break;
      case '1': actions.speed(0); break;
      case '2': actions.speed(1); break;
      case '3': actions.speed(2); break;
      default: return false;
    }
    return true;
  };
  const input = new Input(canvas, onKey);
  shell.input = input;
  // Settings > Picture shape, changed while the game runs: the stage, the game's picture and
  // where the pointer is taken to be all follow.
  applyWide = () => {
    shell.setWide(settings.wide);
    shell.setAmbient(settings[glowKey()]);
    gfx.setWide(settings.wide);
    input.vw = gfx.VW;
    input.ox = gfx.OX;
  };
  applyWide();
  shell.syncModal();
  shell.onAction((act) => { if (actions[act]) actions[act](); });
  // a click on the picture stops fast-forward, as it does in the original engine
  canvas.addEventListener('pointerdown', () => { if (engine && engine.skipMode) { engine.setSkip(false); input.flush(); } });

  // The game's own four switches (its Options > Game settings page) are variables of the script;
  // "effects" also needs the script's routine that fills in the effect speeds.
  const gameVar = (name) => engine.numalias.get(name);
  const GAME = {
    'g:effects': { get: () => engine.getNum(gameVar('effectskip')) === 1,
      set: (on) => { engine.setNum(gameVar('effectskip'), on ? 1 : 0); engine.callSub(on ? 'velocity_effectspeed' : 'normal_effectspeed'); } },
    'g:scenes': { get: () => engine.getNum(gameVar('sceneskip')) === 1, set: (on) => engine.setNum(gameVar('sceneskip'), on ? 1 : 0) },
    'g:daily': { get: () => engine.getNum(gameVar('wordskip')) === 0, set: (on) => engine.setNum(gameVar('wordskip'), on ? 0 : 1) },
    'g:adult': { get: () => engine.getNum(gameVar('eroskip')) === 1, set: (on) => engine.setNum(gameVar('eroskip'), on ? 1 : 0) },
  };
  const onOff = [['On', true], ['Off', false]];

  // "Unlock everything" is a view laid over the reader's own progress, never a change to it. The
  // port's own pages (gallery, music player, flowchart) ask host.unlocked(). The game's Start game
  // pages are the script's: there, and only there, the flags that decide which entries are offered
  // read as set. They are stored as they really are, and the story goes on setting them, so
  // switching this off shows the reader's own progress again, with whatever was read meanwhile.
  const MENU_FLAGS = ['yume_on', 'finish_yume', 'twilight_aday', 'twilight_ep',
    ...Array.from({ length: 10 }, (_, i) => 'yume' + String(i + 1).padStart(2, '0'))];
  const applyUnlock = () => {
    const on = !!settings.unlockAll;
    shell.everything = on;
    if (!engine) return;
    const from = engine.labels.get('gamestart_menu'), to = engine.labels.get('option');
    // the script names its variables as it starts, so the flags are looked up when first needed
    let flags = null;
    engine.numOverride = on && from && to && from.off < to.off
      ? (i, v) => {
        if (v > 0 || engine.stmtStart < from.off || engine.stmtStart >= to.off) return v;
        if (!flags) flags = new Set(MENU_FLAGS.filter((n) => engine.numalias.has(n)).map((n) => engine.numalias.get(n)));
        return flags.has(i) ? 1 : v;
      }
      : null;
  };
  const openConfig = () => {
    const story = [
      { key: 'font', label: 'Story font', options: [['Original', 'original'], ['Serif', 'serif'], ['Sans', 'sans']] },
      { key: 'speed', label: 'Text speed', options: [['Slow', 0], ['Normal', 1], ['Fast', 2]] },
      { key: 'autoPace', label: 'Auto-advance pace', options: [['Slow', 0], ['Normal', 1], ['Fast', 2]] },
    ];
    if (guide.available) story.push({ key: 'guide', label: 'Guide: mark the choices to take', options: onOff });
    for (const [key, name, label] of [['g:effects', 'effectskip', 'Display effects instantly'], ['g:scenes', 'sceneskip', 'Skip parts previously read'],
      ['g:daily', 'wordskip', 'Display daily message at startup'], ['g:adult', 'eroskip', 'Skip explicit sexual content']]) {
      if (engine.numalias.has(name)) story.push({ key, label, options: onOff });
    }
    const more = [{ key: 'unlockAll', label: 'Unlock everything', options: onOff },
      { key: 'savefile', label: 'Save data', options: [['Export to a file', 'export'], ['Import from a file', 'import']] }];
    if (manifest.files.includes('script-ja.txt')) more.unshift({ key: 'lang', label: 'Language', options: LANGUAGES });
    return shell.config([
      { title: 'The story', rows: story },
      { title: 'Sound and picture', rows: [
        { key: 'bgmVol', label: 'Music', range: true },
        { key: 'seVol', label: 'Sound effects', range: true },
        { key: 'muted', label: 'Sound', options: [['On', false], ['Off', true]] },
        { key: 'wide', label: 'Picture shape', options: [['4:3', false], ['16:9', true]] },
        { key: 'ambient', label: 'Glow around the picture', options: onOff },
        { key: 'full', label: 'Fullscreen', options: onOff },
      ] },
      { title: more.length > 1 ? 'Language and progress' : 'Progress', under: true, rows: more },
    ], (key) => (GAME[key] ? GAME[key].get() : key === 'guide' ? guide.state.on : key === 'full' ? !!document.fullscreenElement
      : key === 'unlockAll' ? !!settings.unlockAll : key === 'lang' ? lang : key === 'ambient' ? !!settings[glowKey()] : settings[key]), async (key, value) => {
      if (key === 'lang') {
        if (value === lang) return;
        if (!(await shell.confirm(value === 'ja' ? 'Switch the story to Japanese?' : 'Switch the story to English?',
          'The game starts again from the opening page. What you have read, the gallery and the flowchart carry over; '
          + 'saved games are kept separately for each language, so the day in progress is not carried across.'))) return;
        settings.lang = value;
        saveSettings();
        engine.flushGlobals(true);
        location.href = location.pathname;
        return;
      }
      if (key === 'savefile') {
        if (value === 'export') {
          engine.flushGlobals(true);      // what has been read since the last write goes into the file too
          exportSaves();
        } else if (await shell.confirm('Import save data from a file?', 'What the file holds replaces what is kept here, and the game starts again.')) {
          document.getElementById('import-file').click();
        }
        return;
      }
      if (key === 'unlockAll') {
        if (!!settings.unlockAll === value) return;
        if (value && !(await shell.confirm('Unlock everything?',
          'Every scene on the flowchart, every picture and track in the Gallery, and every story on the Start game page opens. '
          + 'Your own progress is not changed and goes on being kept: turn this off again here to go back to it.'))) return;
        settings.unlockAll = value;
        applyUnlock();
        saveSettings();
        shell.toast(value ? 'Everything is unlocked.' : 'Back to your own progress.');
        return;
      }
      if (GAME[key]) { GAME[key].set(value); engine.flushGlobals(true); return; }
      if (key === 'guide') { guide.setOn(value); return; }
      if (key === 'full') { fullscreen(value); return; }
      if (key === 'wide' && value && !settings.wide && !(await confirmWide())) return;
      const fontChanged = key === 'font' && settings.font !== value;
      const shapeChanged = key === 'wide' && !!settings.wide !== value;
      settings[key === 'ambient' ? glowKey() : key] = value;
      if (fontChanged) { applyFont(); text.reflow(); gfx.present(engine.textMode); }
      if (shapeChanged) applyWide();
      engine.textSpeedNo = settings.speed;
      engine.autoPace = settings.autoPace;
      audio.setMuted(settings.muted);
      audio.setVolumes(settings.bgmVol, settings.seVol);
      shell.setAmbient(settings[glowKey()]);
      saveSettings();
    });
  };

  const ui = new UI(null);
  const host = {
    gfx, text, audio, input, storage, loader, ui, shell,
    sleep, frame, openConfig,
    unlocked: () => !!settings.unlockAll,
    refScript,                                   // the English script: the flowchart and track names are read from it
    sceneNames: lang === 'ja' ? sceneNames(script) : null,
    // the options of a choice in the walkthrough's (English) wording, for the guide
    guideTexts: lang === 'en' ? null : choiceTranslator(script, refScript),
    flowPrefs: { all: !!settings.flowAll, hints: !!settings.flowHints },
    saveFlowPrefs: () => { settings.flowAll = host.flowPrefs.all; settings.flowHints = host.flowPrefs.hints; saveSettings(); },
    yield: () => sleep(0),
    random: Math.random,
    onCaption: (c) => { document.title = c.split('//')[0].trim() || c; },
    onState: () => refresh(),
    confirmSkipCredits: () => shell.confirm('Skip the credits?'),
    onEnd: async () => {
      audio.stopBgm(500);
      shell.curtain(true);
      await sleep(700);
      location.href = location.pathname;      // back to the opening page
    },
  };
  // The optional guide (guide.js): the walkthrough, followed a day at a time. The script passes
  // "*f500" when a day begins and "*endofplay" when it ends; the opening and the epilogue are
  // days of their own and end back on the story's page or the title.
  const guide = new Guide(guideText, settings.guide, () => { settings.guide = guide.state; saveSettings(); });
  host.guide = guide;
  host.onMusic = () => ui.releaseMusic(false);
  host.onLabel = (name) => {
    if (name === 'f500') host.dayStart = Object.assign({}, engine.nums);     // the values a day begins with (for the flowchart's route)
    if (name === 'f500' || name === 'twilight_op' || name === 'twilight_ep' || /^(yume\d\d|summer_[a-z]+|yoiyumetsuki|ciel_teacher|nsweb_replay_end)$/.test(name)) ui.releaseMusic(true);
    if (!guide.on) return;
    const entry = name === 'f500' ? 'a day' : name === 'twilight_op' ? 'op' : name === 'twilight_ep' ? 'ep' : null;
    if (entry) {
      guide.beginDay(entry);
      const t = guide.today;
      if (t && !guide.lost) shell.toast('Guide: this is Day ' + t.n + ' of the walkthrough.' + (t.quiz === 'miss' ? ' In its quiz, miss a question on purpose.' : ''));
      return;
    }
    if (name === 'endofplay' || name === 'twilight' || name === 'title' || name === 'title_loop') {
      const t = guide.today, kept = guide.active && !guide.lost && t && guide.step >= t.steps.length;
      if (guide.endDay()) shell.toast(guide.finished ? 'Guide: Day ' + t.n + ' done. That was the last one.' : 'Guide: Day ' + t.n + ' done. Day ' + guide.today.n + ' is next up.');
      else if (kept === false && t && guide.state.on && name === 'endofplay') shell.toast('Guide: Day ' + t.n + ' is still next up.');
    }
  };
  ui.host = host;
  engine = new Engine(script, host);
  ui.engine = engine;
  applyUnlock();
  engine.textSpeedNo = settings.speed;
  engine.autoPace = settings.autoPace;
  window.__engine = engine; // handy for debugging from the console
  window.addEventListener('pagehide', () => { if (!replaced) engine.flushGlobals(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !replaced) engine.flushGlobals(true); });
  refresh();

  let started = false;
  start = () => {
    if (started) return;
    started = true;
    shell.ambientSource = () => gfx.screen;    // the picture as it is displayed
    audio.unlock();
    shell.closeHome();
    engine.run().catch((e) => {
      console.error(e);
      shell.notice('The engine stopped on an error.', e.message);
    });
  };
  ready = true;
  shell.setHomeStatus('');
  if (shell.homeRefresh) shell.homeRefresh();
  if (autostart) start();
}

boot();
