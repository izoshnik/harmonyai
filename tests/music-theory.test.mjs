/* Юнит-тесты музыкального ядра: ответы сверены с учебниками ЭТМ/сольфеджио ДМШ.
   Запуск: npm test  (или node --test tests/) */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../lib/music-theory.js';
import { analyzeMusicQuery, buildMusicTheoryContext } from '../lib/music-theory-router.js';

const k = (step, alter, mode) => ({ tonic: { step, alter }, mode });
const names = (notes) => notes.map(M.noteName).join(' ');
const STEP = { 'До': 0, 'Ре': 1, 'Ми': 2, 'Фа': 3, 'Соль': 4, 'Ля': 5, 'Си': 6 };

test('интервал строится по ступеням: б3 от Ми = Соль-диез, не Ля-бемоль', () => {
  assert.equal(M.noteName(M.buildInterval(M.note(2, 0), 'б3')), 'Соль-диез');
  assert.equal(M.noteName(M.buildInterval(M.note(5, -1), 'б3')), 'До');
  assert.equal(M.noteName(M.buildInterval(M.note(6, 1), 'м2')), 'До-диез');
  assert.equal(M.noteName(M.buildInterval(M.note(3, 1), 'ч5', 'down')), 'Си');
  assert.equal(M.noteName(M.buildInterval(M.note(4, 1), 'б3')), 'Си-диез');
  assert.equal(M.noteName(M.buildInterval(M.note(0, 0), 'ув4')), 'Фа-диез');
  assert.equal(M.noteName(M.buildInterval(M.note(0, 0), 'ум5')), 'Соль-бемоль');
  assert.equal(M.noteName(M.buildInterval(M.note(2, 0), 'ум7')), 'Ре-бемоль');
  assert.equal(M.buildInterval(M.note(6, 2), 'ув4'), null); // тройной диез не строим
});

test('анализ интервала', () => {
  assert.equal(M.analyzeInterval(M.note(0, 0), M.note(4, 1)).code, 'ув5');
  assert.equal(M.analyzeInterval(M.note(3, 0), M.note(6, 0)).code, 'ув4');
  assert.equal(M.analyzeInterval(M.note(6, 0), M.note(3, 0, 5)).code, 'ум5');
  assert.equal(M.analyzeInterval(M.note(0, 0), M.note(1, 0, 5)).code, 'б9');
});

test('30 тональностей и ключевые знаки', () => {
  let count = 0;
  for (let step = 0; step < 7; step++) for (const alter of [-1, 0, 1]) for (const mode of ['major', 'minor']) {
    if (M.isValidKey(k(step, alter, mode))) count++;
  }
  assert.equal(count, 30);
  assert.deepEqual(M.keySignatureNotes(k(0, 1, 'major')).map(M.noteName), ['Фа-диез', 'До-диез', 'Соль-диез', 'Ре-диез', 'Ля-диез', 'Ми-диез', 'Си-диез']);
  assert.deepEqual(M.keySignatureNotes(k(0, -1, 'major')).map(M.noteName), ['Си-бемоль', 'Ми-бемоль', 'Ля-бемоль', 'Ре-бемоль', 'Соль-бемоль', 'До-бемоль', 'Фа-бемоль']);
  assert.equal(M.keySignature(k(2, -1, 'minor')), -6); // es-moll
  assert.equal(M.keyNameGerman(k(6, -1, 'major')), 'B-dur');
  assert.equal(M.keyNameGerman(k(5, -1, 'major')), 'As-dur');
  assert.equal(M.keyNameGerman(k(3, 1, 'minor')), 'fis-moll');
  assert.equal(M.keyName(M.relativeKey(k(1, 0, 'major'))), 'Си минор');
});

test('гаммы: натуральный, гармонический, мелодический вид', () => {
  assert.equal(names(M.scaleNotes(k(0, 1, 'major'))), 'До-диез Ре-диез Ми-диез Фа-диез Соль-диез Ля-диез Си-диез До-диез');
  assert.equal(names(M.scaleNotes(k(5, 0, 'minor'), 'harmonic')), 'Ля Си До Ре Ми Фа Соль-диез Ля');
  assert.equal(names(M.scaleNotes(k(5, 0, 'minor'), 'melodic', 'up')), 'Ля Си До Ре Ми Фа-диез Соль-диез Ля');
  assert.equal(names(M.scaleNotes(k(5, 0, 'minor'), 'melodic', 'down')), 'Ля Соль Фа Ми Ре До Си Ля');
  assert.equal(names(M.scaleNotes(k(0, 0, 'major'), 'harmonic')), 'До Ре Ми Фа Соль Ля-бемоль Си До');
  assert.equal(names(M.scaleNotes(k(0, 0, 'major'), 'melodic', 'down')), 'До Си-бемоль Ля-бемоль Соль Фа Ми Ре До');
  assert.equal(names(M.scaleNotes(k(4, 1, 'minor'), 'harmonic')), 'Соль-диез Ля-диез Си До-диез Ре-диез Ми Фа-дубль-диез Соль-диез');
});

