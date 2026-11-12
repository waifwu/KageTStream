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

## Desktop program

The game as a program of its own, for Windows and macOS, with every file
inside it. It opens straight into the game: the site's opening page is not
shown there. Finished builds are on the
[releases page](https://github.com/waifwu/KageTStream/releases); the opening
page's **Download** tab links to the latest.

`desktop/` is a small Electron wrapper: one window, and the site's files served
to it from disk over a private scheme (`app://kagetsu/`), so modules, `fetch`
and `localStorage` work as they do on the site. `js/main.js` sees the scheme and starts the
game at once; nothing else in `js/` is different.

```bash
cd desktop
npm install
npm start            # run it from this folder
npm run dist         # build dist/: the Windows installer and zip, both macOS disk images
```

Both systems can be built from a Mac. The builds are not code-signed (the macOS
one is signed ad hoc, which Apple silicon needs before it will run anything),
so Windows SmartScreen and macOS Gatekeeper each ask once. Saves are kept in the
program's own profile, apart from any browser's; Settings has **Save data**
(export to a file, import from a file) to carry them across. `npm run icon` redraws `build/icon.png`, `build/icon-win.png` and the website's `../favicon.ico` from `tools/make-icon.js`.

## The interface

Everything is drawn inside the picture and scales with it; there is no
browser-style toolbar. It follows the game's own menus: washed rose-and-lavender
paper, slate ink in a Palatino face, thin rules that run in from the edge of the
screen, a lower-case "back", and the twilight field behind anything shown over
the story.

* **Opening page** — five plates over the twilight field: About (with a link to
  the source on GitHub), Controls, Save data, Download (the desktop program),
  Play. It opens with none chosen, so a stray click starts nothing. The Play
  page has the language and picture-shape switches, and "press any button"
  in the middle of the space below them; that press starts the game (and is
  the click a browser needs before it will play sound).
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
  "? ? ?" and cannot be played. *Guide*, when the walkthrough is in `data/`
  (see Guide below).
* **Quick bar** — slides in along the top edge while the story waits for you
  (tap the small moon in the corner on a touch screen): Menu, Log, Skip, Auto,
  Save, Load, Hide, Settings, Full. It stays away on the game's own button
  screens.
* **Menu** (right-click / Esc / Backspace) — the script's own entries, with
  Flowchart, Guide (when the walkthrough is in `data/`) and Settings set in
  before its last one.
* **On a phone** — the controls are a mouse's and a keyboard's, and the stage is
  scaled to the window as a whole, so on a phone it is too small to read. A
  notice says so as the page opens and asks the reader not to play on a mobile
  device but on a desktop or PC; "Continue anyway" lets them in. It stands
  outside the stage, at the screen's own size.
* **Save / Load** — twenty slots, each with a picture of the scene, the time and
  a line of the page.
* **Text history** — the last 200 pages read this session, as one scroll.
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
  a sans), text speed, auto pace, the guide's marks, the game's own four
  switches (instant effects, skip parts already read, daily message, skip
  explicit content), music and effect volume, sound on or off, the picture's
  shape (4:3 or 16:9), the glow around the picture, fullscreen, the language,
  Unlock everything, and save data to and from a file. The game's "Game
  settings" entry opens this page.
