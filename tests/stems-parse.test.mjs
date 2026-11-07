/* Разбор трека на партии: что пользователь просит убрать или оставить.
   Нейросеть делит на ударные, бас, «остальное» и вокал — флейту, скрипку и
   т. п. отдельно не убрать, это должно честно попасть в unsupported. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../js/hm-stems.js');
const { parse } = globalThis.HmStems;
// порядок партий: [ударные, бас, остальное, вокал]

test('минусовка и «убери вокал»', () => {
  for (const q of ['убери вокал', 'Убери вокал из этого трека', 'сделай минусовку', 'убери слова', 'караоке версия']) {
    assert.deepEqual(parse(q).keep, [1, 1, 1, 0], q);
    assert.equal(parse(q).label, 'без вокала');
  }
});

test('оставить только партию', () => {
  assert.deepEqual(parse('оставь только голос').keep, [0, 0, 0, 1]);
  assert.deepEqual(parse('сделай акапеллу').keep, [0, 0, 0, 1]);
  assert.deepEqual(parse('выдели барабаны').keep, [1, 0, 0, 0]);
  assert.equal(parse('выдели барабаны').label, 'только ударные');
});

test('убрать бас и ударные', () => {
  assert.deepEqual(parse('убери бас').keep, [1, 0, 1, 1]);
  assert.deepEqual(parse('убери басы').keep, [1, 0, 1, 1]);
  assert.deepEqual(parse('без баса и ударных').keep, [0, 0, 1, 1]);
});

test('флейта, скрипка, контрабас — честно «не умею», бас не путается с контрабасом', () => {
  const f = parse('убери партию флейт');
  assert.equal(f.keep, null);
  assert.deepEqual(f.unsupported, ['флейт']);
  assert.equal(parse('убери контрабас').keep, null);
  const mix = parse('убери флейту и бас');
  assert.deepEqual(mix.keep, [1, 0, 1, 1]);
  assert.deepEqual(mix.unsupported, ['флейту']);
});

test('не просьба о разделении', () => {
  for (const q of ['разбери трек', 'что за трек', 'загрузи в яндекс', '']) assert.equal(parse(q), null, q);
});
