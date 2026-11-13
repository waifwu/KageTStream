// Updates. A few seconds after the window opens the program asks the GitHub releases page whether
// there is a newer version, and if there is it fetches it in the background and puts it in when the
// game is closed (or at once, if the player says so).
//
//   Windows, installed with the Setup program   electron-updater: the new Setup runs silently on quit.
//   Linux, run as an AppImage                    electron-updater: the AppImage file is replaced on quit.
//   macOS                                        our own: see below.
//   anything else (the Windows zip, a Mac copy   only says that a new version is out and offers the
//   run from the disk image or from somewhere    download page. Once per version.
//   it cannot write to)
//
// macOS: electron-updater hands the install to Squirrel.Mac, which takes an update only if it carries
// the same Developer ID signature as the program running. These builds are signed ad hoc (README,
// Desktop program), so it would refuse every one. Instead the release's mac .zip is fetched, checked
// against the sha512 in latest-mac.yml, unpacked beside the saves, and once the program has quit a
// small shell script moves the old .app aside, the new one into its place, and throws the old away
// (or puts it back if the move failed).
//
// Each release must carry latest.yml, latest-mac.yml and latest-linux.yml with the files they name,
// under a tag the releases page marks Latest (README, Releasing an update).
//
// KAGETSU_UPDATE_URL=http://host/dir/ points every platform at a plain folder holding those files
// instead, to try a release before it is published.

const { app, dialog, net, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const OWNER = 'waifwu';
const REPO = 'KageTStream';
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;
const OVERRIDE = process.env.KAGETSU_UPDATE_URL || '';

let win = null;
let started = false;
let logFile = null;
let macPending = null;            // { app: path of the unpacked new .app, version }
let macRelaunch = false;

function log(level, ...parts) {
  const line = new Date().toISOString() + ' ' + level + ' ' + parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ') + '\n';
  try { fs.appendFileSync(logFile, line); } catch (e) { /* nowhere to write: nothing to be done */ }
}
const logger = { info: (...a) => log('info', ...a), warn: (...a) => log('warn', ...a), error: (...a) => log('error', ...a), debug: () => {} };

// ------------------------------------------------------------------ which kind of update this copy can take
function macBundle() {
  return path.resolve(process.execPath, '..', '..', '..');       // .../Kagetsu Tohya.app/Contents/MacOS/Kagetsu Tohya
}

function writable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (e) { return false; }
}

function mode() {
  if (!app.isPackaged) return 'notify';       // run from the repository: the "program" is Electron itself
  if (process.platform === 'win32') {
    // the Setup program leaves its uninstaller beside the program; the zip has none
    const dir = path.dirname(process.execPath);
    const installed = fs.readdirSync(dir).some((f) => /^Uninstall .*\.exe$/i.test(f));
    return installed ? 'replace' : 'notify';
  }
  if (process.platform === 'linux') {
    return process.env.APPIMAGE && writable(process.env.APPIMAGE) && writable(path.dirname(process.env.APPIMAGE)) ? 'replace' : 'notify';
  }
  if (process.platform === 'darwin') {
    const bundle = macBundle();
    // opened straight from the disk image, or from Downloads without being moved (macOS then runs
    // it from a read-only copy elsewhere): there is no .app of the player's to replace
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return 'notify';
    return writable(bundle) && writable(path.dirname(bundle)) ? 'mac' : 'notify';
  }
  return 'notify';
}

// ------------------------------------------------------------------ asking the player
const parent = () => (win && !win.isDestroyed() ? win : undefined);

async function readyPrompt(version, restart) {
  const { response } = await dialog.showMessageBox(...[parent()].filter(Boolean), {
    type: 'info',
    buttons: ['Later', 'Restart now'],
    defaultId: 0,                 // Enter and Space advance the story: a stray one must not restart it
    cancelId: 0,
    message: 'Kagetsu Tohya ' + version + ' is ready',
    detail: 'It will be installed when you close the game. Restarting now leaves the scene you are in, '
      + 'so save first if you want to come back to this point.',
  });
  if (response === 1) restart();
}

function statePath() { return path.join(app.getPath('userData'), 'update-state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}

async function notifyPrompt(version) {
  const state = readState();
  if (state.told === version) return;
  try { fs.writeFileSync(statePath(), JSON.stringify({ ...state, told: version })); } catch (e) { /* asked again next time */ }
  const { response } = await dialog.showMessageBox(...[parent()].filter(Boolean), {
    type: 'info',
    buttons: ['Later', 'Download'],
    defaultId: 0,
    cancelId: 0,
    message: 'Kagetsu Tohya ' + version + ' is out',
    detail: 'This copy cannot update itself (you are on ' + app.getVersion() + '). '
      + 'The download page has the new version; your saves stay where they are.',
  });
  if (response === 1) shell.openExternal(RELEASES + '/latest');
}

// ------------------------------------------------------------------ macOS
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(cmd + ': ' + (stderr || err.message))) : resolve(stdout)));
  });
}