* **16:9** (Settings, *Picture shape*; off by default) — the game without the
  bare strips at its sides on a wide screen. The script still works in its own
  640×480, which stands in the middle of an 854×480 view (`js/gfx.js`):
  backgrounds are enlarged until they are as wide as the view, so an eighth of
  each is lost off the top and off the foot; standing pictures, sprites and the
  story's text keep their size and their places, and the shade behind the text
  runs the whole width. A picture whose sides are one flat colour (a line of
  words on black) is not enlarged but set on that colour, so none of it is cut.
  The title is not cropped either: its emblem is nearly as high as the picture,
  so the sky and ground at its sides are drawn out to the new edges instead
  (`js/skins.js`, `widenTitle`). Every page of the interface is laid out for the
  wider stage (`css/shell.css`, `#stage.wide`), and the gallery still shows a
  picture whole, over a soft copy of itself. It can be switched at any time
  (the opening page's Play tab has the same switch), and saves are the same in
  either shape. The glow around the picture is kept for each shape by itself:
  on at 4:3, off at 16:9 until it is turned on there.
* **The waiting marks** — the triangle after a line and the sheet of paper at
  the end of a page are 24×24 bitmaps in the game's files. They are drawn
  instead (`js/gfx.js`, `MARKS`): the same shapes and the same three frames, at
  the resolution the picture is drawn at, so they stay as sharp as the text.
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
* **Loading** — the game's files arrive as they are needed. While the story
  waits for a click, the next pictures the script names are fetched ahead
  (`Engine.upcomingImages` in `js/engine.js`, `Loader.prefetch` in `js/gfx.js`),
  and a picture that fails to load is tried twice more before it is given up.
  Story music that loops streams at once and is swapped for a gapless loop
  once it has been decoded (`js/audio.js`).

## Controls

| Input | Action |
| --- | --- |
| Left click / tap / Enter / Space | Advance text, pick the highlighted item |
| Right click / two-finger tap / Esc / Backspace | The menu |
| Mouse wheel up / ↑ / PageUp | Text history |
| Ctrl (hold) / a finger held on the picture | Fast-forward while held |
| S | Toggle fast-forward (stops at the next choice, or on a click) |
| A | Toggle auto-advance |
| 1 / 2 / 3 | Text speed slow / normal / fast |
| M / F | Mute / fullscreen |

Saves live in the browser's `localStorage` for this address; the opening page's
**Save data** tab exports them to a file, imports them, or erases them, and
Settings has the export and import too.

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
404.html                the site's answer to an unknown address
_headers                the site's cache rules (Cloudflare Pages)
favicon.ico             the site's icon, drawn by desktop/tools/make-icon.js
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
desktop/main.js         the desktop program: the window, and the files served to it
desktop/tools/make-icon.js  draws the program's icons and the site's favicon.ico
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
* Where the script hides the click cursor (the daily messages, among others) it
  sets it to `icon\hollow.bmp`, a single sky-blue pixel, which the English patch
  asks for opaque (the original's transparent form crashed ONScripter-EN when
  scaled). Drawn, it is a dot after the text; here a one-pixel cursor is not
  drawn at all (`Engine.loadCursor`).
* The system menu, save/load, history and settings are this port's own pages
  (see The interface), and the flowchart is new. Saves are not compatible with
  the Windows build's.
* Text is rendered by the browser from the game's own `default.ttf`, at up to 3×
  resolution, so glyph edges are sharper than the original 640×480 output and
  line breaks can occasionally differ by a word.
* Story music starts streaming at once; meanwhile the track is fetched whole and
  decoded, and a Web Audio buffer that loops by itself takes over where the first
  pass ends (`js/audio.js`), so later loops have no gap. Without Web Audio, or if
  the track cannot be fetched, the stream loops by restarting as before. Safari
  older than 18.4 cannot play Ogg Vorbis.

## Deployment

The site is the Cloudflare Pages project `kagetsu`, connected to this
repository. Every push to `main` builds and publishes to
<https://kagetsu.pages.dev/>; there is no manual step.

* Build command: `mkdir -p dist && cp index.html favicon.ico 404.html _headers dist/ && cp -R css js data dist/`
* Output directory: `dist`
* Both are set on the Pages project (dashboard: Workers & Pages → `kagetsu` →
  Settings → Build), not in this repository. A new file at the top level is
  published only once it is added to the build command there.
* Only `index.html`, `favicon.ico`, `404.html`, `_headers`, `css/`, `js/` and
  `data/` are published. `README.md` and `tools/` stay in the repository.
* `_headers` lets browsers keep the game's own pictures, sounds, music and font
  (`data/arc/`, `data/cd/`, `data/default.ttf`) for a year without asking
  again; they never change. The page, `css/`, `js/` and the script, manifest
  and guide keep Pages' default (`max-age=0, must-revalidate`), since a deploy
  changes them.
* `404.html` answers any unknown path with a 404 status and a link back to the
  game, so a missing asset is an error rather than the opening page.
* To check a deploy: a game file should carry the year-long cache and an
  unknown path should be a 404.

  ```bash
  curl -sI https://kagetsu.pages.dev/data/cd/track02.ogg | grep -i cache-control
  curl -s -o /dev/null -w "%{http_code}\n" https://kagetsu.pages.dev/no-such-file
  ```
* Pages does not answer byte-range requests for these files, so a streamed
  track cannot be seeked and its length is a guess. The music player therefore
  fetches each track whole and plays it from memory (`js/audio.js`).
* Pages allows 25 MiB per file and 20,000 files per deployment. The largest
  file here is about 5 MiB.

## Note

`data/` contains the commercial game's script, art and music. This repository
is public on GitHub, with `data/` in it, and the deployed site is open to
anyone with the address: both hand those files to whoever asks. Making the
repository private (Pages keeps building from a private repository) and
putting Cloudflare Access in front of the site would limit them to chosen
people; the opening page's Download links point at this repository's
releases, so they would then work only for people with access to it.
