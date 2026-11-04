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

test('чат: Adan — от сильной модели к слабой, платная последней; Pro — glm → Gemini Flash → Adan', async () => {
  const { __routing: R } = await import('../api/chat.js');
  const free = R.adanModels();
  // Без ключей NIM/Cerebras/Groq: nemotron-ultra (88) → Gemini Flash Lite (83) → nemotron-super (81) → … → deepseek (платная)
  assert.equal(free[0], 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(free[1], 'gemini-3.5-flash-lite');
  assert.equal(free[2], 'nvidia/nemotron-3.5-super-vl:free');
  assert.equal(free[free.length - 1], 'deepseek-v4-flash');
  const pro = R.selectRoute({ plan: 'pro', pro_until: new Date(Date.now() + 864e5).toISOString(), is_pro: true, role: 'pro' }, 'pro', [{ role: 'user', content: 'привет' }]).models;
  if (pro[0] === 'glm-5.3-flash') assert.equal(pro[1], 'gemini-3.5-flash'); // профиль распознан как Pro
  // С фото первой идёт модель со зрением — Gemini.
  const img = R.selectRoute({}, 'lite', [{ role: 'user', content: [{ type: 'text', text: 'что тут' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }]).models;
  assert.equal(img[0], 'gemini-3.5-flash-lite');
});

test('чат: «free-models-per-day» у одной :free модели выключает все :free до сброса', async () => {
  const { __routing: R } = await import('../api/chat.js');
  R.markModelExhausted('nvidia/nemotron-3.5-super-vl:free', 'Rate limit exceeded: free-models-per-day. Add 10 credits');
  const chain = R.selectRoute({}, 'lite', [{ role: 'user', content: 'привет' }]).models;
  assert.equal(chain[0], 'gemini-3.5-flash-lite', 'живые модели впереди: ' + chain.join(','));
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

test('каталог NIM/Cerebras/Groq: лучшие модели ключа, общий порядок по силе, префикс снимается', async () => {
  process.env.NVIDIA_API_KEY = 'nv'; process.env.GROQ_API_KEY = 'gq'; process.env.CEREBRAS_API_KEY = 'cb';
  const cat = await import('../lib/model-catalog.js');
  cat.__setCatalog('nim', ['z-ai/glm-5.2', 'meta/llama-3.1-8b-instruct', 'nvidia/llama-3.1-nemoguard-8b', 'qwen/qwen3-235b-a22b', 'nvidia/nv-embedqa-e5-v5', 'deepseek-ai/deepseek-v4-flash']);
  cat.__setCatalog('groq', ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'whisper-large-v3', 'llama-3.3-70b-versatile']);
  cat.__setCatalog('cerebras', ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b']);
  assert.deepEqual(cat.providerModels('nim'), ['nim:z-ai/glm-5.2', 'nim:deepseek-ai/deepseek-v4-flash', 'nim:qwen/qwen3-235b-a22b']);
  assert.deepEqual(cat.providerModels('groq'), ['groq:openai/gpt-oss-120b', 'groq:qwen/qwen3-32b', 'groq:llama-3.3-70b-versatile']);
  const chain = cat.rankedFreeChain(['nvidia/nemotron-3.5-super-vl:free']);
  assert.equal(chain[0], 'nim:z-ai/glm-5.2');
  const pos = (m) => chain.indexOf(m);
  assert.ok(pos('groq:openai/gpt-oss-120b') < pos('gemini-3.5-flash-lite'));
  assert.ok(pos('gemini-3.5-flash-lite') < pos('nvidia/nemotron-3.5-super-vl:free'));
  assert.ok(pos('nvidia/nemotron-3.5-super-vl:free') < pos('groq:llama-3.3-70b-versatile'));
  assert.deepEqual(cat.fastUtilityModels(), ['groq:openai/gpt-oss-120b', 'cerebras:gpt-oss-120b']);

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response('{}', { status: 200 }); };
  try {
    const pr = models.providerForModel('groq:openai/gpt-oss-120b');
    await models.providerFetch(pr, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'groq:openai/gpt-oss-120b', messages: [{ role: 'user', content: 'groq:openai/gpt-oss-120b' }] }) });
    assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(seen[0].body.model, 'openai/gpt-oss-120b');
    assert.equal(seen[0].body.messages[0].content, 'groq:openai/gpt-oss-120b', 'текст сообщения не трогаем');
    assert.equal(seen[0].auth, 'Bearer gq');
  } finally { globalThis.fetch = realFetch; }

  const { __routing: R } = await import('../api/chat.js');
  const v = R.providerBodyVariants('groq:openai/gpt-oss-120b', [{ role: 'user', content: 'hi' }], 800, '', true);
  assert.equal(v[0].reasoning_effort, 'low');
  assert.equal(v[0].max_tokens, 3800);
  assert.equal(v[1].reasoning_effort, undefined);
  const g = R.providerBodyVariants('nim:z-ai/glm-5.2', [{ role: 'user', content: 'hi' }], 800, 'high', true);
  assert.equal(g[0].reasoning_effort, undefined, 'GLM reasoning_effort не понимает');
  assert.equal(R.adanModels()[0], 'nim:z-ai/glm-5.2');
  delete process.env.NVIDIA_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.CEREBRAS_API_KEY;
});
