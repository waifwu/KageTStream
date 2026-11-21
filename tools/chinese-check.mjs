// node tools/chinese-check.mjs: validate the imported patch against the real engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Engine } from '../js/engine.js';
import { Loader } from '../js/gfx.js';
import { UI } from '../js/ui.js';
import { CHS } from '../js/i18n-chs.js';
import { setLang, t, when } from '../js/i18n.js';
import { choiceTranslator } from '../js/guide.js';
import { FONTS, setStoryFont } from '../js/text.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const manifest = JSON.parse(read('data/manifest.json'));
const script = read('data/script-chs.txt');
const english = read('data/script.txt');
assert(manifest.files.includes('script-chs.txt'));
for (const f of manifest.files.filter((s) => s.startsWith('chs/'))) {
  assert(fs.existsSync(path.join(root, 'data', f)), 'missing Chinese resource: ' + f);
}

// Existing dictionaries are the interface's inventory, including longer help pages.
const i18n = read('js/i18n.js');
for (const name of ['JA', 'PT', 'ES']) {
  const start = i18n.indexOf('const ' + name + ' = {') + ('const ' + name + ' = ').length;
  const end = i18n.indexOf('\n};', start) + 2;
  const table = vm.runInNewContext('(' + i18n.slice(start, end) + ')');
  for (const key of Object.keys(table)) assert(key in CHS, 'missing translation: ' + key);
}
setLang('chs');
assert.equal(t('Settings'), '设置');
assert.equal(t('Saved in No. 3.'), '已保存至存档 3。');
assert.equal(t('Day 12: next up'), '第 12 轮：下一轮');
assert(when(new Date(2026, 0, 2, 3, 4).getTime()).includes('1月2日'));
const originalStack = FONTS.original.stack;
setStoryFont('original', 'chs');
assert(FONTS.original.stack.includes('Microsoft YaHei'));
setStoryFont('original', 'en');
assert.equal(FONTS.original.stack, originalStack);
setLang('es');
assert.equal(t('Settings'), 'Configuración');
setLang('en');
assert.equal(t('Settings'), 'Settings');

const played = [];
const warnings = [];
const host = {
  lang: 'chs', storage: { loadGlobals: () => null },
  audio: { playBgm: (...args) => played.push(args) }, onWarn: (s) => warnings.push(s),
};
const loader = new Loader('data/', manifest, 'chs/');
const engine = new Engine(script, host);
const ref = new Engine(english, { ...host, lang: 'en' });
for (const name of ref.labels.keys()) {
  if (/^s\d+$/.test(name)) assert(engine.labels.has(name), 'missing scene: ' + name);
}
const translate = choiceTranslator(script, english);
let translatedChoices = 0;
const choiceLines = script.split('\n');
for (let i = 0; i < choiceLines.length; i++) {
  let line = choiceLines[i];
  if (!/^\s*(?:select|selgosub)\s/.test(line)) continue;
  while (/,\s*$/.test(line) && i + 1 < choiceLines.length) line += '\n' + choiceLines[++i];
  const pairs = [...line.matchAll(/"([^"\n]*)"\s*,\s*\*([\w]+)/g)];
  if (!pairs.length) continue;
  const texts = pairs.map((p) => p[1]), labels = pairs.map((p) => p[2]);
  assert.notDeepEqual(translate(texts, labels), texts, 'unmapped choice: ' + line);
  translatedChoices++;
}
assert(translatedChoices > 80);
// Asset resolution must prefer Chinese overrides while retaining shared files.
assert(loader.resolve('image/title/kagetsu_title01_ch.jpg').includes('chs/arc/'));
assert(loader.resolve('image/event/ren_h02.jpg').includes('chs/arc/'));
assert(!loader.resolve('image/bg/ima_11.jpg').includes('chs/arc/'));

// Every literal picture and sound referenced by the patch must resolve. These five
// stock UI sounds are optional definitions in the original game, not archive files.
const optional = new Set(['click.wav', 'menucancel.wav', 'menuopen.wav', 'menuover.wav', 'turnover.wav']);
let assets = 0;
for (const m of script.matchAll(/"([^"\n]+\.(?:jpg|bmp|png|wav|ogg|mp3))"/gi)) {
  const f = m[1].replace(/^:[^;]*;/, '').replace(/\\/g, '/').toLowerCase();
  if (optional.has(f)) continue;
  if (/^bgm\/\d+\.mp3$/.test(f)) continue; // exercised as engine commands below
  assert(loader.resolve(f), 'unresolved asset: ' + f);
  assets++;
}
for (let no = 2; no <= 18; no++) {
  const sample = new Engine('mp3loop "bgm\\' + String(no).padStart(2, '0') + '.mp3"\n', host);
  await sample.step();
  const canonical = 'cd/track' + String(no).padStart(2, '0');
  assert.equal(played.at(-1)[0], canonical);
  assert(loader.findAudio(canonical), 'missing music: ' + canonical);
  assert(sample.musicLog.has(canonical));
}
const other = new Engine('mp3loop "bgm\\02.mp3"\n', { ...host, lang: 'es' });
await other.step();
assert.equal(played.at(-1)[0], 'bgm\\02.mp3');

// Use the application's actual scene-title parser rather than duplicating its regex.
const main = read('js/main.js');
const parser = main.slice(main.indexOf('function sceneNamesChinese('), main.indexOf('// The same in the Portuguese'));
const sceneNames = vm.runInNewContext(parser + '\nsceneNamesChinese;')(script);
assert(sceneNames.size >= 229, 'Chinese scene titles were not extracted');
assert.equal(sceneNames.get('s100').zone, '宅邸');

// An already-read Chinese scene unlocks its music even without a musicLog record.
const ui = new UI({ ...host, loader });
ui.engine = engine;
engine.labelLog.add('se100');
assert(ui.heardTracks().size > 0);
// No command stands on a line of prose (behind a stray bracket, or after a closing one), where it
// would be shown as the story's words.
for (const line of script.split('\n')) {
  if (/^[^\x00-\x7f]/.test(line)) assert(!/image\\|%type_|[」』]br\s*$/.test(line), 'a command on a line of prose: ' + line.slice(0, 40));
}
// Force a repeated daily message, then a fresh one: it must execute rnd again.
const begin = script.indexOf('rnd %msgno,208\n;inc %msgno');
assert(begin >= 0);
const end = script.indexOf('mov %lastmsgno2', begin);
const rolls = [0.1, 0.2];
const daily = new Engine('numalias msgno,1\nnumalias lastmsgno0,2\nnumalias lastmsgno1,3\nnumalias lastmsgno2,4\n'
  + script.slice(begin, end) + 'end\n', { ...host, random: () => { assert(rolls.length); return rolls.shift(); } });
daily.setNum(2, 20);
for (let steps = 0; daily.getNum(1) !== 41 && steps < 30; steps++) await daily.step();
assert.equal(daily.getNum(1), 41, 'daily-message re-roll got stuck');
assert.equal(rolls.length, 0);
assert.equal(warnings.length, 0);
console.log('Chinese integration checks passed: ' + assets + ' asset references, 17 music tracks, '
  + sceneNames.size + ' scene titles, shared resources, fonts and all existing UI dictionary keys.');
