// Draws the program's icon: the interface's small moon over its twilight field.
// Run with `npm run icon`; writes build/icon.png (macOS, Linux) and build/icon-win.png (Windows).

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;

// `inset` is the margin macOS icons keep around the plate; Windows icons run to the edge.
function svg(inset, radius) {
  const side = SIZE - inset * 2;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#241a3c"/>
      <stop offset=".42" stop-color="#4a3468"/>
      <stop offset=".7" stop-color="#8a5a78"/>
      <stop offset=".9" stop-color="#d9924c"/>
      <stop offset="1" stop-color="#e9a440"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".46" r=".5">
      <stop offset="0" stop-color="#f8eedb" stop-opacity=".34"/>
      <stop offset="1" stop-color="#f8eedb" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="moon" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbf3df"/>
      <stop offset="1" stop-color="#f4cf7c"/>
    </linearGradient>
    <clipPath id="plate"><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}"/></clipPath>
    <mask id="crescent">
      <circle cx="512" cy="478" r="236" fill="#fff"/>
      <circle cx="418" cy="430" r="212" fill="#000"/>
    </mask>
  </defs>
  <g clip-path="url(#plate)">
    <rect width="${SIZE}" height="${SIZE}" fill="url(#sky)"/>
    <circle cx="512" cy="478" r="430" fill="url(#glow)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#moon)" mask="url(#crescent)"/>
  </g>
  <rect x="${inset + 3}" y="${inset + 3}" width="${side - 6}" height="${side - 6}" rx="${radius - 3}" fill="none" stroke="#f8eedb" stroke-opacity=".16" stroke-width="6"/>
</svg>`;
}

async function draw(win, markup, out) {
  const page = '<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">' + markup + '</body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG());
  console.log('wrote', path.relative(process.cwd(), out));
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, useContentSize: true, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await draw(win, svg(100, 185), path.join(dir, 'icon.png'));
  await draw(win, svg(0, 200), path.join(dir, 'icon-win.png'));
  app.quit();
});
