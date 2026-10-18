/* Тесты конвейера учебников (без сети и базы): форматы, главы, теги, ссылки. */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { fb2ToText, htmlToText, docxToText, bytesToText, decodeText, splitSections, buildSmartChunks, tagText, normalizeSourceUrl } from '../lib/textbook-ingestor.js';

const FB2 = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Гармония</book-title></title-info></description>
<body><section><title><p>Глава 5</p><p>Септаккорд II ступени</p></title>
<p>II7 разрешается через D43 в T53.</p><p>Вторая&nbsp;строка &laquo;правило&raquo;.</p>
<section><title><p>§ 2. Обращения</p></title><p>II65 переходит в D2.</p></section></section></body>
<body name="notes"><section><p>Сноска</p></section></body><binary id="x">AAAA</binary></FictionBook>`;

function zipOne(name, data) {
  const raw = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuf, raw]);
  const cdir = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdir.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, cdir, eocd]);
}
const cp1251 = (s) => Buffer.from(new TextEncoder().encode(s)).length && Buffer.from([...s].map((ch) => { const c = ch.charCodeAt(0); if (c < 128) return c; if (c >= 0x410 && c <= 0x44f) return c - 0x350; if (c === 0x401) return 0xa8; if (c === 0x451) return 0xb8; if (c === 0xa7) return 0xa7; return 0x3f; }));

test('FB2 в windows-1251: кодировка, главы, сноски и binary отброшены', () => {
  const text = decodeText(cp1251(FB2));
  const r = fb2ToText(text);
  assert.equal(r.title, 'Гармония');
  assert.match(r.text, /## Глава 5\. Септаккорд II ступени/);
  assert.match(r.text, /## § 2\. Обращения/);
  assert.match(r.text, /«правило»/);
  assert.doesNotMatch(r.text, /Сноска|AAAA/);
});

test('fb2.zip и docx распознаются по сигнатуре', () => {
  const z = zipOne('book.fb2', Buffer.from(FB2.replace('windows-1251', 'utf-8')));
  const r = bytesToText(z, { name: 'book.fb2.zip' });
  assert.equal(r.kind, 'fb2');
  assert.match(r.text, /II65 переходит в D2/);
  const docXml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Глава 1. Интервалы</w:t></w:r></w:p><w:p><w:r><w:t>Тритон &amp; разрешение</w:t></w:r></w:p></w:body></w:document>';
  const d = bytesToText(zipOne('word/document.xml', Buffer.from(docXml)), { name: 'a.docx' });
  assert.equal(d.kind, 'docx');
  assert.equal(d.text, '## Глава 1. Интервалы\nТритон & разрешение');
  assert.equal(bytesToText(Buffer.from('%PDF-1.4 ...')).kind, 'pdf');
});

test('HTML: заголовки и абзацы, без скриптов', () => {
  const r = htmlToText('<html><head><title>ЭТМ</title><script>x()</script></head><body><h2>Глава 3. Аккорды</h2><p>D7 &mdash; доминантсептаккорд.</p></body></html>');
  assert.equal(r.title, 'ЭТМ');
  assert.match(r.text, /## Глава 3\. Аккорды\n+D7 — доминантсептаккорд\./);
  assert.doesNotMatch(r.text, /x\(\)/);
});

test('главы и умные чанки с тегами', () => {
  const body = Array.from({ length: 30 }, (_, i) => `Абзац ${i}: II7 разрешается в D43, затем в T53 с удвоенным основным тоном. `.repeat(4)).join('\n\n');
  const text = `Предисловие автора.\n## Глава 1. Интервалы\nТритон ув4 разрешается в сексту.\n§ 2. Септаккорд II ступени\n${body}`;
  const sections = splitSections(text);
  assert.deepEqual(sections.map((s) => s.heading), ['', 'Глава 1. Интервалы', '§ 2. Септаккорд II ступени']);
  const chunks = buildSmartChunks(sections, 'Способин');
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.content.startsWith('[Учебник: Способин')));
  const ii = chunks.filter((c) => c.heading === '§ 2. Септаккорд II ступени');
  assert.ok(ii.length >= 2, 'длинная глава режется на несколько чанков');
  assert.ok(ii.every((c) => c.tags.includes('II7') && c.tags.includes('разрешение')));
  assert.ok(chunks.every((c) => c.content.length <= 7000));
});

test('теги музыкальных терминов', () => {
  assert.deepEqual(tagText('Кадансовый квартсекстаккорд K64 и неаполитанский N6').filter((t) => ['K64', 'N6', 'обращения'].includes(t)).sort(), ['K64', 'N6', 'обращения']);
  assert.ok(tagText('Энгармонизм и тяготение неустойчивых ступеней').includes('энгармонизм'));
});

test('ссылки: Google Drive, Docs, GitHub; только http(s)', () => {
  assert.equal(normalizeSourceUrl('https://drive.google.com/file/d/AbC123/view?usp=sharing'), 'https://drive.google.com/uc?export=download&id=AbC123');
  assert.equal(normalizeSourceUrl('https://docs.google.com/document/d/XyZ/edit'), 'https://docs.google.com/document/d/XyZ/export?format=docx');
  assert.equal(normalizeSourceUrl('https://github.com/u/r/blob/main/books/a.md'), 'https://raw.githubusercontent.com/u/r/main/books/a.md');
  assert.equal(normalizeSourceUrl('file:///etc/passwd'), null);
  assert.equal(normalizeSourceUrl('javascript:alert(1)'), null);
});