test('тритоны и их разрешение (ув4 → секста, ум5 → терция)', () => {
  const tri = (key, type, code) => M.intervalsInKey(key, type, code).map((x) => `${names([x.low, x.high])}>${names(x.resolution.to)}:${x.resolution.toInterval.code}`);
  assert.deepEqual(tri(k(0, 0, 'major'), 'natural', 'ув4'), ['Фа Си>Ми До:м6']);
  assert.deepEqual(tri(k(0, 0, 'major'), 'natural', 'ум5'), ['Си Фа>До Ми:б3']);
  assert.deepEqual(tri(k(5, 0, 'minor'), 'natural', 'ув4'), ['Фа Си>Ми До:м6']);
  assert.deepEqual(tri(k(5, 0, 'minor'), 'natural', 'ум5'), ['Си Фа>До Ми:б3']);
  assert.ok(tri(k(5, 0, 'minor'), 'harmonic', 'ув4').includes('Ре Соль-диез>До Ля:б6'));
  assert.ok(tri(k(5, 0, 'minor'), 'harmonic', 'ум5').includes('Соль-диез Ре>Ля До:м3'));
  assert.ok(tri(k(0, 0, 'major'), 'harmonic', 'ув4').includes('Ля-бемоль Ре>Соль Ми:б6'));
  assert.ok(tri(k(0, 0, 'major'), 'harmonic', 'ум5').includes('Ре Ля-бемоль>Ми Соль:м3'));
});

test('характерные интервалы гармонического минора', () => {
  const one = (code) => { const x = M.intervalsInKey(k(5, 0, 'minor'), 'harmonic', code)[0]; return `${names([x.low, x.high])}>${x.resolution.toInterval.code}`; };
  assert.equal(one('ув2'), 'Фа Соль-диез>ч4');
  assert.equal(one('ум7'), 'Соль-диез Фа>ч5');
  assert.equal(one('ув5'), 'До Соль-диез>б6');
  assert.equal(one('ум4'), 'Соль-диез До>м3');
});

test('D7 и обращения с разрешением', () => {
  const r = (key, code) => { const c = M.buildChordInKey(key, code); return `${names(c.notes)}>${names(c.resolution.to)}`; };
  assert.equal(r(k(0, 0, 'major'), 'D7'), 'Соль Си Ре Фа>До До До Ми');
  assert.equal(r(k(0, 0, 'major'), 'D65'), 'Си Ре Фа Соль>До До Ми Соль');
  assert.equal(r(k(0, 0, 'major'), 'D43'), 'Ре Фа Соль Си>До Ми Соль До');
  assert.equal(r(k(0, 0, 'major'), 'D2'), 'Фа Соль Си Ре>Ми Соль До До');
  assert.equal(r(k(5, 0, 'minor'), 'D7'), 'Ми Соль-диез Си Ре>Ля Ля Ля До');
  assert.equal(r(k(2, -1, 'minor'), 'D7'), 'Си-бемоль Ре Фа Ля-бемоль>Ми-бемоль Ми-бемоль Ми-бемоль Соль-бемоль');
});

test('вводные септаккорды', () => {
  const c1 = M.buildChordInKey(k(0, 0, 'major'), 'МVII7');
  assert.equal(names(c1.notes), 'Си Ре Фа Ля');
  assert.equal(names(c1.resolution.to), 'До Ми Ми Соль');
  const c2 = M.buildChordInKey(k(0, 0, 'major'), 'УмVII7');
  assert.equal(names(c2.notes), 'Си Ре Фа Ля-бемоль');
  const c3 = M.buildChordInKey(k(5, 0, 'minor'), 'VII7');
  assert.equal(names(c3.notes), 'Соль-диез Си Ре Фа');
  assert.equal(names(c3.resolution.to), 'Ля До До Ми');
  assert.ok(M.buildChordInKey(k(5, 0, 'minor'), 'МVII7').error);
});

