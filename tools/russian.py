"""The Russian script, from the Ren'Py release of Kagetsu Tohya that carries a Russian translation
(game/tl/russian/). Used by extract.py --ru.

That release was converted from the old English patch's script (the copy's nscriptoriginal.dat):
each text line of it became one line of dialogue, an "@" inside a line "{w}", "!w500" "{w=0.5}",
a colour "{color=...}", a page's end a "nvl clear". Its Russian is kept as translations of those
English lines, each found by the identifier Ren'Py gives it (renpy_read.py). So each text line of the old
script is paired with its English line in the release, by the words, and so with its Russian; and the
Russian is written at the same line of this port's script. The two English scripts have the same
lines in the same places, only the words of the text differ, so nothing else in the script moves:
the labels, the commands and the relative skips are this script's own.

Choices, the daily messages and the gallery's titles are strings in the release, translated old for
new; they are found by their words the same way.
"""
import difflib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import renpy_read as renpy  # noqa: E402

TL = 'tl/russian/scenario/'
SOURCES = ('sc_en', 'setup', 'choice')
OPTION = re.compile(r'^\s*`[^`]*`\s*,')      # a choice on a line of its own: `text`,*label,
BLANK_LINES = ('{fast}{nw}', '{fast}', '')   # the release's stand-ins for "br" and empty lines

# What the English patch added and the release does not have, so has no Russian for: the staff
# room's message and scene selectors, its jukebox and easter eggs; and the titles and artists of the
# gallery's guest and submitted art, which the release keeps in English too. Left as they are.
EXTRAS = re.compile(r'^(msgselect|sceneselect|easter|seafood|renlen|jukebox|music|imagemode|mp_|guest_gallery|post_gallery|s\d+ss$)')

# The few strings of the script the release has no words for: the right-click menu and the save
# slots, which its own interface does differently. As the release's interface words them where it
# has them (tl/russian/common: "Сохранить", "Загрузить").
OWN = {
    'Save game': 'Сохранить', 'Load game': 'Загрузить', 'Display image': 'Показать картинку',
    'Display text history': 'Показать историю', 'Fast forward to next choice': 'Перемотка до выбора',
    'Return to title': 'Выйти в меню', 'Game settings': 'Настройки игры', 'Slot': 'Слот',
}


def norm(s):
    """An English line or string as both sides can be compared: waits as the release writes them,
    blanks as spaces, runs of spaces as one, no line-end marks."""
    s = re.sub(r'!([wd])(\d+)', lambda m: '{w=%g}' % (int(m.group(2)) / 1000), s)
    s = re.sub(r'\{w=(\d+(?:\.\d+)?)\}', lambda m: '{w=%g}' % float(m.group(1)), s)
    s = s.replace('~', '‾').replace('^', ' ').replace('{nw}', '').replace('{fast}', '').replace('{w}', '@')
    s = re.sub(r'\{/?color[^}]*\}', '', s)
    s = re.sub(r'#[0-9A-Fa-f]{6}', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r' ?@ ?', '@', s)
    return s.rstrip('@\\').strip()


def bare(line):
    """A line of English text the patch wrote without its backquote; the engine shows it as text all
    the same, its first word being no command (five of them: "In other words|@", "class B's ...").
    Written in Russian it gets its backquote, or its words would be set as two-byte text, which
    drops the spaces between them."""
    if not re.match(r'^[A-Za-z"\']', line) or re.search(r'[`;%$]', line) or not re.search(r'[@\\][ \t]*$', line):
        return False
    if ',' not in line:
        return True
    return len(re.findall(r"(?<![\w%$])[A-Za-z][a-z']+[.,!?|]?(?=\s|@|$)", line)) >= 4


def body_and_end(line):
    """A text line's lead (tabs and the backquote), its words, and how it ends ("@", "\\", or
    nothing, with any blanks after)."""
    m = re.match(r'^([\t ]*`?)(.*?)([@\\]?[ \t]*)$', line)
    return m.group(1), m.group(2), m.group(3)


