import test from 'node:test';
import assert from 'node:assert/strict';
import { findVideoLink, videoFromHistory, linkTimestamps, watchErrorText } from '../lib/video-watch.js';

test('ссылки YouTube и TikTok', () => {
  assert.equal(findVideoLink('глянь https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s').id, 'dQw4w9WgXcQ');
  assert.equal(findVideoLink('https://youtu.be/dQw4w9WgXcQ?t=42').start, 42);
  assert.equal(findVideoLink('https://youtube.com/shorts/abcdefghijk').id, 'abcdefghijk');
  const tt = findVideoLink('что тут https://www.tiktok.com/@user/video/7234567890123456789?lang=ru');
  assert.equal(tt.platform, 'tiktok');
  assert.equal(tt.key, 'tt:7234567890123456789');
  assert.equal(findVideoLink('https://vm.tiktok.com/ZMabc123/').platform, 'tiktok');
  assert.equal(findVideoLink('просто текст про youtube'), null);
});

test('продолжение разговора о ролике', () => {
  const msgs = [
    { role: 'user', content: 'опиши https://youtu.be/dQw4w9WgXcQ' },
    { role: 'assistant', content: 'В ролике…' },
    { role: 'user', content: 'а что происходит на 1:20?' }
  ];
  assert.equal(videoFromHistory(msgs, 'а что происходит на 1:20?').id, 'dQw4w9WgXcQ');
  assert.equal(videoFromHistory(msgs, 'какая погода в Москве'), null);
});

test('таймкоды становятся ссылками на YouTube', () => {
  const link = findVideoLink('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(linkTimestamps('[01:05] Начало', link), '[01:05](https://youtu.be/dQw4w9WgXcQ?t=65) Начало');
  assert.equal(linkTimestamps('[1:02:03] Финал', link), '[1:02:03](https://youtu.be/dQw4w9WgXcQ?t=3723) Финал');
  assert.equal(linkTimestamps('[01:05] x', findVideoLink('https://vm.tiktok.com/ZMabc/')), '[01:05] x');
  assert.match(watchErrorText({ error: 'quota' }), /лимит Free/);
});
