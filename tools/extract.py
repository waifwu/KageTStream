#!/usr/bin/env python3
"""Unpack an NScripter / ONScripter game folder into plain files a browser can fetch.

    python3 tools/extract.py "<path to Game folder>" [output dir, default: ./data]
    python3 tools/extract.py --ja "<Japanese nscript.dat, its folder, or the disc image (.bin/.cue/.iso)>"

The second form adds the Japanese script to the data that is already there (it can also be
given together with the first). With it the player offers a language switch.

What it does
  * nscript.dat   -> data/script.txt   (XOR 0x84 de-obfuscation, Shift-JIS -> UTF-8)
  * arc*.nsa      -> data/arc/...      (NSA archives; LZSS / SPB members are decompressed)
  * CD/track*.ogg -> data/cd/
  * default.ttf   -> data/default.ttf
  * Walkthrough.txt (next to the game, or in ../Extras) -> data/guide.txt
  * --ja <source> -> data/script-ja.txt (the same de-obfuscation; read straight off a disc image)
  * data/manifest.json lists every extracted file (lower-case, forward slashes).

Nothing is re-encoded: images and audio are written byte-for-byte as stored.
"""
import json
import os
import re
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


def iso_files(path):
    """Yields (name, read) for every file of an ISO9660 disc image: a plain .iso, or a raw
    .bin of 2352-byte sectors (mode 1 or mode 2 form 1)."""
    f = open(path, 'rb')
    for size, skip in ((2352, 24), (2352, 16), (2048, 0)):
        f.seek(16 * size + skip)
        if f.read(6)[1:6] == b'CD001':
            break
    else:
        raise ValueError('not an ISO9660 disc image: ' + path)

    def read(lba, length):
        out = bytearray()
        while len(out) < length:
            f.seek(lba * size + skip)
            out += f.read(2048)
            lba += 1
        return bytes(out[:length])

    def walk(lba, length, prefix):
        data = read(lba, length)
        i = 0
        while i < len(data):
            n = data[i]
            if n == 0:                      # records do not cross a sector: on to the next one
                i = (i // 2048 + 1) * 2048
                continue
            rec = data[i:i + n]
            i += n
            name = rec[33:33 + rec[32]]
            if name in (b'\x00', b'\x01'):
                continue
            e_lba, e_len = struct.unpack_from('<I', rec, 2)[0], struct.unpack_from('<I', rec, 10)[0]
            name = prefix + name.decode('cp932', 'replace').split(';')[0]
            if rec[25] & 2:
                yield from walk(e_lba, e_len, name + '/')
            else:
                yield name, (lambda a=e_lba, b=e_len: read(a, b))

    f.seek(16 * size + skip)
    root = f.read(2048)[156:190]
    yield from walk(struct.unpack_from('<I', root, 2)[0], struct.unpack_from('<I', root, 10)[0], '')


def japanese_script(src):
    """The Japanese script as text. `src` is an nscript.dat, a folder holding one, or a disc image
    (.bin / .iso, or the .cue beside it): on a disc the largest nscript.dat is the game's."""
    if os.path.isdir(src):
        src = os.path.join(src, 'nscript.dat')
    if src.lower().endswith('.cue'):
        m = re.search(r'FILE\s+"([^"]+)"', open(src, encoding='utf-8', errors='replace').read())
        folder = os.path.dirname(os.path.abspath(src))
        want = (m.group(1) if m else '').lower()
        hit = [n for n in os.listdir(folder) if n.lower() == want]
        if not hit:
            raise ValueError('the file named in the cue sheet is not beside it')
        src = os.path.join(folder, hit[0])
    if src.lower().endswith(('.bin', '.iso', '.img')):
        best = None
        for name, read in iso_files(src):
            if name.lower().rsplit('/', 1)[-1] == 'nscript.dat':
                data = read()
                if best is None or len(data) > len(best):
                    best = data
        if best is None:
            raise ValueError('no nscript.dat on the disc')
        raw = best
    else:
        raw = open(src, 'rb').read()
    return bytes(b ^ 0x84 for b in raw).decode('cp932', 'replace').replace('\r\n', '\n').replace('\r', '\n')


def add_japanese(src, out):
    """Writes data/script-ja.txt and lists it in the manifest that is already there."""
    text = japanese_script(src)
    with open(os.path.join(out, 'script-ja.txt'), 'wb') as f:
        f.write(text.encode('utf-8'))
    mpath = os.path.join(out, 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {'files': []}
    manifest['files'] = sorted(set(manifest['files']) | {'script-ja.txt'})
    with open(mpath, 'w') as f:
        json.dump(manifest, f)
    print('japanese script: %d lines' % text.count('\n'))


def main():
    args = sys.argv[1:]
    ja = None
    if '--ja' in args:
        k = args.index('--ja')
        if k + 1 >= len(args):
            print(__doc__)
            return 1
        ja = args[k + 1]
        del args[k:k + 2]
    here = os.path.dirname(os.path.abspath(__file__))
    if not args and ja:                 # only the Japanese script, into the data that is there
        out = os.path.abspath(os.path.join(here, '..', 'data'))
        os.makedirs(out, exist_ok=True)
        add_japanese(ja, out)
        return 0
    if not args:
        print(__doc__)
        return 1
    game = args[0]
    out = args[1] if len(args) > 1 else os.path.join(here, '..', 'data')
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
    if ja:
        add_japanese(ja, out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