def label_of(lines):
    """The label each line is under."""
    out, cur = [], None
    for l in lines:
        if l.startswith('*'):
            cur = l[1:].split()[0] if l[1:].split() else cur
        out.append(cur)
    return out


def to_script(ru, en_line_body, en_what):
    """Russian as the release writes it, as a line of this script: its waits and colours as the
    script's own, and the lead blanks the English line has."""
    s = ru
    # colours: the release opens one with {color=#xxxxxx} and ends it with {/color}; the script names
    # the colour it goes back to, which is taken from the English line in the order it has them
    codes = re.findall(r'#[0-9A-Fa-f]{6}', en_line_body)
    back = [c for c in codes[1::2]] or ['#FFFFFF']

    k = [0]

    def colour(m):
        if m.group(0).startswith('{/'):
            c = back[min(k[0], len(back) - 1)]
            k[0] += 1
            return c
        return m.group(1)
    s = re.sub(r'\{color=(#[0-9A-Fa-f]{6})\}|\{/color\}', colour, s)
    # timed waits: as !w or !d, whichever the English line has for the same time
    kinds = {}
    for k, n in re.findall(r'!([wd])(\d+)', en_line_body):
        kinds.setdefault(int(n), k)
    s = re.sub(r'\{w=(\d+(?:\.\d+)?)\}', lambda m: '!%s%d' % (kinds.get(round(float(m.group(1)) * 1000), 'w'),
                                                            round(float(m.group(1)) * 1000)), s)
    s = s.replace('{w}', '@').replace('{nw}', '').replace('{fast}', '').replace('‾', '~')
    s = s.replace('[[', '[').replace('{{', '{')
    lead_en = re.match(r'^[ 　]*', en_what).group(0)
    if lead_en and not re.match(r'^[ 　]', s):
        s = lead_en + s
    s = s.rstrip()
    while s.endswith('@'):
        s = s[:-1].rstrip()
    return s


def spread_over(text, weights):
    """`text` cut into as many parts as `weights`: at its waits if it has one between each, or else at
    its spaces, each part about as long as its weight."""
    if len(weights) == 1:
        return [text]
    waits = re.split(r'\{w\}\s*', text)
    if len(waits) == len(weights):
        return [w.strip() for w in waits]
    words = text.split(' ')
    total, parts, k = sum(weights) or 1, [], 0
    for w in weights[:-1]:
        want = len(text) * w / total
        part = []
        while k < len(words) - 1 and (not part or len(' '.join(part + [words[k]])) <= want * 1.15):
            part.append(words[k])
            k += 1
        parts.append(' '.join(part))
    parts.append(' '.join(words[k:]))
    return parts


def collect(release):
    """[(source, identifier, label, english, russian)] for every line of the release, in order, and
    {english: russian} for its strings."""
    says, strings = [], {}
    for src in SOURCES:
        tr, st = renpy.translations(release, TL + src + '.rpyc', 'russian')
        for k, v in st.items():
            if v.strip():           # the release leaves what it has not translated empty
                strings.setdefault(k, v)
        for ident, label, what in renpy.english_says(release, 'scenario/%s.rpyc' % src):
            ru = tr.get(ident)
            says.append((src, ident, label, what, ru[0] if ru and ru[0].strip() else None))
    for name in sorted(release.names):
        if name.startswith('tl/russian/') and name.endswith('.rpyc') and not name.startswith(TL):
            for k, v in renpy.translations(release, name, 'russian')[1].items():
                if v.strip():
                    strings.setdefault(k, v)
    return says, strings


