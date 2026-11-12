# Kagetsu Tohya — browser port

A small NScripter-compatible engine written in plain JavaScript. It runs the
game's **original script and assets** (unpacked from your own copy) in a
`<canvas>`; nothing was rewritten or re-encoded.

## Run it

It is deployed at <https://kagetsu.pages.dev/> (see Deployment below).

To run it locally, from this folder (the one with `index.html`):

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765/>. It has to be served over HTTP — opening
`index.html` from disk will not work (ES modules and `fetch`).

`data/` is already extracted. To rebuild it (or to point the player at the old
translation by swapping `nscript.dat` / `nscriptoriginal.dat` first):

```bash
python3 tools/extract.py "/path/to/Kagetsu Tohya/Game"
```

To add the Japanese script (from an original Japanese copy: its `nscript.dat`,
the folder holding it, or the disc image as `.bin`, `.cue` or `.iso`):

```bash
python3 tools/extract.py --ja "/path/to/Kagetsu Tohya.cue"
```

This writes `data/script-ja.txt` and lists it in the manifest; nothing else in
`data/` is touched. The pictures and sound are the ones already extracted.

## The interface

Everything is drawn inside the picture and scales with it; there is no
browser-style toolbar. It follows the game's own menus: washed rose-and-lavender
paper, slate ink in a Palatino face, thin rules that run in from the edge of the
screen, a lower-case "back", and the twilight field behind anything shown over
the story.

* **Opening page** — four plates over the twilight field: About (with a link to
  the source on GitHub), Controls, Save data, Play. It opens with none chosen, so a stray click starts nothing; the
  Play page's "press any button" starts the game (and is the click a browser
  needs before it will play sound).
* **The game's own menus** — the title, Start game and each story's page are
  redrawn in the same style (`js/skins.js`). The script still shows each screen,
  offers only what is unlocked and decides what an entry does; only the drawing
  changed. The title keeps its picture uncovered: the labels painted along its
  foot are taken out of the painting, and four entries stand in their places —
  Start game, Resume game, Settings (straight to the Settings page) and Gallery.
* **Gallery** (from the title) — *Graphics mode*: the game's four galleries as
  tabs of thumbnails, read from the script with its own unlock rules, and a
  full-size viewer. *Flowchart*. *Music player*: the seventeen tracks under the
  names the script gives them; one the story has not played yet shows as
  "? ? ?" and cannot be played.
* **Quick bar** — slides in along the top edge while the story waits for you
  (tap the small moon in the corner on a touch screen): Menu, Log, Skip, Auto,
  Save, Load, Hide, Settings, Full. It stays away on the game's own button
  screens.
* **Menu** (right-click / Esc) — the script's own entries, plus Flowchart and
  Settings.
* **Save / Load** — twenty slots, each with a picture of the scene, the time and
  a line of the page.
* **Text history** — everything read this session as one scroll.
* **Flowchart** — built from the script's own flow section
  (`js/flowchart-model.js`), in three tabs. *The day* is laid out by place and
  time: Morning across the top, School, Mansion and Street as columns, Night
  along the foot. It shows what has been reached (the scenes read and the next
  step from each); *everything* draws all 279 blocks and 452 links. Choosing a
  block lights the routes to it and on from it. *Hints* (off by default) put
  each branch's condition in plain words, naming the scenes that count towards
  it once you have read them, and say how to reach a scene not yet read.
  *Ten Nights of Dream* and *Summer Festivals* are the two side lists, each
  dream linked to the day scenes that open it. Scenes not yet read show only
  dots; "read this scene again" replays one by itself. Drag to move, wheel to
  zoom.
* **Guide** (optional, off by default) — the walkthrough that came with the
  copy, followed a day at a time (`js/guide.js`; the text itself is read from
  `data/guide.txt`, not written into the code). With it on, the choice to take
  is marked with a small moon, on the story's page too; take another and it
  steps aside until the day is over and offers the same day again. The quiz's
  answers are marked on the day the walkthrough gives them. The Guide page in
  the Gallery lists the days, shows any day's steps, and sets which day the
  guide is on and which ending it leads to. On the flowchart the day's route is
  drawn in amber. `node tools/guide-check.mjs [normal|true]` plays the whole
  walkthrough through the real script and reports any step that does not match
  a choice the game offers (none, for either ending). Add `ja` to play the
  Japanese script the same way.
* **Settings** — one page for everything: story font (the game's own, a serif or
  a sans), text speed, auto pace, the game's own four switches (instant effects,
  skip parts already read, daily message, skip explicit content), music and
  effect volume, the glow around the picture, fullscreen. The game's "Game
  settings" entry opens this page.
* **Language** (the opening page's Play tab, and Settings; shown when the data
  holds the Japanese script) — English or 日本語. On the opening page nothing is
  running yet, so the other script is simply loaded and the Play tab comes back.
  From Settings it asks first, then starts again from the opening page with the
  other script. What has been read, the gallery, the flowchart and the
  guide's place carry over, because the two scripts keep the same scenes under
  the same labels; saved games are kept separately for each language.
  The interface follows the story's language (`js/i18n.js`). Where the game has
  words of its own they are the game's: the menu entries painted on its Japanese
  pictures (the title, Start game, the ten dreams, the summer festivals,
  Options, Game settings), the names its script gives saving, loading and the
  right-click menu, the name each scene gives itself, and each choice as the
  Japanese script writes it. "back", "op", "a day", "ep" and "help" stay as they
  are, because the Japanese game writes them that way too. The pages this port
  added are translated. The flowchart is still laid out from the English script,
  and with the guide on a Japanese choice is matched through the English choice
  that leads to the same place.
