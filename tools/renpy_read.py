"""Reading a Ren'Py release without running any of it: its compiled scripts (.rpyc), its
translations (game/tl/<language>/), and its archive (archive.rpa). Used by extract.py --ru.

A .rpyc is a zlib-compressed pickle of Ren'Py's syntax tree, and an archive's index is a pickle too.
A pickle can name any callable and have it called as it is read, so the reader here never hands one
back: every class it is asked for becomes an inert stand-in that only keeps what it is given. Only
plain containers are real.

The release can be given as its .zip, its .app, or a folder that holds its game/ folder (or is it).
"""
import collections
import hashlib
import io
import os
import pickle
import re
import struct
import zipfile
import zlib


# ---------------------------------------------------------------------------------------- pickles
class Fake:
    _module = _name = ''

    def __new__(cls, *args, **kw):
        o = object.__new__(cls)
        o._args = args
        return o

    def __init__(self, *args, **kw):
        pass

    def __setstate__(self, state):
        if isinstance(state, tuple) and len(state) == 2:
            for part in state:
                if isinstance(part, dict):
                    self.__dict__.update(part)
        elif isinstance(state, dict):
            self.__dict__.update(state)
        else:
            self._state = state

    # a pickled list or dict subclass is filled in by append / __setitem__
    def append(self, x):
        self.__dict__.setdefault('_items', []).append(x)

    def extend(self, xs):
        self.__dict__.setdefault('_items', []).extend(xs)

    def __setitem__(self, k, v):
        self.__dict__.setdefault('_map', {})[k] = v

    def __repr__(self):
        return '<%s.%s>' % (self._module, self._name)


_classes = {}
_SAFE = {
    ('builtins', 'set'): set, ('builtins', 'frozenset'): frozenset, ('builtins', 'list'): list,
    ('builtins', 'dict'): dict, ('builtins', 'tuple'): tuple, ('builtins', 'object'): object,
    ('collections', 'OrderedDict'): collections.OrderedDict,
}


def _reconstructor(cls, base, state=None):
    # copyreg._reconstructor, for one of our stand-ins only
    if isinstance(cls, type) and issubclass(cls, Fake):
        return cls.__new__(cls)
    raise pickle.UnpicklingError('refused: reconstructing %r' % (cls,))


class _Reader(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) in _SAFE:
            return _SAFE[(module, name)]
        if (module, name) == ('copyreg', '_reconstructor'):
            return _reconstructor
        key = (module, name)
        if key not in _classes:
            _classes[key] = type(name, (Fake,), {'_module': module, '_name': name})
        return _classes[key]


def unpickle(data):
    return _Reader(io.BytesIO(data)).load()


def kind(o):
    return o._name if isinstance(o, Fake) else type(o).__name__


def items(x):
    if isinstance(x, Fake) and hasattr(x, '_items'):
        return x._items
    return x or []