test('трезвучия: главные, обращения, побочные', () => {
  assert.equal(names(M.buildChordInKey(k(1, 0, 'major'), 'S64').notes), 'Ре Соль Си');
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'D6').notes), 'Соль-диез Си Ми');
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'увIII53').notes), 'До Ми Соль-диез');
  assert.ok(M.buildChordInKey(k(0, 0, 'major'), 'увIII53').error);
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'II7').notes), 'Ре Фа Ля До');
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'II2').notes), 'До Ре Фа Ля');
});

test('аккорды от звука', () => {
  assert.equal(names(M.buildChordFromNote(M.note(1, 0), 'Б6').notes), 'Ре Фа Си-бемоль');
  assert.equal(names(M.buildChordFromNote(M.note(2, 0), 'Ув53').notes), 'Ми Соль-диез Си-диез');
  const d7 = M.buildChordFromNote(M.note(1, 0), 'D7').variants.map((v) => v.key);
  assert.deepEqual(d7, ['Соль мажор', 'Соль минор']);
  const d65 = M.buildChordFromNote(M.note(3, 1), 'D65').variants.map((v) => v.key);
  assert.deepEqual(d65, ['Соль мажор', 'Соль минор']);
});

test('ABC: ключевые и случайные знаки', () => {
  const abc = M.toAbc({ key: k(5, 0, 'minor'), bars: [M.scaleNotes(k(5, 0, 'minor'), 'melodic', 'up'), M.scaleNotes(k(5, 0, 'minor'), 'melodic', 'down')] });
  assert.match(abc, /K:Am/);
  assert.match(abc, /A B c d e \^f \^g a \| a g f e d c B A \|\]/);
  const abc2 = M.toAbc({ key: k(0, 0, 'minor'), bars: [[[M.note(6, 0), M.note(1, 0, 5), M.note(3, 0, 5)]]] });
  assert.match(abc2, /\[=Bdf\]/);
});

