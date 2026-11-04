import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKnowledge } from '../api/chat.js';

test('duplicate textbooks and repeated fragments are collapsed', () => {
  const documents = [
    { id: 'a', title: 'zolina-solfedzhio.pdf', created_at: '2026-06-25' },
    { id: 'b', title: 'zolina-solfedzhio.pdf', created_at: '2026-06-26' },
    { id: 'c', title: 'zolina-solfedzhio.txt', created_at: '2026-06-20' },
    { id: 'd', title: 'Фридкин. Музыкальная грамота', created_at: '2026-06-01' }
  ];
  const chunks = [
    { document_id: 'a', chunk_index: 0, content: 'Тоника — первая ступень лада.' },
    { document_id: 'b', chunk_index: 0, content: 'Тоника — первая ступень лада.' },
    { document_id: 'c', chunk_index: 0, content: 'Тоника —   первая ступень лада.' },
    { document_id: 'd', chunk_index: 0, content: 'Интервал — сочетание двух звуков.' },
    { document_id: 'd', chunk_index: 1, content: 'Интервал — сочетание двух звуков.' }
  ];
  const out = dedupeKnowledge(documents, chunks);
  assert.deepEqual(out.documents.map((d) => d.id).sort(), ['b', 'd']);
  assert.equal(out.chunks.length, 2);
  assert.deepEqual(out.chunks.map((c) => c.document_id).sort(), ['b', 'd']);
});

test('free model chain starts with nemotron and Russian guard detects English answers', async () => {
  const p = await import('../lib/proofread.js');
  assert.equal(p.wantsRussian('Как разрешить D65 в ми миноре?'), true);
  assert.equal(p.wantsRussian('what is D7?'), false);
  assert.equal(p.answeredInEnglish('The D65 chord resolves to the tonic triad, the leading tone goes up.'), true);
  assert.equal(p.answeredInEnglish('Аккорд D65 разрешается в T53: вводный тон (leading tone) идёт вверх.'), false);
  assert.equal(p.answeredInEnglish('```js\nconst something = englishCodeThatIsLongEnoughToCount();\n```\nВот код.'), false);
});
