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
import { Guide } from './guide.js';

const DATA = 'data/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => (document.hidden ? setTimeout(r, 16) : requestAnimationFrame(() => r())));

const CONTROLS = [
  ['Click, tap, Enter, Space', 'Go on to the next line, or take what is pointed at.'],
  ['Right-click, long press, Esc', 'The menu: save, load, history, flowchart, guide, settings, title.'],
  ['Wheel up, ↑, PageUp', 'Text history. Scroll past its end to return.'],
  ['Ctrl, held', 'Fast-forward for as long as it is held.'],
  ['S', 'Fast-forward on and off. It stops at a choice; a click stops it too.'],
  ['A', 'Let the story advance by itself.'],
  ['1, 2, 3', 'Text speed: slow, normal, fast.'],
  ['M, F', 'Mute, fullscreen.'],
  ['Top edge', 'The quick bar appears while the story waits for you. On a touch screen, tap the small moon at the corner.'],
];

async function boot() {
  const shell = new Shell();
  const canvas = document.getElementById('screen');
  const autostart = new URLSearchParams(location.search).has('autostart');

  // -------------------------------------------------------------- data
  let manifest = null, script = null, failed = false, guideText = '';
  const loading = (async () => {
    try {
      const [m, s] = await Promise.all([fetch(DATA + 'manifest.json'), fetch(DATA + 'script.txt')]);
      if (!m.ok || !s.ok) throw new Error('missing');
      manifest = await m.json();
      script = await s.text();
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
  const settings = Object.assign({ muted: false, speed: 1, autoPace: 1, bgmVol: 1, seVol: 1, ambient: true, font: 'original', flowAll: false, flowHints: false }, storage.loadSettings());
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
  shell.setAmbient(settings.ambient);

  // -------------------------------------------------------------- opening page
  let ready = false;
  let start = () => {};
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
        ['Export to a file', () => {
          const blob = new Blob([JSON.stringify(storage.exportAll())], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'kagetsu-tohya-saves.json';
          a.click();
          URL.revokeObjectURL(a.href);
        }],
        ['Import from a file', () => document.getElementById('import-file').click()],
        ['Erase everything', async () => {
          if (await shell.confirm('Erase every save and all progress?', 'This cannot be undone.')) { storage.eraseAll(); location.reload(); }
        }, 'warn'],
      ]);
    } },
    { plate: 'Play', build(p) {
      h.head(p, 'Play here, in the browser');
      h.p(p, 'Nothing to install. The game’s files arrive as you play, and the day you are on is saved by itself each time it ends.');
      h.p(p, 'A browser plays no sound until the page has been clicked, so the game begins with a press.');
      if (failed) h.p(p, 'The game data was not found. Run  python3 tools/extract.py "<path to the Game folder>"  and reload.', 'fine');
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
    });
    shell.setHomeStatus('Loading the game’s script…');
  }
  document.getElementById('import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      storage.importAll(JSON.parse(await f.text()));
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
  const loader = new Loader(DATA, manifest);
  const gfx = new Gfx(canvas, loader, scale);
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
  const openConfig = () => {
    const story = [
      { key: 'font', label: 'Story font', options: [['Original', 'original'], ['Serif', 'serif'], ['Sans', 'sans']] },
      { key: 'speed', label: 'Text speed', options: [['Slow', 0], ['Normal', 1], ['Fast', 2]] },
      { key: 'autoPace', label: 'Auto-advance pace', options: [['Slow', 0], ['Normal', 1], ['Fast', 2]] },
    ];
    if (guide.available) story.push({ key: 'guide', label: 'Guide: mark the choices to take', options: onOff });
    if (['effectskip', 'sceneskip', 'wordskip', 'eroskip'].every((n) => engine.numalias.has(n))) {
      story.push(
        { key: 'g:effects', label: 'Display effects instantly', options: onOff },
        { key: 'g:scenes', label: 'Skip parts previously read', options: onOff },
        { key: 'g:daily', label: 'Display daily message at startup', options: onOff },
        { key: 'g:adult', label: 'Skip explicit sexual content', options: onOff },
      );
    }
    return shell.config([
      { title: 'The story', rows: story },
      { title: 'Sound and picture', rows: [
        { key: 'bgmVol', label: 'Music', range: true },
        { key: 'seVol', label: 'Sound effects', range: true },
        { key: 'muted', label: 'Sound', options: [['On', false], ['Off', true]] },
        { key: 'ambient', label: 'Glow around the picture', options: onOff },
        { key: 'full', label: 'Fullscreen', options: onOff },
      ] },
    ], (key) => (GAME[key] ? GAME[key].get() : key === 'guide' ? guide.state.on : key === 'full' ? !!document.fullscreenElement : settings[key]), (key, value) => {
      if (GAME[key]) { GAME[key].set(value); engine.flushGlobals(true); return; }
      if (key === 'guide') { guide.setOn(value); return; }
      if (key === 'full') { fullscreen(value); return; }
      const fontChanged = key === 'font' && settings.font !== value;
      settings[key] = value;
      if (fontChanged) { applyFont(); text.reflow(); gfx.present(engine.textMode); }
      engine.textSpeedNo = settings.speed;
      engine.autoPace = settings.autoPace;
      audio.setMuted(settings.muted);
      audio.setVolumes(settings.bgmVol, settings.seVol);
      shell.setAmbient(settings.ambient);
      saveSettings();
    });
  };

  const ui = new UI(null);
  const host = {
    gfx, text, audio, input, storage, loader, ui, shell,
    sleep, frame, openConfig,
    flowPrefs: { all: !!settings.flowAll, hints: !!settings.flowHints },
    saveFlowPrefs: () => { settings.flowAll = host.flowPrefs.all; settings.flowHints = host.flowPrefs.hints; saveSettings(); },
    yield: () => sleep(0),
    random: Math.random,
    onCaption: (c) => { document.title = c.split('//')[0].trim() || c; },
    onState: () => refresh(),
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
  engine.textSpeedNo = settings.speed;
  engine.autoPace = settings.autoPace;
  window.__engine = engine; // handy for debugging from the console
  window.addEventListener('pagehide', () => engine.flushGlobals(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) engine.flushGlobals(true); });
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