test('роутер распознаёт вопросы учеников', () => {
  const t = (q) => analyzeMusicQuery(q).tasks.map((x) => x.text).join('\n');
  assert.match(t('Построй D7 с обращениями в ля миноре'), /D2 в Ля миноре/);
  assert.match(t('Постройте б3 от ми вниз'), /Ми — До/);
  assert.match(t('Какой интервал между до и соль-диезом?'), /ув5/);
  assert.match(t('гамма fis-moll гармоническая'), /Ми-диез/);
  assert.match(t('тритоны в ре мажоре'), /Соль — До-диез/);
  assert.match(t('Б6 от ре'), /Ре — Фа — Си-бемоль/);
  assert.equal(buildMusicTheoryContext('какой твой любимый композитор?'), '');
  assert.match(buildMusicTheoryContext('D7 в соль мажоре'), /```abc/);
});

/* ---------- II7, VII7, DD7, N6, K64, прерванный оборот ---------- */
const paths = (key, code) => {
  const r = M.buildChordInKey(key, code);
  return Object.fromEntries(r.resolutions.map((p) => [p.label, p.steps.map((s) => `${names(s.to)} [${s.result}]`).join(' → ')]));
};

test('II7 и обращения: построение в мажоре и миноре', () => {
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'II7').notes), 'Ре Фа Ля До');
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'II65').notes), 'Фа Ля До Ре');
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'II43').notes), 'Ля До Ре Фа');
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'II7').notes), 'Си Ре Фа Ля');
  assert.match(M.buildChordInKey(k(5, 0, 'minor'), 'II7').quality, /малый уменьшённый/);
});

test('II7: разрешение через доминанту (II7→D43, II65→D2, II43→D7, II2→D65) и дальше в T', () => {
  for (const key of [k(0, 0, 'major'), k(5, 0, 'minor'), k(1, 0, 'major'), k(4, 0, 'minor'), k(2, -1, 'major')]) {
    const via = (code) => M.buildChordInKey(key, code).resolutions.find((p) => p.label === 'через доминанту').steps.map((s) => s.result);
    assert.deepEqual(via('II7'), ['D43', 'T53 с удвоенным основным тоном']);
    assert.deepEqual(via('II65'), ['D2', 'T6 с удвоенным основным тоном']);
    assert.deepEqual(via('II43'), ['D7', 'неполное T53 с утроенным основным тоном']);
    assert.deepEqual(via('II2'), ['D65', 'T53 с удвоенным основным тоном']);
  }
  assert.equal(paths(k(5, 0, 'minor'), 'II7')['через доминанту'], 'Си Ре Ми Соль-диез [D43] → Ля До Ми Ля [T53 с удвоенным основным тоном]');
});

test('II7: прямое разрешение в тонику', () => {
  const p = (code) => paths(k(0, 0, 'major'), code)['прямо в тонику'];
  assert.equal(p('II7'), 'Ми Ми Соль До [T6 с удвоенным терцовым тоном]');
  assert.equal(p('II65'), 'Ми Соль До До [T6 с удвоенным основным тоном]');
  assert.equal(p('II43'), 'Соль До До Ми [T64 с удвоенным основным тоном]');
  assert.equal(p('II2'), 'До До Ми Соль [T53 с удвоенным основным тоном]');
});

test('VII7 и обращения: в тонику с удвоенной терцией и через доминанту', () => {
  for (const key of [k(0, 0, 'major'), k(5, 0, 'minor'), k(3, 1, 'minor')]) {
    const r = (code, label) => M.buildChordInKey(key, code).resolutions.find((p) => p.label === label).steps.map((s) => s.result).join(' → ');
    assert.equal(r('VII7', 'в тонику'), 'T53 с удвоенным терцовым тоном');
    assert.equal(r('VII65', 'в тонику'), 'T6 с удвоенным терцовым тоном');
    assert.equal(r('VII43', 'в тонику'), 'T6 с удвоенным терцовым тоном');
    assert.equal(r('VII2', 'в тонику'), 'T64 с удвоенным терцовым тоном');
    assert.match(r('VII7', 'через доминанту'), /^D65 → /);
    assert.match(r('VII65', 'через доминанту'), /^D43 → /);
    assert.match(r('VII43', 'через доминанту'), /^D2 → /);
    assert.match(r('VII2', 'через доминанту'), /^D7 → /);
  }
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'VII7').notes), 'Соль-диез Си Ре Фа');
});

test('D7: прерванный оборот в VI', () => {
  assert.equal(paths(k(0, 0, 'major'), 'D7')['прерванный оборот (в VI)'], 'Ля До До Ми [VI53 с удвоенным терцовым тоном]');
  assert.equal(paths(k(5, 0, 'minor'), 'D7')['прерванный оборот (в VI)'], 'Фа Ля Ля До [VI53 с удвоенным терцовым тоном]');
});

test('DD7 и обращения — двойная доминанта', () => {
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'DD7').notes), 'Ре Фа-диез Ля До');
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'DD7').notes), 'Си Ре-диез Фа-диез Ля');
  assert.equal(names(M.buildChordInKey(k(4, 0, 'minor'), 'ДД65').notes), 'До-диез Ми Соль Ля');
  const r = (code) => paths(k(0, 0, 'major'), code)['в доминанту'];
  assert.equal(r('DD7'), 'Соль Соль Соль Си [неполное D53 с утроенным основным тоном]');
  assert.equal(r('DD65'), 'Соль Соль Си Ре [D53 с удвоенным основным тоном]');
  assert.equal(r('DD43'), 'Соль Си Ре Соль [D53 с удвоенным основным тоном]');
  assert.equal(r('DD2'), 'Си Ре Соль Соль [D6 с удвоенным основным тоном]');
});

test('N6 и K64', () => {
  assert.equal(names(M.buildChordInKey(k(0, 0, 'major'), 'N6').notes), 'Фа Ля-бемоль Ре-бемоль');
  assert.equal(names(M.buildChordInKey(k(2, 0, 'minor'), 'N6').notes), 'Ля До Фа');
  assert.match(paths(k(0, 0, 'major'), 'N6')['в доминанту'], /^Соль Соль Си /);
  assert.equal(names(M.buildChordInKey(k(5, 0, 'minor'), 'K64').notes), 'Ми Ля До');
  assert.equal(paths(k(5, 0, 'minor'), 'K64')['в доминанту (каданс)'], 'Ми Соль-диез Си [D53]');
});

test('роутер: II7 с обращениями, DD7, N6', () => {
  const t = (q) => analyzeMusicQuery(q).tasks.map((x) => x.text).join('\n');
  const ii = t('II7 и его обращения в ре мажоре');
  assert.match(ii, /II2 в Ре мажоре/);
  assert.match(ii, /через доминанту/);
  assert.match(ii, /прямо в тонику/);
  assert.match(t('ДД7 в соль миноре'), /Ля — До-диез — Ми — Соль/);
  assert.match(t('неаполитанский секстаккорд в ми миноре'), /Ля — До — Фа/);
  assert.match(buildMusicTheoryContext('D7 в до мажоре'), /Не пересчитывай его заново/);
});
