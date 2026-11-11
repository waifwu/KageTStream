// The game's own menu screens, redrawn in the interface's style.
//
// The script stays in charge: it still shows each screen's background, defines
// its buttons (only those that are unlocked) and decides what a button does.
// What changes is how the screen is drawn. Each screen is recognised by the
// picture it gives to "btndef"; its entries are listed here with the button
// numbers the script uses, and the reader's choice goes back to the script as
// that number.
//
// The backgrounds of these screens carry their labels painted in, so they are
// replaced as they are loaded: the title keeps its picture with the strip of
// painted labels smoothed away, the others become plain paper.

const norm = (f) => f.replace(/\\/g, '/').toLowerCase();

const DREAMS = ['Good luck, Ciel-sensei', 'A Story for the Evening', 'Crimson Moon', 'Red Demon God', 'Nanako-chan SOS!',
  'Imogirisou', 'Flower of Thanatos', 'Hisui-chan, Inversion Impulse!', 'The Tohno Family Con Game', 'Dawn'];
const STORY = 'Twilight Grass Moon, Fairy Tale Princess';

const SKINS = [
  { match: /image\/title\/kagetsu_title02/, kind: 'title',
    // four entries along the foot of the picture, where the game has its own (centres, of 640).
    // Start and Resume are the script's buttons; Settings and Gallery are pages of this port,
    // standing where the game has Options (which held only the gallery and the settings) and End game.
    items: [{ no: 1, label: 'Start game', cx: 87 }, { no: 2, label: 'Resume game', cx: 253 },
      { action: 'config', label: 'Settings', cx: 401 }, { action: 'gallery', label: 'Gallery', cx: 549 }],
    secret: { no: 5, x: 360, y: 8, w: 100, h: 20 },
    note: '\u00a9 2000\u20132001 TYPE-MOON' },
  { match: /image\/gamestart\/game_selct02/, kind: 'page', title: 'Start game', back: 4,
    items: [{ no: 1, label: STORY }, { no: 2, label: 'Summer Festivals' }, { no: 3, label: 'Ten Nights of Dream' }] },
  { match: /image\/gamestart\/twilight\/twilight0[24]/, kind: 'page', title: STORY, back: 5,
    entries: { op: 1, 'a day': 2, ep: 3 },       // what the guide calls them -> the script's buttons
    items: [{ no: 1, label: 'Op' }, { no: 2, label: 'A day' }, { no: 3, label: 'Ep' }], aside: { no: 4, label: 'Help' } },
  { match: /image\/gamestart\/summer\/summer02/, kind: 'page', title: 'Summer Festivals', back: 6,
    items: ['Arcueid', 'Ciel', 'Akiha', 'Hisui', 'Kohaku'].map((label, i) => ({ no: i + 1, label })) },
  { match: /image\/gamestart\/yume\/yume02/, kind: 'page', title: 'Ten Nights of Dream', back: 11,
    items: DREAMS.map((label, i) => ({ no: i + 1, label })) },
  // "Game settings" opens this port's Settings page, which holds the game's four switches as well
  { match: /image\/option\/option02/, kind: 'page', title: 'Options', back: 3,
    items: [{ no: 1, label: 'Graphics mode' }, { no: 2, label: 'Settings', action: 'config' }] },
];

export function findSkin(btndefName) {
  if (!btndefName) return null;
  const f = norm(btndefName);
  return SKINS.find((s) => s.match.test(f)) || null;
}

const PAPER_BG = /image\/(gamestart\/(game_selct04|twilight\/twilight03|summer\/summer01|yume\/yume03)|option\/option01)/;
const TITLE_BG = /image\/title\/kagetsu_title01/;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function paintPaper(t, x, y, w, h) {
  t.fillStyle = '#efe9e9';
  t.fillRect(x, y, w, h);
  const wash = (cx, cy, r, col) => {
    const g = t.createRadialGradient(x + w * cx, y + h * cy, 0, x + w * cx, y + h * cy, w * r);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(239,233,233,0)');
    t.fillStyle = g;
    t.fillRect(x, y, w, h);
  };
  wash(0.86, 0.18, 0.5, 'rgba(228,176,176,.55)');
  wash(0.08, 0.72, 0.5, 'rgba(228,182,178,.46)');
  wash(0.44, 0.3, 0.4, 'rgba(204,205,230,.55)');
  wash(0.7, 0.88, 0.45, 'rgba(214,208,232,.5)');
}

// The title picture has its four labels and a notice painted along its foot. They are taken out of
// the painting itself, so nothing has to cover it: in that strip each pixel becomes a low quantile
// of its row over a wide span. The lettering is thin and lighter than the ground behind it, so the
// quantile lands on the ground; the ground is a soft gradient, so nothing else is lost.
function cleanTitle(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = makeCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const y0 = Math.round(h * 0.835), y1 = Math.round(h * 0.992), rows = y1 - y0;
  const id = x.getImageData(0, y0, w, rows);
  const d = id.data;
  const out = new Uint8ClampedArray(d);
  const R = Math.round(w * 0.06);
  const buf = new Uint8Array(2 * R + 1);
  // the four labels are lighter than the ground, the notice under them darker: take the ground from the other side
  const split = Math.round(h * 0.925) - y0;
  for (let y = 0; y < rows; y++) {
    const q = y < split ? 0.3 : 0.74;
    for (let ch = 0; ch < 3; ch++) {
      for (let px = 0; px < w; px++) {
        const a = Math.max(0, px - R), b = Math.min(w - 1, px + R);
        let n = 0;
        for (let k = a; k <= b; k++) buf[n++] = d[(y * w + k) * 4 + ch];
        const sub = buf.subarray(0, n);
        sub.sort();
        out[(y * w + px) * 4 + ch] = sub[Math.floor(n * q)];
      }
    }
  }
  // ease into the untouched picture over the first rows, so there is no seam
  const feather = Math.max(2, Math.round(h * 0.012));
  for (let y = 0; y < feather; y++) {
    const t = (y + 1) / (feather + 1);
    for (let i = y * w * 4, e = (y + 1) * w * 4; i < e; i++) out[i] = d[i] + (out[i] - d[i]) * t;
  }
  id.data.set(out);
  x.putImageData(id, 0, y0);
  // one soft pass over the strip, to settle the row-by-row result
  try {
    const copy = makeCanvas(w, h);
    copy.getContext('2d').drawImage(c, 0, 0);
    x.save();
    x.beginPath();
    x.rect(0, y0 + feather, w, rows - feather);
    x.clip();
    x.filter = 'blur(' + Math.max(1, Math.round(w / 400)) + 'px)';
    x.drawImage(copy, 0, 0);
    x.restore();
    x.filter = 'none';
  } catch (e) { /* no canvas filters: the strip stays as computed */ }
  return c;
}

let paper = null;
const cleaned = new Map();
// what to show in place of a background picture, or null to show it as it is
export function bgOverride(file, img) {
  const f = norm(file);
  if (PAPER_BG.test(f)) {
    if (!paper) { paper = makeCanvas(1280, 960); paintPaper(paper.getContext('2d'), 0, 0, 1280, 960); }
    return paper;
  }
  if (TITLE_BG.test(f) && img) {
    if (!cleaned.has(f)) cleaned.set(f, cleanTitle(img));
    return cleaned.get(f);
  }
  return null;
}

// label pictures the script lays over those backgrounds
export function hideSprite(file) {
  return /image\/(gamestart|gameopt)/.test(norm(file));
}
