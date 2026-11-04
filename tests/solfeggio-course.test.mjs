import test from 'node:test';
import assert from 'node:assert/strict';
import { COURSE, pickChapters, buildCourseContext } from '../lib/solfeggio-course/index.js';
import { buildMusicTheoryContext } from '../lib/music-theory-router.js';

test('course has 40+ chapters with clean, engine-built text', () => {
  assert.ok(COURSE.length >= 40, String(COURSE.length));
  const ids = new Set();
  for (const c of COURSE) {
    assert.ok(!ids.has(c.id), 'duplicate id ' + c.id); ids.add(c.id);
    assert.ok(c.title && c.text.length > 600, c.id);
    assert.ok(!/undefined|NaN|\[object|null/.test(c.text), c.id);
    assert.ok(Array.isArray(c.grades) && c.grades.length, c.id);
    assert.ok(!/^В (?:До|Ре|Ми|Фа|Соль|Ля|Си)[^:]* (?:мажор|минор):/m.test(c.text), 'case error in ' + c.id);
  }
});

test('tables do not list keys that do not exist', () => {
  const all = COURSE.filter((c) => c.table).map((c) => c.text).join('\n');
  for (const bad of ['соль-бемоль минор', 'до-бемоль минор', 'ре-бемоль минор', 'фа-бемоль', 'ре-диез мажор', 'соль-диез мажор']) {
    assert.ok(!all.toLowerCase().includes(bad), bad);
  }
});

test('engine-computed examples are right', () => {
  const t = (id) => COURSE.find((c) => c.id === id).text;
  assert.match(t('g4-d7'), /соль–си–ре–фа → до–до–до–ми/);
  assert.match(t('g5-d7-inversions'), /фа–соль–си–ре → ми–соль–до–до/);
  assert.match(t('g5-vii7'), /си–ре–фа–ля → до–ми–ми–соль/);
  assert.match(t('g6-characteristic'), /фа–соль♯ → ми–ля/);
  assert.match(t('g8-ii7'), /II65 фа–ля–до–ре → фа–соль–си–ре/);
});

test('chapters are picked by topic and not for unrelated questions', () => {
  const ids = (q) => pickChapters(q).map((c) => c.id);
  assert.ok(ids('построй D65 в ми миноре').includes('g5-d7-inversions'));
  assert.ok(ids('как писать диктант').includes('p-dictation'));
  assert.ok(ids('таблица D7 во всех тональностях').includes('t-d7'));
  assert.deepEqual(ids('у меня ошибка в коде на python'), []);
  assert.deepEqual(ids('привет, как дела?'), []);
  assert.equal(buildCourseContext('Найди этот трек'), '');
  assert.match(buildMusicTheoryContext('что такое тритон и как его разрешить'), /КУРС HARMONYAI/);
});
