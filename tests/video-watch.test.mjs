import test from 'node:test';
import assert from 'node:assert/strict';
import { findVideoLink, videoFromHistory, linkTimestamps, watchErrorText, hedgedWatch } from '../lib/video-watch.js';

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

/* Перебор моделей: зависшая, удалённая (404) и перегруженная (503) не мешают. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fake(plan) {
  const calls = [];
  const run = (model, signal, onText) => {
    calls.push(model);
    const p = plan[model];
    return new Promise((resolve, reject) => {
      const fail = (st) => { const e = new Error('gemini ' + st); e.status = st; e.body = ''; reject(e); };
      signal.addEventListener('abort', () => fail(499));
      if (p.hang) return;
      setTimeout(() => {
        if (p.status) return fail(p.status);
        onText(p.text); resolve(p.text);
      }, p.ms || 5);
    });
  };
  return { run, calls };
}
test('hedgedWatch: skips hung / 404 / 503 models and streams from a live one', async () => {
  const f = fake({ a: { hang: true }, b: { status: 404 }, c: { status: 503 }, d: { text: 'ok' } });
  let out = '';
  const r = await hedgedWatch(['a', 'b', 'c', 'd'], f.run, (t) => { out += t; }, 30);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'd');
  assert.equal(out, 'ok');
});
test('hedgedWatch: all busy → rate_limited flag', async () => {
  const f = fake({ a: { status: 503 }, b: { status: 503 } });
  const r = await hedgedWatch(['a', 'b'], f.run, () => {}, 30);
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.equal(f.calls.filter((m) => m === 'a').length, 2); // один повтор
});
test('hedgedWatch: slow first model is not cut when it answers first', async () => {
  const f = fake({ a: { text: 'first', ms: 50 }, b: { text: 'second', ms: 200 } });
  let out = '';
  const r = await hedgedWatch(['a', 'b'], f.run, (t) => { out += t; }, 20);
  assert.equal(r.model, 'a');
  assert.equal(out, 'first');
  await sleep(10);
});
