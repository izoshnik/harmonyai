/* Классификатор картинок: сколько изображений, отдельные промпты для разных,
   поисковый запрос остаётся на сервере. */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'sk-test';
delete process.env.GEMINI_API_KEY;
const { handler } = await import('../lib/util-intent.js');

function call(body) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 0,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, data: d }); return this; },
      end() { resolve({ status: this.statusCode }); return this; }
    };
    handler({ method: 'POST', body, headers: {} }, res);
  });
}

test('«три фото разных деревьев» → count 3 и три отдельных промпта', async () => {
  const realFetch = globalThis.fetch;
  let sys = '';
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    sys = b.messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      need_image: true, count: 3, image_prompt: 'photorealistic oak tree', image_prompts: ['photorealistic oak tree', 'photorealistic birch tree', 'photorealistic pine tree'], reference_query: '', clarify: false, clarify_question: ''
    }) } }] }), { status: 200 });
  };
  try {
    const r = await call({ message: 'Создай три фото разных деревьев, ультрареалистичные фото', history: [] });
    assert.equal(r.status, 200);
    assert.equal(r.data.need_image, true);
    assert.equal(r.data.count, 3);
    assert.equal(r.data.image_prompts.length, 3);
    assert.equal(r.data.reference_query, undefined, 'поисковый запрос клиенту не уходит');
    assert.match(sys, /Ничего не выдумывай/);
  } finally { globalThis.fetch = realFetch; }
});

test('без count и с одним промптом — одна картинка; поиск без результатов не меняет промпт', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/chat\/completions/.test(String(url))) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"need_image":true,"image_prompt":"new phone render","image_prompts":["only one"],"reference_query":"новый телефон 2026"}' } }] }), { status: 200 });
    }
    return new Response('{}', { status: 200 }); // поисковики ничего не нашли
  };
  try {
    const r = await call({ message: 'нарисуй новый телефон', history: [] });
    assert.equal(r.data.count, 1);
    assert.deepEqual(r.data.image_prompts, []);
    assert.equal(r.data.image_prompt, 'new phone render');
  } finally { globalThis.fetch = realFetch; }
});
