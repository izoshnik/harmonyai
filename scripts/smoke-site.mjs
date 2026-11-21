import assert from 'node:assert/strict';

const site = 'https://harmonyai.ru';
const routes = ['/', '/login', '/chat', '/help', '/about', '/subscribe', '/sw.js', '/js/hm-rich.js'];
const failed = [];

async function check(name, work) {
  try { await work(); console.log('OK ' + name); }
  catch (error) {
    failed.push(name);
    console.error('FAIL ' + name + ': ' + error.message);
  }
}

await Promise.all(routes.map(path => check(path, async () => {
  const response = await fetch(site + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy'));
  assert.ok((await response.text()).length > 100);
})));

const key = process.env.HARMONYAI_SMOKE_KEY;
if (key) {
  await check('вход и ответы моделей', async () => {
    const headers = { 'Content-Type': 'application/json', Origin: site };
    const login = await fetch(site + '/api/account', {
      method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ action: 'dev_instant_login', email: 'devharmonyai0802@dev.dev', key })
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    if (!session.access_token) throw new Error('Нет сессии dev-аккаунта');
    const models = process.env.HARMONYAI_SMOKE_SION === '1' ? ['lite', 'pro', 'sion'] : ['lite', 'pro'];
    for (const model of models) await check(model, async () => {
      const response = await fetch(site + '/api/chat', {
        method: 'POST', redirect: 'error', headers: { ...headers, Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({ model, effort: 'low', temporary: true, stream: true, webSearch: 'off', messages: [{ role: 'user', content: 'Ответь только числом. Сколько будет 17 + 25?' }] }),
        signal: AbortSignal.timeout(85000)
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const error = events.find(event => event.type === 'error');
      assert.ok(!error, 'Ответ оборван: ' + (error?.code || 'без кода'));
      const done = events.findLast(event => event.type === 'done');
      assert.ok(done && /\b42\b/.test(done.text || ''), 'Ответ не завершён или неверен');
    });
  });
} else {
  console.log('SKIP модели: нужен секрет HARMONYAI_SMOKE_KEY');
}

if (failed.length) process.exitCode = 1;