# ---------------------------------------------------------------------------------------- the release
class Release:
    """The files of a Ren'Py release's game/ folder, from a .zip, a .app or a folder."""

    def __init__(self, path):
        self.zip = None
        if zipfile.is_zipfile(path):
            self.zip = zipfile.ZipFile(path)
            anchors = sorted((n for n in self.zip.namelist() if n == 'game/archive.rpa' or n.endswith('/game/archive.rpa')), key=len)
            if not anchors:
                raise ValueError('no game/archive.rpa in ' + path)
            self.root = anchors[0][:-len('archive.rpa')]
            self.names = {n[len(self.root):] for n in self.zip.namelist() if n.startswith(self.root) and not n.endswith('/')}
        else:
            root = None
            for cand in (path, os.path.join(path, 'game'),
                         os.path.join(path, 'Contents', 'Resources', 'autorun', 'game')):
                if os.path.isdir(os.path.join(cand, 'tl')) or os.path.isfile(os.path.join(cand, 'archive.rpa')):
                    root = cand
                    break
            if root is None:
                raise ValueError('no Ren\'Py game folder in ' + path)
            self.root = root
            self.names = set()
            for d, _dirs, files in os.walk(root):
                for f in files:
                    self.names.add(os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/'))

    def read(self, name):
        if self.zip:
            return self.zip.read(self.root + name)
        with open(os.path.join(self.root, *name.split('/')), 'rb') as f:
            return f.read()

    def rpyc(self, name):
        """(data, statements) of a compiled script."""
        raw = self.read(name)
        if not raw.startswith(b'RENPY RPC2'):
            raise ValueError('not a compiled Ren\'Py script: ' + name)
        pos, slots = 10, {}
        while True:
            slot, start, length = struct.unpack('<III', raw[pos:pos + 12])
            pos += 12
            if slot == 0:
                break
            slots[slot] = raw[start:start + length]
        return unpickle(zlib.decompress(slots[1]))

    def archive(self, name='archive.rpa'):
        """{member: bytes-reader} of an RPA-3.0 archive."""
        raw = self.read(name)
        head = raw[:raw.index(b'\n')].decode()
        parts = head.split()
        if parts[0] != 'RPA-3.0':
            raise ValueError('not an RPA-3.0 archive: ' + head)
        off, key = int(parts[1], 16), int(parts[2], 16)
        index = unpickle(zlib.decompress(raw[off:]))
        out = {}
        for member, entries in index.items():
            e = entries[0]
            o, n = e[0] ^ key, e[1] ^ key
            prefix = e[2] if len(e) > 2 else b''
            if isinstance(prefix, str):
                prefix = prefix.encode('latin-1')
            out[member] = (lambda o=o, n=n, p=prefix: p + raw[o:o + n - len(p)])
        return out


# ---------------------------------------------------------------------------------------- translations
# Ren'Py gives each block of translatable statements an identifier: the label it is under, and the
# first eight hex digits of the md5 of the block's code (each statement's, then CRLF), with _1, _2
# for repeats (renpy/translation/__init__.py, Restructurer). Worked out again here from the English
# script, it finds each English line's translation exactly.

def _say_string(s):
    s = s.replace('\\', '\\\\').replace('\n', '\\n').replace('"', '\\"')
    s = re.sub(r'(?<= ) ', '\\ ', s)
    return '"' + s + '"'


def _code(n):
    k = kind(n)
    if k == 'UserStatement':
        return n.line
    if k != 'Say':
        raise ValueError('no code for ' + k)
    rv = []
    if n.who:
        rv.append(n.who)
    if getattr(n, 'attributes', None) is not None:
        rv.extend(n.attributes)
    if getattr(n, 'temporary_attributes', None):
        rv.append('@')
        rv.extend(n.temporary_attributes)
    rv.append(_say_string(n.what))
    if not n.interact:
        rv.append('nointeract')
    if getattr(n, 'explicit_identifier', False):
        rv += ['id', n.identifier]
    if getattr(n, 'arguments', None):
        raise ValueError('a say statement with arguments')
    if getattr(n, 'with_', None):
        rv += ['with', n.with_]
    return ' '.join(rv)


class _Restructurer:
    def __init__(self):
        self.label = None
        self.alternate = None
        self.identifiers = set()
        self.says = []          # (identifier, label, what) for each say, in order

    def _unique(self, label, digest):
        base = digest if label is None else label.replace('.', '_') + '_' + digest
        i, suffix = 0, ''
        while base + suffix in self.identifiers:
            i += 1
            suffix = '_%d' % i
        return base + suffix

    def _create(self, group):
        md5 = hashlib.md5()
        for n in group:
            md5.update((_code(n) + '\r\n').encode('utf-8'))
        digest = md5.hexdigest()[:8]
        ident = self._unique(self.label, digest)
        self.identifiers.add(ident)
        if self.alternate is not None:
            self.identifiers.add(self._unique(self.alternate, digest))
        for n in group:
            if kind(n) == 'Say':
                self.says.append((ident, self.label, n.what))

    @staticmethod
    def _blocks(n):
        k = kind(n)
        if k == 'If':
            for e in items(n.entries):
                yield e[1]
        elif k == 'Menu':
            for e in items(n.items):
                if e[-1] is not None:
                    yield e[-1]
        elif k in ('Label', 'While', 'Init'):
            if getattr(n, 'block', None):
                yield n.block

    def restructure(self, children):
        group = []
        for n in items(children):
            k = kind(n)
            if k == 'Label' and not getattr(n, 'hide', False):
                if n.name.startswith('_'):
                    self.alternate = n.name
                else:
                    self.label, self.alternate = n.name, None
            if k != 'Translate':
                for b in self._blocks(n):
                    self.restructure(b)
            if k == 'Say':
                group.append(n)
                self._create(group)
                group = []
            elif getattr(n, 'translatable', False):
                group.append(n)
            elif group:
                self._create(group)
                group = []
        if group:
            self._create(group)


def english_says(release, name):
    """[(identifier, label, what)] of a compiled English script, in order."""
    _, stmts = release.rpyc(name)
    r = _Restructurer()
    r.restructure(stmts)
    return r.says


def translations(release, name, language):
    """({identifier: [what]}, {old: new}) of a translation file."""
    _, stmts = release.rpyc(name)
    says, strings = {}, {}

    def visit(nodes):
        for n in items(nodes):
            k = kind(n)
            if k == 'Translate' and n.language == language:
                says[n.identifier] = [b.what for b in items(n.block) if kind(b) == 'Say']
            elif k == 'TranslateString' and n.language == language:
                strings[n.old] = n.new
            elif k == 'Init':
                visit(n.block)
    visit(stmts)
    return says, strings