def build(release, old_text, cur_text, report=print):
    old = old_text.split('\n')
    cur = cur_text.split('\n')
    assert len(old) == len(cur), 'the old English script has %d lines, this one %d' % (len(old), len(cur))
    textual = lambda l: (l.lstrip('\t ').startswith('`') and not OPTION.match(l)) or bare(l)
    for i, (a, b) in enumerate(zip(old, cur)):
        assert textual(a) == textual(b), 'line %d is text in one English script only' % (i + 1)
    says, strings = collect(release)
    missing = [s for s in says if s[4] is None and s[3] not in BLANK_LINES]
    report('release: %d lines of dialogue, %d strings; %d lines with no Russian' % (len(says), len(strings), len(missing)))

    ns = [i for i, l in enumerate(old) if textual(l)]
    ns_set = set(ns)
    rp = [s for s in says if s[3] not in BLANK_LINES]
    a = [norm(body_and_end(old[i])[1]) for i in ns]
    b = [norm(s[3]) for s in rp]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    pairs = {}          # line index -> release line
    fuzzy = 0
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            for k in range(i2 - i1):
                pairs[ns[i1 + k]] = rp[j1 + k]
        elif op == 'replace':
            # the same number on each side: pair them in order where the words are close
            if i2 - i1 == j2 - j1:
                for k in range(i2 - i1):
                    if difflib.SequenceMatcher(None, a[i1 + k], b[j1 + k]).ratio() >= 0.6:
                        pairs[ns[i1 + k]] = rp[j1 + k]
                        fuzzy += 1
            else:
                j = j1
                for i in range(i1, i2):
                    best = max(range(j, j2), key=lambda jj: difflib.SequenceMatcher(None, a[i], b[jj]).ratio(), default=None)
                    if best is not None and difflib.SequenceMatcher(None, a[i], b[best]).ratio() >= 0.6:
                        pairs[ns[i]] = rp[best]
                        fuzzy += 1
                        j = best + 1
    # the release's files are not in the script's order (its choice file holds two lines of *f232,
    # which comes before the daily messages of its setup file): what is left is paired by its words
    labels = label_of(old)
    taken = {id(v) for v in pairs.values()}
    by_words = {}
    for s_ in rp:
        if id(s_) not in taken:
            by_words.setdefault(norm(s_[3]), []).append(s_)
    later = 0
    for k, i in enumerate(ns):
        if i in pairs:
            continue
        cands = [c for c in by_words.get(a[k], []) if c[2] == labels[i]] or by_words.get(a[k], [])
        if len(cands) >= 1 and len({c[4] for c in cands}) == 1:
            pairs[i] = cands[0]
            later += 1
    report('text lines: %d; paired by the same words %d, by close words %d, out of order %d, unpaired %d'
           % (len(ns), len(pairs) - fuzzy - later, fuzzy, later, len(ns) - len(pairs)))

    # each pair is under the same label on both sides, where the release has the script's label
    rp_labels = {s[2] for s in says}
    off = [i for i, s in pairs.items() if labels[i] in rp_labels and labels[i] != s[2]]
    report('pairs under another label than the release gives: %d' % len(off))
    for i in off[:5]:
        report('  line %d under *%s, release %s: %r' % (i + 1, labels[i], pairs[i][2], old[i][:60]))

    table = {}
    for k, v in strings.items():
        table.setdefault(norm(k), v)
    for k, v in OWN.items():
        table.setdefault(norm(k), v)
    for i in ns:
        if i not in pairs:
            new = table.get(norm(body_and_end(old[i])[1]))
            if new is not None:
                pairs[i] = ('strings', None, labels[i], body_and_end(old[i])[1], new)
    # a daily message the script writes on two or three lines may be one string in the release, or
    # worded a little otherwise: joined with the lines after it, or else the closest string, and its
    # Russian spread over the same lines by their lengths
    spread = {}
    keys = list(table)
    for k, i in enumerate(ns):
        if i in pairs or not re.search(r'[A-Za-z]{3,}', old[i]):
            continue
        run = [i]
        while len(run) < 3 and run[-1] + 1 in ns_set and run[-1] + 1 not in pairs and labels[run[-1] + 1] == labels[i]:
            run.append(run[-1] + 1)
        found = None
        for n in range(len(run), 0, -1):
            words = norm(' '.join(body_and_end(old[j])[1] + ('@' if '@' in body_and_end(old[j])[2] else '') for j in run[:n]))
            if words in table:
                found = (run[:n], table[words])
                break
        if not found:
            words = norm(body_and_end(old[i])[1])
            best = max(keys, key=lambda kk: difflib.SequenceMatcher(None, words, kk).quick_ratio())
            if difflib.SequenceMatcher(None, words, best).ratio() >= 0.9:
                found = ([i], table[best])
            else:
                # the release cut a few messages short ("novel recommendation " of "... of the day:")
                pre = [kk for kk in keys if len(kk) >= 24 and words.startswith(kk)]
                if pre:
                    found = ([i], table[max(pre, key=len)])
        if found:
            lines_, ru = found
            for j, part in zip(lines_, spread_over(ru, [len(body_and_end(old[j])[1]) for j in lines_])):
                pairs[j] = ('strings', None, labels[j], body_and_end(old[j])[1], part)
                spread[j] = True
    report('text lines the release has as strings: %d (of them joined or close: %d)'
           % (sum(1 for v in pairs.values() if v[0] == 'strings'), len(spread)))
    placed = {id(v) for v in pairs.values()}
    unplaced = [s_ for s_ in rp if id(s_) not in placed and s_[4] and re.search(r'[A-Za-z]{3,}', s_[3])]
    report('lines of the release with Russian that no line of the script took: %d' % len(unplaced))
    for s_ in unplaced[:10]:
        report('  %s %s %r' % (s_[0], s_[2], s_[3][:80]))

    out = list(cur)
    english_left = []
    for i in ns:
        s = pairs.get(i)
        if not s or s[4] is None:
            if re.search(r'[A-Za-z]{3,}', body_and_end(cur[i])[1]):
                english_left.append(i)
            continue
        lead, body_old, _ = body_and_end(old[i])
        _, _, end = body_and_end(cur[i])
        _, _, end_old = body_and_end(old[i])
        ru = to_script(s[4], body_old, s[3])
        for bad in ('{', '}', '`', '\n'):
            assert bad not in ru, 'line %d: %r left in %r' % (i + 1, bad, ru)
        if not lead.endswith('`'):
            lead += '`'
        out[i] = lead + ru + (end_old if end_old.strip() != end.strip() else end)

    # strings: choices, daily messages, the gallery's titles, the menus

    def put_string(t):
        new = table.get(norm(t))
        if new is None:
            return None
        new = to_script(new, t, '')
        new = new.replace('@', '')          # a string's waits are the script's, not the release's
        lead = re.match(r'^[ 　]*', t).group(0)
        tail = re.search(r'[ ^]*$', t).group(0)
        core = new.strip()
        if '^' in t:
            core = core.replace(' ', '^')
        return lead + core + tail

    strings_left = []
    quoted = re.compile(r'`([^`]*)`|"([^"]*)"')
    for i, l in enumerate(cur):
        st = l.lstrip('\t ')
        if textual(l) or not st or st.startswith(';') or st.startswith('*'):
            continue

        def rep(m):
            t = m.group(1) if m.group(1) is not None else m.group(2)
            q = '`' if m.group(1) is not None else '"'
            if not re.search(r'[A-Za-z]{3,}', t) or re.search(r'\.(jpg|bmp|png|wav|ogg|mp3|txt|dat)\b|\\|^[:*]', t, re.I):
                return m.group(0)
            if '`' in t:            # savename "□■`Save  game`■□": the words inside
                new = re.sub(r'`([^`]*)`', lambda mm: '`' + (put_string(mm.group(1)) or mm.group(1)) + '`', t)
                if new == t:
                    strings_left.append((i, t))
                return q + new + q
            new = put_string(t)
            if new is None:
                strings_left.append((i, t))
                return m.group(0)
            return q + new + q
        # the old script's string where the two differ (one choice was reworded)
        src = old[i] if old[i] != l and quoted.sub('', old[i]) == quoted.sub('', l) else l
        out[i] = quoted.sub(rep, src)

    extra = lambda i: bool(EXTRAS.match(labels[i] or ''))
    report('left in English: %d text lines and %d strings of the extras the release does not have'
           % (sum(map(extra, english_left)), sum(1 for i, _ in strings_left if extra(i))))
    english_left = [i for i in english_left if not extra(i)]
    strings_left = [(i, t) for i, t in strings_left if not extra(i)]
    report('text lines still in English: %d' % len(english_left))
    for i in english_left[:20]:
        report('  %d *%s %r' % (i + 1, labels[i], cur[i][:90]))
    report('strings still in English: %d' % len(strings_left))
    for i, t in strings_left[:20]:
        report('  %d *%s %r' % (i + 1, labels[i], t[:80]))

    # nothing but text and strings has changed
    for i, (x, y) in enumerate(zip(cur, out)):
        if x != y and not textual(x):
            assert quoted.sub('``', x) == quoted.sub('``', y) or quoted.sub('``', old[i]) == quoted.sub('``', y), 'line %d changed outside its strings' % (i + 1)
    assert len(out) == len(cur)
    return '\n'.join(out), english_left, strings_left



