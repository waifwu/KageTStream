#!/usr/bin/env python3
"""Unpack an NScripter / ONScripter game folder into plain files a browser can fetch.

    python3 tools/extract.py "<path to Game folder>" [output dir, default: ./data]

What it does
  * nscript.dat   -> data/script.txt   (XOR 0x84 de-obfuscation, Shift-JIS -> UTF-8)
  * arc*.nsa      -> data/arc/...      (NSA archives; LZSS / SPB members are decompressed)
  * CD/track*.ogg -> data/cd/
  * default.ttf   -> data/default.ttf
  * Walkthrough.txt (next to the game, or in ../Extras) -> data/guide.txt
  * data/manifest.json lists every extracted file (lower-case, forward slashes).

Nothing is re-encoded: images and audio are written byte-for-byte as stored.
"""
import json
import os
import shutil
import struct
import sys


# --------------------------------------------------------------------------- bit reader
class BitReader:
    def __init__(self, data):
        self.d = data
        self.pos = 0
        self.cur = 0
        self.left = 0

    def bits(self, n):
        v = 0
        for _ in range(n):
            if self.left == 0:
                self.cur = self.d[self.pos] if self.pos < len(self.d) else 0
                self.pos += 1
                self.left = 8
            self.left -= 1
            v = (v << 1) | ((self.cur >> self.left) & 1)
        return v


# --------------------------------------------------------------------------- NSA codecs
def decode_lzss(data, out_len):
    """NScripter LZSS: 256-byte ring, 8-bit offset, 4-bit length (+2), MSB-first bits."""
    N, F = 256, 17
    ring = bytearray(N)
    r = N - F
    br = BitReader(data)
    out = bytearray()
    while len(out) < out_len:
        if br.bits(1):
            c = br.bits(8)
            out.append(c)
            ring[r] = c
            r = (r + 1) & 0xFF
        else:
            i = br.bits(8)
            j = br.bits(4)
            for k in range(j + 2):
                c = ring[(i + k) & 0xFF]
                out.append(c)
                ring[r] = c
                r = (r + 1) & 0xFF
                if len(out) >= out_len:
                    break
    return bytes(out)


def decode_spb(data):
    """NScripter SPB image -> 24-bit BMP."""
    width, height = struct.unpack('>HH', data[:4])
    pad = (4 - width * 3 % 4) % 4
    stride = width * 3 + pad
    total = stride * height + 54
    bmp = bytearray(total)
    bmp[0:2] = b'BM'
    struct.pack_into('<IHHI', bmp, 2, total, 0, 0, 54)
    struct.pack_into('<IiiHHIIiiII', bmp, 14, 40, width, height, 1, 24, 0, total - 54, 0, 0, 0, 0)
    br = BitReader(data[4:])
    n_px = width * height
    for ch in range(3):
        plane = bytearray(n_px + 4)
        count = 0
        c = br.bits(8)
        plane[count] = c
        count += 1
        while count < n_px:
            n = br.bits(3)
            if n == 0:
                for _ in range(4):
                    plane[count] = c
                    count += 1
                continue
            m = br.bits(1) + 1 if n == 7 else n + 2
            for _ in range(4):
                if m == 8:
                    c = br.bits(8)
                else:
                    k = br.bits(m)
                    if k & 1:
                        c = (c + (k >> 1) + 1) & 0xFF
                    else:
                        c = (c - (k >> 1)) & 0xFF
                plane[count] = c
                count += 1
        # planes are stored top-down in serpentine order; BMP rows are bottom-up
        p = 54 + stride * (height - 1) + ch
        s = 0
        for j in range(height):
            if j & 1:
                for _ in range(width):
                    bmp[p] = plane[s]
                    s += 1
                    p -= 3
                p -= stride - 3
            else:
                for _ in range(width):
                    bmp[p] = plane[s]
                    s += 1
                    p += 3
                p -= stride + 3
    return bytes(bmp)


