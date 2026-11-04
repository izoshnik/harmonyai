/* Gemini как провайдер чата: адрес, авторизация с перебором способов,
   запасные служебные модели и минутная пауза после 502 провайдера. */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'AQ.test-key';
process.env.OPENAI_API_KEY = 'sk-proai';
process.env.OPENROUTER_API_KEY = 'sk-or';

const models = await import('../lib/models.js');

test('gemini-* модели идут в OpenAI-совместимый шлюз Google', () => {
  const pr = models.providerForModel('gemini-3.5-flash-lite');
  assert.equal(pr.gemini, true);
  assert.equal(pr.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(pr.apiKey, 'AQ.test-key');
  assert.equal(models.providerForModel('nvidia/nemotron-3.5-super-vl:free').openrouter, true);
  assert.equal(models.providerForModel('deepseek-v4-flash').gemini, undefined);
  assert.equal(models.geminiChatModel(), 'gemini-3.5-flash-lite');
});

test('providerFetch: заголовок x-goog-api-key, при 401 — ?key=, и запоминает способ', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const viaQuery = /[?&]key=/.test(url);
    return new Response(viaQuery ? '{"ok":1}' : '{"error":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}', { status: viaQuery ? 200 : 401 });
  };
  try {
    const pr = models.providerForModel('gemini-3.5-flash-lite');
    const r = await models.providerFetch(pr, '/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(calls[0].headers['x-goog-api-key'], 'AQ.test-key');
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.match(calls[1].url, /\/chat\/completions\?key=AQ\.test-key$/);
    assert.equal(calls[1].headers['x-goog-api-key'], undefined);
    calls.length = 0;
    await models.providerFetch(pr, '/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(calls.length, 1, 'второй запрос сразу сработавшим способом');
    assert.match(calls[0].url, /\?key=/);
    // Остальные провайдеры — обычный Bearer.
    calls.length = 0;
    await models.providerFetch(models.providerForModel('deepseek-v4-flash'), '/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-proai');
  } finally { globalThis.fetch = realFetch; }
});

test('минутная пауза модели после 502 провайдера', () => {
  assert.equal(models.isProviderOutage(502, ''), true);
  assert.equal(models.isProviderOutage(400, 'The requested model response could not be verified'), true);
  assert.equal(models.isProviderOutage(429, 'rate limit'), false);
  models.coolDownModel('glm-5.3-flash', 50);
  assert.equal(models.isCoolingDown('glm-5.3-flash'), true);
  assert.equal(models.isCoolingDown('deepseek-v4-flash'), false);
});

test('служебная задача: основная упала 502 → отвечает Gemini, следующая сразу идёт к Gemini', async () => {
  const { utilityChat } = await import('../lib/ai-tasks.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (/pro-ai/.test(url)) return new Response('{"error":{"message":"could not be verified"}}', { status: 502 });
    if (/googleapis/.test(url)) {
      assert.equal(body.response_format, undefined, 'шлюзу Gemini response_format не шлём');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  };
  try {
    const r = await utilityChat([{ role: 'user', content: 'hi' }], { maxTokens: 50, timeoutMs: 3000 });
    assert.equal(r.text, '{"ok":true}');
    assert.deepEqual(seen, ['deepseek-v4-flash', 'gemini-3.5-flash-lite']);
    seen.length = 0;
    await utilityChat([{ role: 'user', content: 'hi' }], { maxTokens: 50, timeoutMs: 3000 });
    assert.deepEqual(seen, ['gemini-3.5-flash-lite'], 'pro-ai на минутной паузе — сразу запасная');
  } finally { globalThis.fetch = realFetch; }
});

test('чат: Adan начинается с Gemini Flash Lite, Pro — glm → Gemini Flash → Adan', async () => {
  const { __routing: R } = await import('../api/chat.js');
  const free = R.selectRoute({}, 'lite', [{ role: 'user', content: 'привет' }]).models;
  assert.equal(free[0], 'gemini-3.5-flash-lite');
  assert.ok(free.includes('nvidia/nemotron-3.5-super-vl:free'));
  const pro = R.selectRoute({ plan: 'pro', pro_until: new Date(Date.now() + 864e5).toISOString(), is_pro: true, role: 'pro' }, 'pro', [{ role: 'user', content: 'привет' }]).models;
  if (pro[0] !== 'gemini-3.5-flash-lite') { // профиль распознан как Pro
    assert.equal(pro[0], 'glm-5.3-flash');
    assert.equal(pro[1], 'gemini-3.5-flash');
  }
  // С фото первой тоже Gemini (видит изображения).
  const img = R.selectRoute({}, 'lite', [{ role: 'user', content: [{ type: 'text', text: 'что тут' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }]).models;
  assert.equal(img[0], 'gemini-3.5-flash-lite');
});

test('чат: «free-models-per-day» у одной :free модели выключает все :free до сброса', async () => {
  const { __routing: R } = await import('../api/chat.js');
  R.markModelExhausted('nvidia/nemotron-3.5-super-vl:free', 'Rate limit exceeded: free-models-per-day. Add 10 credits');
  const chain = R.selectRoute({}, 'lite', [{ role: 'user', content: 'привет' }]).models;
  assert.equal(chain[0], 'gemini-3.5-flash-lite');
  const firstFree = chain.findIndex((m) => /:free$/.test(m));
  assert.ok(firstFree > chain.indexOf('gemini-3.5-flash-lite'), 'все :free — после живых моделей: ' + chain.join(','));
  assert.equal(R.isModelExhausted('thinkingmachines/inkling:free'), true);
});

test('чат: тело запроса к Gemini — без параметров OpenRouter, с запасом токенов на рассуждения', async () => {
  const { __routing: R } = await import('../api/chat.js');
  const msgs = [{ role: 'user', content: 'привет' }];
  const fast = R.providerBodyVariants('gemini-3.5-flash-lite', msgs, 800, '', true);
  assert.equal(fast.length, 1);
  assert.equal(fast[0].max_tokens, 800 + 2048);
  assert.equal(fast[0].min_p, undefined);
  assert.equal(fast[0].reasoning, undefined);
  assert.equal(fast[0].reasoning_effort, undefined);
  const deep = R.providerBodyVariants('gemini-3.5-flash-lite', msgs, 800, 'xhigh', true);
  assert.equal(deep[0].reasoning_effort, 'high');
  assert.equal(deep[1].reasoning_effort, undefined);
});
