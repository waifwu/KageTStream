// node tools/russian-check.mjs: the Russian script against the English one, and the Russian
// interface against the other languages' (tools/russian.py writes the script).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { setLang, t } from '../js/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const manifest = JSON.parse(read('data/manifest.json'));
assert(manifest.files.includes('script-ru.txt'), 'data/script-ru.txt is not in the manifest');
for (const f of manifest.files.filter((s) => s.startsWith('ru/'))) assert(fs.existsSync(path.join(root, 'data', f)), 'missing: ' + f);

// the script: the English one's lines, in their places; only text and quoted strings differ
const en = read('data/script.txt').split('\n');
const ru = read('data/script-ru.txt').split('\n');
assert.equal(ru.length, en.length, 'the Russian script has another number of lines');
const quoted = /`[^`]*`|"[^"]*"/g;
let text = 0, russian = 0;
const english = [];      // text lines with English words left: the staff room's extras, which the release does not have
ru.forEach((l, i) => {
  const e = en[i];
  if (l === e) return;
  const isText = /^\s*`/.test(l) && !/^\s*`[^`]*`\s*,/.test(l);
  if (isText) {
    text++;
    assert(!/[{}]/.test(l), 'line ' + (i + 1) + ': a Ren\'Py tag is left: ' + l);
    if (/[А-Яа-яЁё]/.test(l)) russian++;
    else if (/[A-Za-z]{3,}/.test(l) && !/AAA/.test(l)) english.push(i + 1);
    return;
  }
  assert.equal(l.replace(quoted, '``'), e.replace(quoted, '``').replace(/^(?=[A-Za-z"'])/, ''), 'line ' + (i + 1) + ' changed outside its strings');
});
assert(russian > 21000, 'only ' + russian + ' lines of text are in Russian');
// (and with no change at all: the staff room's message selector, jukebox and easter eggs, 28 lines)
assert(english.length <= 30, 'English words left on ' + english.length + ' lines, from ' + english.slice(0, 5).join(', '));

// the interface: every word the other languages translate, but the three that read the same
const i18n = read('js/i18n.js');
const table = (name) => {
  const start = i18n.indexOf('const ' + name + ' = {') + ('const ' + name + ' = ').length;
  return vm.runInNewContext('(' + i18n.slice(start, i18n.indexOf('\n};', start) + 2) + ')');
};
const RU = table('RU');
const same = new Set(['Kagetsu Tohya', ', ', 'macOS · Apple silicon']);
for (const name of ['JA', 'PT', 'ES']) for (const k of Object.keys(table(name))) if (!same.has(k)) assert(k in RU, 'no Russian for: ' + k);
setLang('ru');
assert.equal(t('Settings'), 'Настройки');
assert.equal(t('Saved in No. 3.'), 'Сохранено: слот 3.');
assert.equal(t('12 of 229 scenes read'), 'Прочитано сцен: 12 из 229');
assert.equal(t('月夜 - Moonlit Night'), '月夜 — Лунная ночь');
setLang('en');
console.log('Russian checks passed: ' + russian + ' lines of text in Russian, ' + english.length + ' changed lines still with English words; '
  + Object.keys(RU).length + ' interface words; ' + manifest.files.filter((s) => s.startsWith('ru/')).length + ' pictures.');
