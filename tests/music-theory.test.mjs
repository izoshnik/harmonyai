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
