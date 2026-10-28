import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgression, buildProgression } from '../lib/music-progressions.js';
import { analyzeMusicQuery } from '../lib/music-theory-router.js';

const C = { tonic: { step: 0, alter: 0 }, mode: 'major' };
const a = { tonic: { step: 5, alter: 0 }, mode: 'minor' };
const labels = (r) => r.groups.map((g) => g.map((e) => e.label).join(' '));

test('T-D-T в C-dur — три положения, как в учебнике', () => {
  const r = buildProgression(C, parseProgression('T-D-T'));
  assert.equal(r.voices, 3);
  assert.deepEqual(labels(r), ['I V₆ I', 'I₆ V₆₄ I₆', 'I₆₄ V I₆₄']);
  assert.match(r.abc, /K:C clef=treble/);
  assert.match(r.abc, /"_V₆"\[B,DG\]/);
});

test('T-S-D-T: S → D без общих звуков — голоса против баса', () => {
  const r = buildProgression(C, parseProgression('T-S-D-T'));
  assert.deepEqual(labels(r), ['I IV₆₄ V₆ I', 'I₆ IV V₆₄ I₆', 'I₆₄ IV₆ V I₆₄']);
});

test('a-moll: доминанта гармоническая (Соль-диез), функции строчными', () => {
  const r = buildProgression(a, parseProgression('T-D-T'));
  assert.match(r.abc, /\^G/);
  assert.match(r.title, /a-moll: t-D-t/);
});

test('D7 → T: четырёхголосие с басовым ключом, септима вниз', () => {
  const r = buildProgression(C, parseProgression('T S K64 D7 T'));
  assert.equal(r.voices, 4);
  assert.match(r.abc, /V:2 clef=bass/);
  for (const g of r.groups) {
    const d7 = g[3], t = g[4];
    const fIdx = d7.notes.findIndex((n, i) => i > 0 && n.step === 3);
    assert.ok(fIdx > 0);
    assert.equal(t.notes[fIdx].step, 2, 'Фа (септима) → Ми');
  }
});

test('роутер находит обороты и тональности', () => {
  const r = analyzeMusicQuery('Построй T-D-T и T-S-D-T в C-dur и a-moll');
  assert.equal(r.tasks.length, 4);
  assert.ok(r.tasks.every((t) => t.abc && /%hm:exact/.test(t.abc)));
  assert.equal(analyzeMusicQuery('Привет, как дела?').musical, false);
});

import { buildSolfeggioContext, CURRICULUM } from '../lib/solfeggio-knowledge.js';
import { buildMusicTheoryContext } from '../lib/music-theory-router.js';

test('база знаний: программа класса и карточки по теме', () => {
  assert.equal(Object.keys(CURRICULUM).length, 9);
  const g = buildSolfeggioContext('Что проходят по сольфеджио в 5 классе?');
  assert.match(g, /5 класс\./);
  const t = buildSolfeggioContext('Как разрешаются характерные интервалы?');
  assert.match(t, /ув2/);
  const d = buildSolfeggioContext('как писать диктант');
  assert.match(d, /диктант/);
  assert.equal(buildSolfeggioContext('Какая погода в Москве?'), '');
});

test('контекст: расчёт ядра + справка', () => {
  const c = buildMusicTheoryContext('Построй D7 в соль мажоре и разреши');
  assert.match(c, /РАСЧЁТ:/);
  assert.match(c, /СПРАВКА ПО СОЛЬФЕДЖИО/);
});