* **Unlock everything** (Settings; off by default) — asks
  first, then opens every scene on the flowchart (each can be read on its own),
  every picture and track in the Gallery, and every story on the Start game
  pages (Ep, Summer Festivals, all ten dreams). It is a view laid over your own
  progress, not a change to it: nothing in the save data is altered, and the
  story goes on recording what you really read. Switching it off shows your own
  progress again, including anything read while it was on. The day's own
  branching is left alone, so the story still plays as your progress has it.

## Controls

| Input | Action |
| --- | --- |
| Left click / tap / Enter / Space | Advance text, pick the highlighted item |
| Right click / long-press / Esc | The menu |
| Mouse wheel up / ↑ / PageUp | Text history |
| Ctrl (hold) | Fast-forward while held |
| S | Toggle fast-forward (stops at the next choice, or on a click) |
| A | Toggle auto-advance |
| 1 / 2 / 3 | Text speed slow / normal / fast |
| M / F | Mute / fullscreen |

Saves live in the browser's `localStorage` for this address; the opening page's
**Save data** tab exports them to a file, imports them, or erases them.

## How it was taken apart

* `Kagetsu Tohya.exe` is **ONScripter-EN** (the binary still carries its C++
  symbols, e.g. `ONScripterLabel::…`), an open-source reimplementation of
  NScripter. The engine's behaviour was therefore taken from its public source
  rather than from disassembly.
* `nscript.dat` is the script, XOR-ed with `0x84`, in Shift-JIS: ~72,000 lines,
  2,453 labels, about 80 distinct commands.
* `arc.nsa` / `arc1.nsa` are NSA archives (big-endian index; members stored
  raw, LZSS- or SPB-compressed). 1,194 files: JPEG images, WAV effects, a few
  BMP icons.
* `CD/trackNN.ogg` are the music tracks the script asks for as `play "*NN"`.

## Layout

```
index.html              the stage: canvas plus the interface's layers
css/shell.css           the interface's look
js/engine.js            script interpreter: parser, variables, control flow, every command
js/gfx.js               compositing, alpha-mask sprites, monochrome tint, transition effects
js/text.js              text window layout (word wrap, glyph positions), page history
js/ui.js                the story's own waits (click marks, picture buttons, choices), the menus' logic
js/shell.js             the interface: opening page, quick bar, menu, saves, history, flowchart, settings
js/flowchart-model.js   reads the day's flow out of the script and lays it out
js/guide.js             the optional guide: reads the walkthrough, keeps its place, picks the choice to mark
js/skins.js             the game's own menu screens, redrawn: their entries and button numbers
js/audio.js             music and sound effects
js/input.js             mouse / touch / keyboard
js/storage.js           saves and persistent ("global") variables
js/main.js              boot, and the opening page's words
js/i18n.js              the interface's words in Japanese
tools/extract.py        unpacks a game folder into data/; --ja adds the Japanese script
tools/dryrun.mjs        headless test: runs the interpreter over the whole script
tools/guide-check.mjs   headless test: plays the walkthrough through the real script
data/                   extracted game data (generated)
```

`node tools/dryrun.mjs 150` plays the script 150 times with random choices and
no display, and prints any script warnings. A fourth argument names another
script: `node tools/dryrun.mjs 30 400000 1 data/script-ja.txt`.

## Known differences from the Windows build

* Transitions 2–14 (shutters, curtains, cross-fade, scrolls) and `quake` follow
  the engine's formulas. Mask and mosaic effects (15–18) fall back to a
  cross-fade; this script never uses them.
* Five lines of prose in the translation lost their leading back-tick. The
  Windows engine silently drops them; here they are shown as text.
* The system menu, save/load, history and settings are this port's own pages
  (see The interface), and the flowchart is new. Saves are not compatible with
  the Windows build's.
* Text is rendered by the browser from the game's own `default.ttf`, at up to 3×
  resolution, so glyph edges are sharper than the original 640×480 output and
  line breaks can occasionally differ by a word.
* Music loops by restarting the stream, so there can be a tiny gap at the loop
  point. Safari older than 18.4 cannot play Ogg Vorbis.

## Deployment

The site is the Cloudflare Pages project `kagetsu`, connected to this
repository. Every push to `main` builds and publishes to
<https://kagetsu.pages.dev/>; there is no manual step.

* Build command: `mkdir -p dist && cp index.html dist/ && cp -R css js data dist/`
* Output directory: `dist`
* Only `index.html`, `css/`, `js/` and `data/` are published (1,230 files).
  `README.md` and `tools/` stay in the repository.
* There is no `404.html`, so Pages answers any unknown path with the opening
  page and a 200 status. A missing asset comes back as HTML rather than an
  error, so compare a file's content, not its status, when checking a deploy.
* Pages allows 25 MiB per file and 20,000 files per deployment. The largest
  file here is about 5 MiB.

## Note

`data/` contains the commercial game's script, art and music. This repository
is private, but the deployed site is not: anyone with the address can load
those files. Cloudflare Access can limit the site to chosen people.
