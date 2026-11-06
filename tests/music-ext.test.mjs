/* Audius + Jamendo: нормализация в формат треков Яндекса, отсев закрытых
   треков, ссылки на файл без утечки ключа, проверка id (не открытый редирект). */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JAMENDO_CLIENT_ID = 'jm-test';
const m = await import('../lib/music-ext.js');

function mockFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
}
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });

test('id только своего вида — «au:…»/«jm:…»', () => {
  assert.equal(m.isExtTrackId('au:9OoxA'), true);
  assert.equal(m.isExtTrackId('jm:123456'), true);
  assert.equal(m.isExtTrackId('12345'), false);
  assert.equal(m.isExtTrackId('au:https://evil.example/x'), false);
  assert.equal(m.isExtTrackId('jm:../../etc'), false);
});

test('поиск по обоим каталогам: формат треков Яндекса, закрытые треки отсеяны', async () => {
  const restore = mockFetch((url) => {
    if (url.includes('api.audius.co/v1/tracks/search')) {
      assert.match(url, /app_name=HarmonyAI/);
      return json({ data: [
        { id: 'A1', title: 'Free Song', user: { id: 'U1', name: 'Artist A' }, artwork: { '480x480': 'https://img/a.jpg' }, duration: 200, genre: 'Electronic', is_downloadable: true, permalink: '/artist/free-song' },
        { id: 'A2', title: 'Paid Song', user: { name: 'Artist B' }, stream_conditions: { usdc_purchase: {} } }
      ] });
    }
    if (url.includes('api.jamendo.com/v3.0/tracks/')) {
      assert.match(url, /client_id=jm-test/);
      return json({ results: [{ id: '777', name: 'CC Track', artist_name: 'Artist J', album_image: 'https://img/j.jpg', duration: 180, audio: 'https://prod.jamendo/777.mp3', audiodownload: 'https://prod.jamendo/777dl.mp3', audiodownload_allowed: true, shareurl: 'https://jamendo.com/track/777' }] });
    }
    return json({}, 404);
  });
  try {
    const items = await m.extSearch('song', 5);
    assert.deepEqual(items.map((t) => t.trackId), ['au:A1', 'jm:777']);
    const a = items[0];
    assert.equal(a.source, 'audius');
    assert.equal(a.artist, 'Artist A');
    assert.equal(a.cover, 'https://img/a.jpg');
    assert.equal(a.duration, 200);
    assert.equal(a.downloadable, true);
    assert.equal(a.link, 'https://audius.co/artist/free-song');
    assert.equal(items[1].downloadable, true);
    assert.equal(items[1].source, 'jamendo');
  } finally { restore(); }
});

test('ссылка на файл Audius — из Location (ключ не уходит в браузер); скачивание Jamendo — только если разрешено', async () => {
  process.env.AUDIUS_API_KEY = 'secret';
  const restore = mockFetch((url, init) => {
    if (url.includes('/v1/tracks/A1/stream')) {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers['x-api-key'], 'secret');
      return new Response(null, { status: 302, headers: { location: 'https://node.audius/cid/stream.mp3' } });
    }
    if (url.includes('api.jamendo.com')) return json({ results: [{ id: '5', audio: 'https://j/5.mp3', audiodownload: 'https://j/5dl.mp3', audiodownload_allowed: false }] });
    return json({}, 404);
  });
  try {
    assert.equal(await m.extFileUrl('au:A1'), 'https://node.audius/cid/stream.mp3');
    assert.equal(await m.extFileUrl('jm:5'), 'https://j/5.mp3');
    assert.equal(await m.extFileUrl('jm:5', { download: true }), null, 'автор не разрешил скачивание');
    assert.equal(await m.extFileUrl('12345'), null);
  } finally { restore(); delete process.env.AUDIUS_API_KEY; }
});

test('жанры Яндекса → Audius/Jamendo', () => {
  assert.deepEqual(m.extGenreFor('rusrap'), { audius: 'Hip-Hop/Rap', jamendo: 'hiphop' });
  assert.deepEqual(m.extGenreFor('electronics'), { audius: 'Electronic', jamendo: 'electronic' });
  assert.deepEqual(m.extGenreFor(''), { audius: '', jamendo: '' });
});
