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
// `x` is the picture's context; rows y0..y1 are done. `q(row)` is the quantile for a row of the
// strip (low where the lettering is lighter than the ground, high where it is darker). The strip
// eases into the untouched picture over its first rows, or its last ones (`easeAtEnd`).
function unletter(x, w, h, y0, y1, q, easeAtEnd) {
  const rows = y1 - y0;
  const id = x.getImageData(0, y0, w, rows);
  const d = id.data;
  const out = new Uint8ClampedArray(d);
  const R = Math.round(w * 0.06);
  const buf = new Uint8Array(2 * R + 1);
  for (let y = 0; y < rows; y++) {
    const qy = q(y);
    for (let ch = 0; ch < 3; ch++) {
      for (let px = 0; px < w; px++) {
        const a = Math.max(0, px - R), b = Math.min(w - 1, px + R);
        let n = 0;
        for (let k = a; k <= b; k++) buf[n++] = d[(y * w + k) * 4 + ch];
        const sub = buf.subarray(0, n);
        sub.sort();
        out[(y * w + px) * 4 + ch] = sub[Math.floor(n * qy)];
      }
    }
  }
  // ease into the untouched picture, so there is no seam
  const feather = Math.max(2, Math.round(h * 0.012));
  for (let k = 0; k < feather; k++) {
    const y = easeAtEnd ? rows - 1 - k : k;
    const t = (k + 1) / (feather + 1);
    for (let i = y * w * 4, e = (y + 1) * w * 4; i < e; i++) out[i] = d[i] + (out[i] - d[i]) * t;
  }
  id.data.set(out);
  x.putImageData(id, 0, y0);
  // one soft pass over the strip, to settle the row-by-row result
  try {
    const copy = makeCanvas(w, h);
    copy.getContext('2d').drawImage(x.canvas, 0, 0);
    x.save();
    x.beginPath();
    x.rect(0, easeAtEnd ? y0 : y0 + feather, w, rows - feather);
    x.clip();
    x.filter = 'blur(' + Math.max(1, Math.round(w / 400)) + 'px)';
    x.drawImage(copy, 0, 0);
    x.restore();
    x.filter = 'none';
  } catch (e) { /* no canvas filters: the strip stays as computed */ }
}

// `brandToo`: the line of spaced capitals along the top goes as well (it is set again by the
// interface where the picture is made wider, see widenTitle).
function cleanTitle(img, brandToo) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = makeCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const y0 = Math.round(h * 0.835), y1 = Math.round(h * 0.992);
  // the four labels are lighter than the ground, the notice under them darker: take the ground from the other side
  const split = Math.round(h * 0.925) - y0;
  unletter(x, w, h, y0, y1, (y) => (y < split ? 0.3 : 0.74), false);
  if (brandToo) unletter(x, w, h, 0, Math.round(h * 0.075), () => 0.3, true);
  return c;
}

// The title for a 16:9 view. Enlarging it to fill would cut into its emblem, which is nearly as
// high as the picture, so it is made wider instead: the middle, where the emblem stands, is kept
// exactly as it is, and the sky and the ground at either side of it are drawn out to the new
// edges, easing from the one into the other. `src` is the cleaned picture (no lettering left in
// it to be drawn out of shape); the result is `vw` wide for every 640 of the original.
const TITLE_KEEP = [128, 512];      // the columns of 640 that hold the emblem
function widenTitle(src, vw) {
  const up = 2;                     // worked at twice the picture's size, for the easing between columns
  const sw = src.width * up, sh = src.height * up;
  const unit = sw / 640;
  const big = makeCanvas(sw, sh);
  const bx = big.getContext('2d', { willReadFrequently: true });
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(src, 0, 0, sw, sh);
  const from = bx.getImageData(0, 0, sw, sh).data;
  const ow = Math.round(vw * unit);
  const out = makeCanvas(ow, sh);
  const ox = out.getContext('2d');
  const to = ox.createImageData(ow, sh);
  const td = to.data;
  // where a column of the result comes from: one for one in the middle; at a side, `rate` of the
  // picture to each column of the result, rising to one for one over the last `blend` columns
  const keep0 = TITLE_KEEP[0] * unit, keep1 = TITLE_KEEP[1] * unit;
  const side = (ow - (keep1 - keep0)) / 2;        // columns of the result on either side of the middle
  const blend = 90 * unit;
  const run = (u, len) => {                        // u columns in from an edge, of a side holding `len` of the picture
    const rate = (len - blend / 2) / (side - blend / 2);
    if (u <= side - blend) return rate * u;
    const v = u - (side - blend);
    return rate * (side - blend) + rate * v + ((1 - rate) * v * v) / (2 * blend);
  };
  for (let X = 0; X < ow; X++) {
    let fx;
    if (X < side) fx = run(X, keep0);
    else if (X >= ow - side) fx = sw - 1 - run(ow - 1 - X, sw - keep1);
    else fx = keep0 + (X - side);
    fx = Math.max(0, Math.min(sw - 1, fx));
    const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), t = fx - x0;
    for (let y = 0; y < sh; y++) {
      const a = (y * sw + x0) * 4, b = (y * sw + x1) * 4, o = (y * ow + X) * 4;
      td[o] = from[a] + (from[b] - from[a]) * t;
      td[o + 1] = from[a + 1] + (from[b + 1] - from[a + 1]) * t;
      td[o + 2] = from[a + 2] + (from[b + 2] - from[a + 2]) * t;
      td[o + 3] = 255;
    }
  }
  ox.putImageData(to, 0, 0);
  return out;
}
// where a place on the title (x of 640) is, of 1 across a view `vw` wide: the entries and the
// secret corner are put there by the interface
export function titleX(x, vw) {
  if (vw <= 640) return x / 640;
  const side = (vw - (TITLE_KEEP[1] - TITLE_KEEP[0])) / 2;
  return (x - TITLE_KEEP[0] + side) / vw;
}

let paper = null;
const cleaned = new Map();
// What to show in place of a background picture, or null to show it as it is. The stand-in is
// drawn over the whole view, so at 16:9 (`wide`) the title is made for that shape; the paper is
// only washes of colour and is simply drawn wider.
export function bgOverride(file, img, wide) {
  const f = norm(file);
  if (PAPER_BG.test(f)) {
    if (!paper) { paper = makeCanvas(1280, 960); paintPaper(paper.getContext('2d'), 0, 0, 1280, 960); }
    return paper;
  }
  if (TITLE_BG.test(f) && img) {
    const key = f + (wide ? ':wide' : '');
    if (!cleaned.has(key)) cleaned.set(key, wide ? widenTitle(cleanTitle(img, true), 854) : cleanTitle(img));
    return cleaned.get(key);
  }
  return null;
}

// label pictures the script lays over those backgrounds
export function hideSprite(file) {
  return /image\/(gamestart|gameopt)/.test(norm(file));
}
