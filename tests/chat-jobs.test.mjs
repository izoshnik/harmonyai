/* Ответ не теряется при выходе из вкладки: сервер копит ответ по событиям
   потока и сохраняет его, если клиент отвалился; быстрый ответ при живом
   клиенте в базу не пишется вовсе. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
const jobs = await import('../lib/chat-jobs.js');

function fakeRes() {
  const res = new EventEmitter();
  res.out = '';
  res.ended = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.write = (c) => { res.out += c; return true; };
  res.end = () => { res.ended = true; res.writableFinished = true; res.emit('finish'); return res; };
  return res;
}
function mockFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'PATCH') return new Response(JSON.stringify([{ id: 'x' }]), { status: 200 });
    return new Response('', { status: 201 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('быстрый ответ, клиент на связи — в базу ничего не пишется', async () => {
  jobs.__resetChatJobs();
  const f = mockFetch();
  try {
    const req = new EventEmitter(); const res = fakeRes();
    jobs.attachChatJob(req, res, { jobId: 'job12345abc', userId: 'u1' });
    res.write(sse({ type: 'delta', text: 'При' }));
    res.write(sse({ type: 'done', text: 'Привет' }));
    res.end();
    await tick(50);
    assert.equal(f.calls.length, 0);
    assert.match(res.out, /Привет/);
    assert.equal(res.ended, true);
  } finally { f.restore(); }
});

test('клиент отвалился — ответ дописывается и сохраняется', async () => {
  jobs.__resetChatJobs();
  const f = mockFetch();
  try {
    const req = new EventEmitter(); const res = fakeRes();
    jobs.attachChatJob(req, res, { jobId: 'job12345abd', userId: 'u1' });
    res.write(sse({ type: 'search_sources', sources: [{ url: 'https://a.ru', title: 'A' }] }));
    res.write(sse({ type: 'delta', text: 'Первая часть, ' }));
    res.emit('close'); // вкладку свернули — соединение закрылось
    res.write(sse({ type: 'delta', text: 'вторая часть' }));
    res.write(sse({ type: 'done', text: 'Первая часть, вторая часть.' }));
    assert.doesNotMatch(res.out, /вторая/, 'в закрытое соединение не пишем');
    res.end();
    await tick(80);
    const ins = f.calls.find((c) => c.method === 'POST');
    assert.ok(ins, 'запись создана');
    assert.equal(ins.body.id, 'job12345abd');
    assert.equal(ins.body.user_id, 'u1');
    assert.equal(ins.body.status, 'done');
    assert.equal(ins.body.text, 'Первая часть, вторая часть.');
    assert.equal(ins.body.sources[0].url, 'https://a.ru');
  } finally { f.restore(); }
});

test('ошибка в потоке сохраняется как ошибка; неверный id — выключено', async () => {
  jobs.__resetChatJobs();
  const f = mockFetch();
  try {
    assert.equal(jobs.attachChatJob(new EventEmitter(), fakeRes(), { jobId: 'bad id!', userId: 'u1' }), null);
    const req = new EventEmitter(); const res = fakeRes();
    jobs.attachChatJob(req, res, { jobId: 'job12345abe', userId: 'u1' });
    res.emit('close');
    res.write(sse({ type: 'error', message: 'Ошибка сервиса № ABC', code: 'ABC' }));
    res.end();
    await tick(80);
    const ins = f.calls.find((c) => c.method === 'POST');
    assert.equal(ins.body.status, 'error');
    assert.equal(ins.body.error_code, 'ABC');
  } finally { f.restore(); }
});

test('чтение: запись давно не обновлялась — «lost»; чужой пользователь фильтруется', async () => {
  jobs.__resetChatJobs();
  const real = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (u) => {
    url = String(u);
    return new Response(JSON.stringify([{ status: 'running', text: 'полов', updated_at: new Date(Date.now() - 60000).toISOString() }]), { status: 200 });
  };
  try {
    const j = await jobs.readChatJob('job12345abf', 'u9');
    assert.equal(j.status, 'lost');
    assert.equal(j.text, 'полов');
    assert.match(url, /user_id=eq\.u9/);
  } finally { globalThis.fetch = real; }
});
