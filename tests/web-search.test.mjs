import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../lib/web-search.js';
import { currentModelName, pickModel, FREE_TEXT_MODEL } from '../lib/models.js';

test('searchWeb: planned queries run in parallel, results interleave without duplicate links', async () => {
  const realFetch = globalThis.fetch;
  process.env.BRAVE_SEARCH_API_KEY = 'test';
  delete process.env.TAVILY_API_KEY;
  const seen = [];
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams.get('q');
    seen.push(q);
    const n = q === 'a' ? ['1', '2', 'same'] : ['3', 'same', '4'];
    return new Response(JSON.stringify({ web: { results: n.map((x) => ({ url: 'https://ex.com/' + x, title: x, description: x })) } }), { status: 200 });
  };
  try {
    const r = await searchWeb('Найди мне что-нибудь', { max: 5, queries: ['a', 'b'] });
    assert.deepEqual(seen.sort(), ['a', 'b']);
    assert.deepEqual(r.queries, ['a', 'b']);
    assert.deepEqual(r.results.map((x) => x.title), ['1', '3', '2', 'same', '4']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('models: retired provider names map to current ones', () => {
  assert.equal(currentModelName('deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(pickModel('deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(FREE_TEXT_MODEL, 'deepseek-v4-flash');
  assert.equal(currentModelName('glm-5.3-flash'), 'glm-5.3-flash');
});
