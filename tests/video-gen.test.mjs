import test from 'node:test';
import assert from 'node:assert/strict';
import { startVideoJob, pollVideoJob, signJob, readJob } from '../lib/video-gen.js';

test('video-gen: quote → create with max_cost_usd, then poll → download', async () => {
  const real = globalThis.fetch;
  process.env.CLOSEROUTER_API_KEY = 'k';
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (/\/videos\/quote$/.test(url)) return new Response(JSON.stringify({ max_cost_usd: '0.1' }), { status: 200 });
    if (/\/videos$/.test(url)) return new Response(JSON.stringify({ id: 'T1', status: 'pending' }), { status: 202 });
    if (/\/videos\/T1$/.test(url)) return new Response(JSON.stringify({ id: 'T1', status: 'completed', unsigned_urls: ['https://api.closerouter.dev/v1/videos/T1/content?index=0'] }), { status: 200 });
    if (/content\?index=0$/.test(url)) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const j = await startVideoJob('a cat', { aspect: '9:16' });
    assert.equal(j.job, 'T1');
    assert.equal(calls[1].body.max_cost_usd, '0.1');
    assert.equal(calls[1].body.model, 'bytedance/seedance-1.5-pro');
    assert.equal(calls[1].body.aspect_ratio, '9:16');
    const p = await pollVideoJob('T1');
    assert.equal(p.status, 'done');
    assert.equal(p.bytes.length, 3);
  } finally { globalThis.fetch = real; delete process.env.CLOSEROUTER_API_KEY; }
});

test('video-gen: expensive quote is refused before any paid request', async () => {
  const real = globalThis.fetch;
  process.env.CLOSEROUTER_API_KEY = 'k';
  let created = false;
  globalThis.fetch = async (url) => {
    if (/quote$/.test(url)) return new Response(JSON.stringify({ max_cost_usd: '2.5' }), { status: 200 });
    created = true; return new Response('{}', { status: 202 });
  };
  try { await assert.rejects(() => startVideoJob('x'), /cap/); assert.equal(created, false); }
  finally { globalThis.fetch = real; delete process.env.CLOSEROUTER_API_KEY; }
});

test('video-gen: job token is bound to the user', () => {
  const t = signJob('T9', 'u1');
  assert.equal(readJob(t, 'u1'), 'T9');
  assert.equal(readJob(t, 'u2'), null);
  assert.equal(readJob(t.slice(0, -2) + 'xx', 'u1'), null);
});

test('video-gen: unavailable model (502 on quote) falls back to the next one', async () => {
  const real = globalThis.fetch;
  process.env.CLOSEROUTER_API_KEY = 'k';
  const created = [];
  globalThis.fetch = async (url, init = {}) => {
    const b = init.body ? JSON.parse(init.body) : {};
    if (/quote$/.test(url)) return b.model === 'bytedance/seedance-1.5-pro'
      ? new Response(JSON.stringify({ error: { message: 'The model is temporarily unavailable. Retry shortly.' } }), { status: 502 })
      : new Response(JSON.stringify({ max_cost_usd: '0.12' }), { status: 200 });
    created.push(b.model);
    return new Response(JSON.stringify({ id: 'T2', status: 'pending' }), { status: 202 });
  };
  try {
    const j = await startVideoJob('coffee');
    assert.equal(j.model, 'bytedance/v1-lite');
    assert.deepEqual(created, ['bytedance/v1-lite']);
  } finally { globalThis.fetch = real; delete process.env.CLOSEROUTER_API_KEY; }
});