# ------------------------------------------------------------------------------------------ pictures
# The release has its own copies of the pictures with English words on them (tl/russian/image/...):
# the words of the endings and chapters, the translators' cards, the title of Imogirisou, the card
# Ciel holds up. They are AVIF at 1920 x 1080, which only ffmpeg reads here; each is made back into
# the shape and size of this port's own picture, as a JPEG, under data/ru/arc/.
#   * a picture of words on black or white (the credits, the chapters' names, the translators'
#     cards): the release set its Russian words afresh on the whole 16:9 screen, so a 4:3 part of it
#     is taken, the middle one where it holds all the words, or else the one nearest the middle that
#     does; the letters keep their shape;
#   * any other picture in image/word or image/add: the release stretched this port's 640 x 480 to
#     1920 x 1080 and changed the words on it, and it is stretched back (the release's English copies
#     match this port's that way to 46-52 dB);
#   * image/bg: the release drew these again at 16:9; their middle 4:3 is taken;
#   * image/tachi: a picture and its mask side by side, each a whole screen with the lettering in it;
#     the lettering is cut out and set, its shape kept, where this port's card has its own.
# All are written with full-resolution colour, as this port's own are (a card 443 high stays 443).
def _ffmpeg():
    import shutil
    return shutil.which('ffmpeg') or ('/opt/homebrew/bin/ffmpeg' if os.path.exists('/opt/homebrew/bin/ffmpeg') else None)