def read_nsa(path):
    with open(path, 'rb') as f:
        count, base = struct.unpack('>HI', f.read(6))
        header = f.read(base - 6)
        p = 0
        entries = []
        for _ in range(count):
            e = header.index(b'\0', p)
            name = header[p:e].decode('cp932')
            p = e + 1
            comp, off, clen, ulen = struct.unpack('>BIII', header[p:p + 13])
            p += 13
            entries.append((name, comp, off, clen, ulen))
        for name, comp, off, clen, ulen in entries:
            f.seek(base + off)
            raw = f.read(clen)
            if comp == 0:
                data = raw
            elif comp == 1:
                data = decode_spb(raw)
            elif comp == 2:
                data = decode_lzss(raw, ulen)
            elif comp == 4:
                import bz2
                data = bz2.decompress(raw[4:])
            else:
                raise ValueError('unknown NSA compression %d for %s' % (comp, name))
            yield name, data


# --------------------------------------------------------------------------- main
def norm(name):
    return name.replace('\\', '/').lower()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    game = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, '..', 'data')
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    files = []

    def put(rel, data):
        rel = norm(rel)
        dst = os.path.join(out, *rel.split('/'))
        if not os.path.abspath(dst).startswith(out + os.sep):
            raise ValueError('unsafe path in archive: ' + rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(data)
        files.append(rel)

    # script
    script = None
    for cand in ('nscript.dat', '0.txt', '00.txt'):
        p = os.path.join(game, cand)
        if os.path.exists(p):
            raw = open(p, 'rb').read()
            if cand == 'nscript.dat':
                raw = bytes(b ^ 0x84 for b in raw)
            script = raw.decode('cp932', 'replace')
            break
    if script is None:
        print('no nscript.dat / 0.txt found in', game)
        return 1
    put('script.txt', script.replace('\r\n', '\n').replace('\r', '\n').encode('utf-8'))
    print('script: %d lines' % script.count('\n'))

    # archives (arc.nsa first, later archives override earlier ones like the engine's search order)
    names = sorted(n for n in os.listdir(game) if n.lower().endswith('.nsa'))
    for n in reversed(names):
        cnt = 0
        for name, data in read_nsa(os.path.join(game, n)):
            rel = 'arc/' + norm(name)
            if rel in files:
                continue
            put(rel, data)
            cnt += 1
        print('%s: %d files' % (n, cnt))

    # loose files next to the executable take priority over archives
    for root, _dirs, fnames in os.walk(game):
        for fn in fnames:
            ext = fn.lower().rsplit('.', 1)[-1]
            full = os.path.join(root, fn)
            rel = norm(os.path.relpath(full, game))
            if rel.startswith('cd/') and ext in ('ogg', 'mp3', 'wav'):
                put(rel, open(full, 'rb').read())
            elif ext in ('jpg', 'jpeg', 'bmp', 'png', 'wav', 'ogg', 'mp3') and not rel.startswith('cd/'):
                put('arc/' + rel, open(full, 'rb').read())
    # the walkthrough, if the copy came with one: the game's optional guide reads it
    for cand in (os.path.join(game, 'Walkthrough.txt'), os.path.join(game, 'Extras', 'Walkthrough.txt'),
                 os.path.join(game, '..', 'Extras', 'Walkthrough.txt')):
        if os.path.exists(cand):
            raw = open(cand, 'rb').read()
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = raw.decode('cp1252', 'replace')
            put('guide.txt', text.replace('\r\n', '\n').encode('utf-8'))
            print('walkthrough: copied')
            break

    ttf = os.path.join(game, 'default.ttf')
    if os.path.exists(ttf):
        shutil.copyfile(ttf, os.path.join(out, 'default.ttf'))
        files.append('default.ttf')

    files = sorted(set(files))
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump({'files': files}, f)
    print('wrote %d files to %s' % (len(files), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
