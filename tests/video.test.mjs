import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, detectVoice, baseTitle, titleMatches, fmtQuery, scoreItem, collectEpisodes, normalizeIntent, mapVkItem } from '../lib/video.js';

test('сезон и серия из разных форматов', () => {
  assert.deepEqual(parseEpisode('Мандалорец 2 сезон 3 серия LostFilm'), { season: 2, episode: 3 });
  assert.deepEqual(parseEpisode('The Mandalorian S02E03 1080p'), { season: 2, episode: 3 });
  assert.deepEqual(parseEpisode('Мандалорец 2x03'), { season: 2, episode: 3 });
  assert.deepEqual(parseEpisode('Сезон 1 Серия 12'), { season: 1, episode: 12 });
  assert.deepEqual(parseEpisode('Интерстеллар (2014) 1080p'), { season: 0, episode: 0 });
  assert.deepEqual(parseEpisode('Ведьмак 3-й сезон 8-я серия'), { season: 3, episode: 8 });
});

test('озвучка', () => {
  assert.equal(detectVoice('Мандалорец 2x03 LostFilm'), 'LostFilm');
  assert.equal(detectVoice('Интерстеллар дубляж 1080'), 'Дубляж');
  assert.equal(detectVoice('Interstellar original ENG'), 'Оригинал');
  assert.equal(detectVoice('Шрек (Гоблин)'), 'Гоблин');
  assert.equal(detectVoice('Интерстеллар 2014'), '');
});

test('сравнение названий', () => {
  assert.equal(baseTitle('Мандалорец 2 сезон 3 серия [LostFilm] 1080p'), 'мандалорец');
  assert.ok(titleMatches('Мандалорец 2 сезон 3 серия', 'Мандалорец'));
  assert.ok(!titleMatches('Ведьмак 1 серия', 'Мандалорец'));
  assert.equal(fmtQuery({ title: 'Мандалорец', season: 2, episode: 3, voice: 'LostFilm' }), 'Мандалорец 2 сезон 3 серия LostFilm');
  assert.equal(fmtQuery({ title: 'Интерстеллар', year: 2014, kind: 'movie' }), 'Интерстеллар 2014');
});

test('подбор нужной серии и фильма', () => {
  const intent = normalizeIntent({ kind: 'series', title: 'Мандалорец', season: 2, episode: 3 });
  assert.equal(intent.kind, 'episode');
  const mk = (title, duration, views = 1000) => ({ source: 'vk', title, duration, views, ...parseEpisode(title), voice: detectVoice(title), lang: '' });
  const items = [mk('Мандалорец 2 сезон 2 серия', 2400), mk('Мандалорец 2 сезон 3 серия', 2400), mk('Мандалорец трейлер', 120, 900000)];
  items.forEach(i => { i._score = scoreItem(i, intent); });
  items.sort((a, b) => b._score - a._score);
  assert.equal(items[0].episode, 3);
  const eps = collectEpisodes(items, intent);
  assert.deepEqual(eps.map(e => e.episode), [2, 3]);
  const movie = normalizeIntent({ kind: 'movie', title: 'Интерстеллар' });
  const a = mk('Интерстеллар фильм', 10140, 10), b = mk('Интерстеллар трейлер', 150, 5000000);
  assert.ok(scoreItem(a, movie) > scoreItem(b, movie));
});

test('VK: только встраиваемые ролики', () => {
  assert.equal(mapVkItem({ id: 1, owner_id: -2, title: 'x', player: 'https://www.youtube.com/embed/abc' }), null);
  const v = mapVkItem({ id: 1, owner_id: -2, title: 'Мандалорец S01E01', duration: 2000, player: 'https://vk.com/video_ext.php?oid=-2&id=1&hash=h', image: [{ url: 'a', width: 320 }, { url: 'b', width: 800 }] });
  assert.equal(v.id, '-2_1');
  assert.equal(v.episode, 1);
  assert.equal(v.image, 'b');
});
