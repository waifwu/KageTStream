// The desktop build: one window showing the game, from the same files the site serves.
// (js/main.js sees the app: scheme and passes over the site's opening page.)
//
// The player needs a real origin (ES modules, fetch, localStorage), so the files are served to the
// window over a private scheme, app://kagetsu/, straight from disk. The origin never changes, which
// keeps the saves in localStorage where the next launch will find them.

const { app, BrowserWindow, Menu, protocol, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const updater = require('./updater');

// Linux, run as an AppImage: Chromium's sandbox needs either a setuid helper (an AppImage cannot
// carry one) or unprivileged user namespaces, which Ubuntu 24.04 and others turn off by default.
// Without either the program would not open at all. The window only ever shows the game's own
// files from this program (other addresses are refused or handed to the real browser), so it does
// without the sandbox there.
if (process.platform === 'linux' && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

const SCHEME = 'app';
const HOST = 'kagetsu';
const ORIGIN = SCHEME + '://' + HOST;

// Packaged, the site's files sit beside the program in resources/web. From the repository they are
// the folder above this one.
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
// Only what the site itself publishes.
const PUBLISHED = /^(index\.html$|css\/|js\/|data\/)/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function plain(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// One file from ROOT. Byte ranges are answered, because the music player seeks.
async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return plain(404, 'Not found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed');

  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch (e) { return plain(400, 'Bad request'); }
  if (rel === '') rel = 'index.html';
  const file = path.resolve(ROOT, rel);
  const inside = file.startsWith(path.resolve(ROOT) + path.sep);
  if (!inside || !PUBLISHED.test(rel.replace(/\\/g, '/'))) return plain(404, 'Not found');

  let stat;
  try { stat = await fs.promises.stat(file); } catch (e) { return plain(404, 'Not found'); }
  if (!stat.isFile()) return plain(404, 'Not found');

  const headers = {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  const size = stat.size;
  let start = 0, end = size - 1, status = 200;

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));       // the last N bytes
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + size } });
    }
    status = 206;
    headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size;
  }
  headers['content-length'] = String(size === 0 ? 0 : end - start + 1);

  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status, headers });
}

// The stage is 4:3. Open as large as the screen comfortably allows, up to the stage's own 1280x960.
function firstSize() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const h = Math.max(480, Math.min(960, Math.floor((area.height - 60) / 60) * 60));
  const w = Math.min(Math.round(h * 4 / 3), area.width);
  return { width: w, height: Math.round(w * 3 / 4) };
}

let win = null;

function openWindow() {
  win = new BrowserWindow({
    ...firstSize(),
    useContentSize: true,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#000000',
    title: 'Kagetsu Tohya',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',     // no opening page to click first: the music starts with the game
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // The page's own links (the GitHub one on the About page) open in the real browser. Nothing but
  // the game is ever shown in this window.
  const outside = (target) => {
    try {
      const u = new URL(target);
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
    } catch (e) { /* not an address */ }
  };
  win.webContents.setWindowOpenHandler(({ url }) => { outside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN + '/')) return;
    event.preventDefault();
    outside(url);
  });
  // Settings' "Export to a file" arrives here as a download: ask where to keep it, starting in Documents.
  win.webContents.session.on('will-download', (event, item) => {
    item.setSaveDialogOptions({
      title: 'Export save data',
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
      filters: [{ name: 'Save data', extensions: ['json'] }],
    });
  });
  win.webContents.session.setPermissionRequestHandler((wc, permission, done) => done(permission === 'fullscreen'));

  win.loadURL(ORIGIN + '/index.html');
  win.once('ready-to-show', () => updater.start(win));
}

// The game uses its own keys (Ctrl to skip, F for fullscreen, Esc for the menu), so there is no
// menu of browser shortcuts to collide with them. macOS keeps the few entries every app has.
function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { role: 'close' }] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    setMenu();
    openWindow();
  });
}
