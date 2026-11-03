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
