# android/tools/make_icon.py: draws the app's launcher icon into res/mipmap-*/ic_launcher_fg.png: Len (the HD sprite
# data/hd/arc/image/tachi/ren_t15.webp, from tools/hd.py) over the desktop icon's twilight (desktop/tools/make-icon.js),
# edge to edge. The launcher shows the middle two thirds, cut to its own shape. Needs Pillow (pip install pillow).
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SPRITE = os.path.join(HERE, '..', '..', 'data', 'hd', 'arc', 'image', 'tachi', 'ren_t15.webp')
X0, Y0, SIDE = -190, 60, 1500          # the square of the sprite (1564 x 1920) that is drawn: her head and the bow in the middle
SIZES = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
SKY = [(0, (0x24, 0x1a, 0x3c)), (.42, (0x4a, 0x34, 0x68)), (.7, (0x8a, 0x5a, 0x78)), (.9, (0xd9, 0x92, 0x4c)), (1, (0xe9, 0xa4, 0x40))]


def sky(n):
    g = Image.new('RGBA', (n, n))
    d = ImageDraw.Draw(g)
    for y in range(n):
        t = y / (n - 1)
        for (a, ca), (b, cb) in zip(SKY, SKY[1:]):
            if a <= t <= b:
                f = (t - a) / (b - a)
                d.line([(0, y), (n, y)], fill=tuple(round(ca[i] + (cb[i] - ca[i]) * f) for i in range(3)) + (255,))
                break
    return g


im = Image.open(SPRITE).convert('RGBA')
x1, y1 = X0 + SIDE, Y0 + SIDE
part = Image.new('RGBA', (SIDE, SIDE), (0, 0, 0, 0))
part.alpha_composite(im.crop((max(X0, 0), max(Y0, 0), min(x1, im.width), min(y1, im.height))), (max(0, -X0), max(0, -Y0)))
full = sky(SIDE)
full.alpha_composite(part)
for density, n in SIZES.items():
    out = os.path.join(HERE, '..', 'res', 'mipmap-' + density, 'ic_launcher_fg.png')
    full.resize((n, n), Image.LANCZOS).convert('RGB').save(out, optimize=True)
    print('wrote', os.path.relpath(out, os.path.join(HERE, '..')))