def _run(cmd):
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('ffmpeg failed: ' + r.stderr[-400:])
    return r.stderr


def _size(ff, path):
    m = re.search(r', (\d{2,5})x(\d{2,5})[, ]', _run([ff, '-hide_banner', '-i', path, '-f', 'null', '-frames:v', '1', '-']))
    return int(m.group(1)), int(m.group(2))


def _box(ff, path, crop, invert):
    """The box (x, y, w, h) of what is drawn in part `crop` of a mask: black on white."""
    vf = 'crop=%s,%sformat=gray,bbox=min_val=40' % (crop, 'negate,' if invert else '')
    m = re.findall(r'x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)', _run([ff, '-hide_banner', '-i', path, '-vf', vf, '-f', 'null', '-']))
    x1, x2, y1, y2 = map(int, m[-1])
    return x1, y1, x2 - x1 + 1, y2 - y1 + 1


def _mean(ff, path):
    m = re.search(r'YAVG=([\d.]+)', _run([ff, '-hide_banner', '-i', path, '-vf',
                                           'format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']))
    return float(m.group(1))


def add_pictures(release, out, report=print):
    """Writes data/ru/arc/image/... and returns their names as the manifest lists them."""
    import tempfile
    ff = _ffmpeg()
    if not ff:
        report('pictures: ffmpeg not found, so the Russian pictures are left out (the English ones are shown)')
        return set()
    arc = release.archive()
    added = set()
    with tempfile.TemporaryDirectory() as tmp:
        for member in sorted(arc):
            if not member.startswith('tl/russian/image/') or member.startswith('tl/russian/image/interface'):
                continue
            rel = 'arc/' + member[len('tl/russian/'):-len('.png')] + '.jpg'
            ours = os.path.join(out, *rel.split('/'))
            if not os.path.exists(ours):
                continue
            src = os.path.join(tmp, 'in.avif')
            with open(src, 'wb') as f:
                f.write(arc[member]())
            dst = os.path.join(out, 'ru', *rel.split('/'))
            if not os.path.abspath(dst).startswith(os.path.abspath(os.path.join(out, 'ru')) + os.sep):
                raise ValueError('unsafe path in archive: ' + member)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            w, h = _size(ff, ours)
            if '/tachi/' in rel:
                sw, sh = _size(ff, src)
                half = sw // 2
                ox, oy, ow, oh = _box(ff, ours, '%d:%d:%d:0' % (w // 2, h, w // 2), True)
                rx, ry, rw, rh = _box(ff, src, '%d:%d:%d:0' % (half, sh, half), True)
                k = min(ow / rw, (h - 8) / rh)
                nw, nh = max(2, round(rw * k)), max(2, round(rh * k))
                px = max(0, min(w // 2 - nw, round(ox + ow / 2 - nw / 2)))
                py = max(0, min(h - nh, round(oy + oh / 2 - nh / 2)))
                graph = ('[0]crop=%d:%d:%d:%d,scale=%d:%d,pad=%d:%d:%d:%d:black[a];'
                         '[0]crop=%d:%d:%d:%d,scale=%d:%d,pad=%d:%d:%d:%d:white[m];[a][m]hstack'
                         % (rw, rh, rx, ry, nw, nh, w // 2, h, px, py,
                            rw, rh, half + rx, ry, nw, nh, w // 2, h, px, py))
                _run([ff, '-v', 'error', '-y', '-i', src, '-filter_complex', graph, '-pix_fmt', 'yuvj444p', '-q:v', '2', dst])
            elif '/bg/' not in rel and not 8 <= _mean(ff, ours) <= 245:
                # words on black (or white): the 4:3 part nearest the middle that holds them all
                sw, sh = _size(ff, src)
                ww = sh * 4 // 3
                x, y, bw, bh = _box(ff, src, '%d:%d:0:0' % (sw, sh), _mean(ff, ours) > 245)
                x0 = (sw - ww) // 2
                if bw <= ww:
                    x0 = max(x + bw - ww, min(x, x0))
                    _run([ff, '-v', 'error', '-y', '-i', src, '-vf', 'crop=%d:%d:%d:0,scale=%d:%d' % (ww, sh, x0, w, h),
                          '-pix_fmt', 'yuvj444p', '-q:v', '2', dst])
                else:
                    _run([ff, '-v', 'error', '-y', '-i', src, '-vf', 'scale=%d:%d' % (w, h), '-pix_fmt', 'yuvj444p', '-q:v', '2', dst])
            elif '/bg/' in rel:
                _run([ff, '-v', 'error', '-y', '-i', src, '-vf', 'crop=ih*4/3:ih,scale=%d:%d' % (w, h), '-pix_fmt', 'yuvj444p', '-q:v', '2', dst])
            else:
                _run([ff, '-v', 'error', '-y', '-i', src, '-vf', 'scale=%d:%d' % (w, h), '-pix_fmt', 'yuvj444p', '-q:v', '2', dst])
            assert _size(ff, dst) == (w, h), dst
            added.add('ru/' + rel)
    report('pictures: %d with Russian words' % len(added))
    return added

if __name__ == '__main__':
    # python3 -I tools/russian.py <release .zip / .app / folder> <old English nscript.dat> <script.txt> <out>
    rel = renpy.Release(sys.argv[1])
    raw = open(sys.argv[2], 'rb').read()
    old_text = bytes(c ^ 0x84 for c in raw).decode('cp932').replace('\r\n', '\n').replace('\r', '\n')
    cur_text = open(sys.argv[3], encoding='utf-8').read()
    text, _, _ = build(rel, old_text, cur_text)
    open(sys.argv[4], 'w', encoding='utf-8').write(text)
