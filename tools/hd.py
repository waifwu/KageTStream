#!/usr/bin/env python3
"""HD pictures: enlarged sprites and event CGs, made into the files the player reads.

    python3 tools/hd.py "<folder of enlarged PNGs>" [quality, default 90]

The folder holds PNGs at a whole multiple of the game's size (4x from Real-ESRGAN's
realesr-animevideov3), under the paths the game's own files have in data/, with .png for .jpg:
arc/image/tachi/aki_t01a.png, chs/arc/image/event/ren_h02.png, es/arc/image/msg/ran_t01_sp.png
and so on. For each PNG that stands for a file listed in data/manifest.json it writes
data/hd/<that path>.webp:

  * a sprite some script draws with its mask (":a;": the standing pictures of image/tachi, the
    daily message's image/msg/ran_t*, the extras of image/add): colour on the left, its mask on
    the right (white = transparent), made one picture half as wide whose transparency is the mask,
    taken as the engine takes it (js/gfx.js, buildSprite: 255 minus the mask's blue);
  * any other picture (the CGs of image/event) as it is, for "bg".

and data/hd/index.json: {"scale": 4, "alpha": [...], "plain": [...]}, the data/ paths that have
an HD file (alpha: the masked sprites, plain: the rest). The player reads that list apart from
the manifest, so extracting the game again does not drop it. A WebP already newer than its PNG is
kept. Needs ffmpeg and cwebp.
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
OUT = os.path.join(DATA, 'hd')


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG: ' + path)
    return struct.unpack('>II', head[16:24])


def jpg_size(path):
    with open(path, 'rb') as f:
        d = f.read()
    i = 2
    while i < len(d) - 9:
        if d[i] != 0xFF:
            i += 1
            continue
        m = d[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', d[i + 5:i + 9])
            return w, h
        if m == 0xD8 or 0xD0 <= m <= 0xD7 or m == 0x01 or m == 0xFF:
            i += 2 if m != 0xFF else 1
            continue
        i += 2 + struct.unpack('>H', d[i + 2:i + 4])[0]
    raise ValueError('no frame header: ' + path)


def masked():
    """Every picture some script draws with its mask (":a;"), as image/... in lower case. The
    standing pictures are not all named whole (the script also joins ":a;image\\tachi\\" to a name
    it keeps in a variable), so image/tachi is taken as masked throughout (see main)."""
    out = set()
    for n in sorted(os.listdir(DATA)):
        if n.startswith('script') and n.endswith('.txt'):
            with open(os.path.join(DATA, n), encoding='utf-8', errors='replace') as f:
                out.update(m.group(1).replace('\\', '/').lower() for m in re.finditer(r'":a[^;"\n]*;([^"\n]+)"', f.read(), re.I))
    return out


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(' '.join(cmd[:2]) + ' failed: ' + (r.stderr or r.stdout).strip()[-400:])


def convert(job, quality):
    src, dst, kind = job
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    webp = ['cwebp', '-quiet', '-q', str(quality), '-m', '6', '-sharp_yuv']
    if kind == 'plain':
        run(webp + [src, '-o', dst])
        return
    # colour | mask -> one picture with the mask as its transparency (alpha kept exact)
    fd, tmp = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    try:
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-filter_complex',
             '[0]format=gbrp,split[a][b];[a]crop=iw/2:ih:0:0[c];'
             '[b]crop=iw/2:ih:iw/2:0,extractplanes=b,negate[m];[c][m]alphamerge,format=rgba',
             '-frames:v', '1', tmp])
        run(webp + ['-alpha_q', '100', tmp, '-o', dst])
    finally:
        os.remove(tmp)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    src_root = os.path.abspath(sys.argv[1])
    quality = int(sys.argv[2]) if len(sys.argv) > 2 else 90
    with open(os.path.join(DATA, 'manifest.json')) as f:
        files = set(json.load(f)['files'])
    alpha = masked()

    jobs, index, scale, skipped = [], {'alpha': [], 'plain': []}, None, []
    for root, _, names in os.walk(src_root):
        for n in sorted(names):
            if not n.lower().endswith('.png'):
                continue
            rel = os.path.relpath(os.path.join(root, n), src_root).replace(os.sep, '/').lower()
            path = rel[:-4] + '.jpg'
            # the name the scripts use: the path without its "arc/" (or "pt/arc/" and the like)
            name = path.split('arc/', 1)[-1]
            kind = 'alpha' if name.startswith('image/tachi/') or name in alpha else 'plain'
            if path not in files:
                skipped.append(rel)
                continue
            sw, sh = jpg_size(os.path.join(DATA, path))
            pw, ph = png_size(os.path.join(root, n))
            k = pw // sw
            if pw != sw * k or ph != sh * k or k < 2:
                sys.exit('%s: %dx%d is not a whole multiple of the game\'s %dx%d' % (rel, pw, ph, sw, sh))
            if scale is None:
                scale = k
            elif k != scale:
                sys.exit('%s: %dx, the others are %dx' % (rel, k, scale))
            dst = os.path.join(OUT, path[:-4] + '.webp')
            index[kind].append(path)
            src = os.path.join(root, n)
            if not (os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)):
                jobs.append((src, dst, kind))

    if not index['alpha'] and not index['plain']:
        sys.exit('no enlarged pictures of data/ found under ' + src_root)
    print('%d masked sprites, %d other pictures at %dx; %d to convert' % (len(index['alpha']), len(index['plain']), scale, len(jobs)))
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for k, _ in enumerate(pool.map(lambda j: convert(j, quality), jobs), 1):
            if k % 50 == 0 or k == len(jobs):
                print('  %d / %d' % (k, len(jobs)))
    for v in index.values():
        v.sort()
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump({'scale': scale, 'alpha': index['alpha'], 'plain': index['plain']}, f)
    total = sum(os.path.getsize(os.path.join(OUT, p[:-4] + '.webp')) for v in index.values() for p in v)
    print('wrote data/hd/index.json; %d files, %.1f MB' % (sum(map(len, index.values())), total / 1048576))
    if skipped:
        print('not used (no such picture in data/): ' + ', '.join(skipped[:8]) + (' ...' if len(skipped) > 8 else ''))


if __name__ == '__main__':
    main()