async function macFetch(info) {
  const want = '-' + process.arch + '.zip';
  const file = (info.files || []).find((f) => f.url.endsWith(want));
  if (!file) throw new Error('latest-mac.yml names no ' + want);
  const base = OVERRIDE ? OVERRIDE.replace(/\/?$/, '/') : RELEASES + '/download/' + info.tag + '/';
  const url = new URL(file.url, base).href;

  const root = path.join(app.getPath('userData'), 'pending-update');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const zip = path.join(root, 'update.zip');

  logger.info('downloading', url);
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error('download failed: HTTP ' + res.status + ' for ' + url);
  const hash = crypto.createHash('sha512');
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, fs.createWriteStream(zip));
  const got = hash.digest('base64');
  if (got !== file.sha512) throw new Error('sha512 mismatch for ' + file.url);

  const out = path.join(root, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
  fs.rmSync(zip, { force: true });
  const name = fs.readdirSync(out).find((f) => f.endsWith('.app'));
  if (!name) throw new Error('no .app in ' + file.url);
  const fresh = path.join(out, name);
  const plist = fs.readFileSync(path.join(fresh, 'Contents', 'Info.plist'), 'utf8');
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  if (!m || m[1] !== info.version) throw new Error('unpacked .app says ' + (m && m[1]) + ', expected ' + info.version);
  logger.info('ready', fresh);
  return fresh;
}

// Runs after the program has quit: waits for it to be gone, swaps the bundles, and opens the new
// one if asked. If the new one cannot be moved in, the old one goes back where it was.
const SWAP = `
pid="$1"; old="$2"; new="$3"; relaunch="$4"
n=0
while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n+1)); done
bak="$(dirname "$old")/.$(basename "$old").previous"
rm -rf "$bak"
if mv "$old" "$bak"; then
  if mv "$new" "$old"; then rm -rf "$bak"; else mv "$bak" "$old"; fi
fi
rm -rf "$(dirname "$new")"
[ "$relaunch" = 1 ] && open "$old"
`;

function macSwapOnQuit() {
  if (!macPending) return;
  const { app: fresh } = macPending;
  macPending = null;
  logger.info('swapping in', fresh, macRelaunch ? '(and reopening)' : '');
  const child = spawn('/bin/sh', ['-c', SWAP, 'sh', String(process.pid), macBundle(), fresh, macRelaunch ? '1' : '0'],
    { detached: true, stdio: 'ignore' });
  child.unref();
}

// ------------------------------------------------------------------ start
function start(window) {
  win = window;
  if (started || (!app.isPackaged && !OVERRIDE)) return;
  started = true;
  logFile = path.join(app.getPath('userData'), 'updater.log');
  try { if (fs.statSync(logFile).size > 256 * 1024) fs.rmSync(logFile); } catch (e) { /* none yet */ }

  const how = mode();
  logger.info('version', app.getVersion(), 'on', process.platform, process.arch, '- mode', how, OVERRIDE ? '- feed ' + OVERRIDE : '');

  autoUpdater.logger = logger;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.setFeedURL(OVERRIDE ? { provider: 'generic', url: OVERRIDE } : { provider: 'github', owner: OWNER, repo: REPO });
  autoUpdater.autoDownload = how === 'replace';
  autoUpdater.autoInstallOnAppQuit = how === 'replace';
  autoUpdater.on('error', (e) => logger.error('updater', e));

  if (how === 'replace') {
    autoUpdater.on('update-downloaded', (info) => {
      readyPrompt(info.version, () => autoUpdater.quitAndInstall(true, true));
    });
  }
  if (how === 'mac') {
    app.on('will-quit', macSwapOnQuit);
    // a download left half-done by an earlier run
    fs.rmSync(path.join(app.getPath('userData'), 'pending-update'), { recursive: true, force: true });
  }

  const check = async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) { logger.info('up to date'); return; }
      const info = result.updateInfo;
      logger.info('found', info.version);
      if (how === 'notify') return notifyPrompt(info.version);
      if (how === 'mac') {
        macPending = { app: await macFetch(info), version: info.version };
        return readyPrompt(info.version, () => { macRelaunch = true; app.quit(); });
      }
      // 'replace': electron-updater is downloading; update-downloaded asks the player. A failed
      // download has already been logged through the 'error' event; it is tried again next launch.
      if (result.downloadPromise) result.downloadPromise.catch(() => {});
    } catch (e) {
      logger.error('check', e);
    }
  };
  setTimeout(check, 5000);
}

module.exports = { start };
