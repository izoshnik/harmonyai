/* ============================================================================
   САМООБУЧЕНИЕ ПО УЧЕБНИКАМ: ссылка/текст → главы → чанки → база знаний.

   Подключено в api/util.js (слоты функций Vercel исчерпаны):
     POST /api/util?op=ingest-url      { url, title? }      скачать и сохранить
     POST /api/util?op=ingest-text     { title, text, sourceUrl? }  текст от клиента
     GET  /api/util?op=ingest-proxy&url=…&part=N           байты PDF частями —
          PDF разбирает браузер (parsePdfFile уже есть в app.html), потом
          присылает текст через ingest-text
     POST /api/util?op=ingest-distill  { docId, from }      «Дистиллятор правил»
          по 3 главы за вызов; клиент повторяет, пока next != null

   Доступ: только developer / admin / moderator (роль из profiles на сервере)
   и аккаунт разработчика. Документы сохраняются как ГЛОБАЛЬНЫЕ — api/chat.js
   подтягивает их всем ученикам при вопросах по теории музыки.

   Форматы на сервере: FB2 (и .fb2.zip), TXT, MD, HTML, DOCX. PDF — в браузере.
   Ссылки Google Drive / Google Docs / Яндекс.Диск / GitHub превращаются в
   прямые ссылки скачивания. Внутренние адреса (localhost, 10.*, 192.168.* …)
   запрещены — сервер не должен ходить во внутреннюю сеть по чужой ссылке.
   ============================================================================ */
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { requireUser, supabaseRest, readAccessProfile } from './auth.js';
import { utilityEndpoint, utilityModel } from './models.js';
import { isDevAccountUser } from './dev-account.js';

const MAX_BYTES = 40 * 1024 * 1024;
const PROXY_PART = 3 * 1024 * 1024; // < 4,5 МБ — лимит ответа функции Vercel
const STAFF = ['developer', 'admin', 'moderator'];

function fail(res, status, message) { return res.status(status).json({ ok: false, error: { message } }); }

/* ---------------------------- доступ ---------------------------- */
async function requireStaff(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (isDevAccountUser(user)) return user;
  const profile = await readAccessProfile(user.id);
  if (!STAFF.includes(String(profile?.role || '').toLowerCase())) {
    fail(res, 403, 'Загружать учебники могут только developer, admin и moderator');
    return null;
  }
  return user;
}

/* ---------------------------- ссылки ---------------------------- */
export function normalizeSourceUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  // Google Drive: /file/d/ID/view, open?id=ID
  if (host === 'drive.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([^/]+)/) || [])[1] || u.searchParams.get('id');
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }
  // Google Docs → выгрузка в DOCX (сохраняет заголовки глав)
  if (host === 'docs.google.com') {
    const m = u.pathname.match(/\/document\/d\/([^/]+)/);
    if (m) return `https://docs.google.com/document/d/${m[1]}/export?format=docx`;
  }
  // GitHub: blob → raw
  if (host === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return u.toString();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80') || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.') || low.startsWith('::ffff:192.168.');
}

async function assertPublicHost(url) {
  const host = new URL(url).hostname;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Внутренние адреса запрещены');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Внутренние адреса запрещены');
}

/* Яндекс.Диск: публичная ссылка → одноразовая прямая ссылка через публичное API. */
async function resolveYandexDisk(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (!/^(disk\.yandex\.(ru|com|kz|by)|yadi\.sk)$/.test(host)) return url;
  const api = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(url)}`;
  const r = await fetch(api, { signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.href) throw new Error('Яндекс.Диск не отдал файл (проверьте, что ссылка публичная)');
  return data.href;
}

/* Скачивание с ручными редиректами (каждый адрес проверяется) и потолком размера. */
async function download(url, { range } = {}) {
  let current = await resolveYandexDisk(url);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicHost(current);
    const headers = { 'User-Agent': 'HarmonyAI-Textbook-Ingestor/1.0' };
    if (range) headers.Range = range;
    const r = await fetch(current, { redirect: 'manual', headers, signal: AbortSignal.timeout(25000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).toString();
      continue;
    }
    if (!r.ok && r.status !== 206) throw new Error(`Источник ответил ${r.status}`);
    const declared = Number(r.headers.get('content-length') || 0);
    if (!range && declared > MAX_BYTES) throw new Error('Файл больше 40 МБ');
    const reader = r.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { try { reader.cancel(); } catch (e) {} throw new Error('Файл больше 40 МБ'); }
      parts.push(value);
    }
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    // Google Drive для больших файлов отдаёт страницу «не удалось проверить на вирусы».
    const ctype = String(r.headers.get('content-type') || '');
    if (/drive\.google|drive\.usercontent/.test(current) && /text\/html/.test(ctype)) {
      const html = bytes.toString('utf8');
      const form = html.match(/<form[^>]+id="download-form"[^>]+action="([^"]+)"[\s\S]*?<\/form>/);
      if (form) {
        const params = new URLSearchParams();
        for (const m of form[0].matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)) params.set(m[1], m[2]);
        current = `${form[1].replace(/&amp;/g, '&')}?${params.toString()}`;
        continue;
      }
    }
    return { bytes, contentType: ctype, finalUrl: current, status: r.status, total: Number((r.headers.get('content-range') || '').split('/')[1] || 0) || declared || bytes.length };
  }
  throw new Error('Слишком много перенаправлений');
}

/* ---------------------------- декодирование ---------------------------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function decodeText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  const head = b.subarray(0, 600).toString('latin1');
  const declared = (head.match(/encoding=["']([\w-]+)["']/i) || head.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (declared && !/utf-?8/i.test(declared)) {
    try { return new TextDecoder(declared.toLowerCase()).decode(b); } catch (e) { /* неизвестная кодировка */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, ''); } catch (e) {
    return new TextDecoder('windows-1251').decode(b);
  }
}

/* ---------------------------- ZIP (fb2.zip, docx) ---------------------------- */
export function unzipEntries(buf, want) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Архив повреждён');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    out.push({ name, bytes: method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: 120 * 1024 * 1024 }) });
  }
  return out;
}

/* ---------------------------- форматы → текст с заголовками ----------------------------
   На выходе — текст, где заголовки глав отмечены строками «## …»: по ним режутся главы. */
export function fb2ToText(xml) {
  let s = String(xml).replace(/<binary[\s\S]*?<\/binary>/gi, '');
  const bodies = [...s.matchAll(/<body(?![^>]*name="notes")[^>]*>([\s\S]*?)<\/body>/gi)].map((m) => m[1]);
  s = bodies.length ? bodies.join('\n') : s;
  const bookTitle = decodeEntities(((xml.match(/<book-title>([\s\S]*?)<\/book-title>/i) || [])[1] || '').replace(/<[^>]+>/g, '')).trim();
  s = s
    .replace(/<title>([\s\S]*?)<\/title>/gi, (_, t) => '\n## ' + t.replace(/<\/p>\s*<p[^>]*>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n')
    .replace(/<subtitle>([\s\S]*?)<\/subtitle>/gi, (_, t) => '\n### ' + t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n')
    .replace(/<\/(p|v|subtitle|text-author)>/gi, '\n')
    .replace(/<empty-line\s*\/>/gi, '\n')
    .replace(/<\/?(section|stanza|poem|epigraph|cite)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return { title: bookTitle, text: decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
}

export function htmlToText(html) {
  const title = decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
  const s = String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, t) => '\n## ' + t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n')
    .replace(/<(br|\/p|\/li|\/div|\/tr|\/h[4-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return { title, text: decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
}

export function docxToText(buf) {
  const [doc] = unzipEntries(buf, (n) => n === 'word/document.xml');
  if (!doc) throw new Error('В DOCX нет word/document.xml');
  const xml = doc.bytes.toString('utf8');
  const lines = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const text = decodeEntities((p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim();
    if (!text) continue;
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    lines.push(/^(heading|заголовок|title)\s*[1-3]?$|^(Heading|Title)[1-3]?$/i.test(style) || /^[1-3]$/.test(style) ? '## ' + text : text);
  }
  return { title: '', text: lines.join('\n') };
}

/* Определение формата по сигнатуре, типу и имени. */
export function bytesToText(bytes, { contentType = '', name = '' } = {}) {
  const lowName = name.toLowerCase();
  const head = bytes.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return { kind: 'pdf' };
  if (head.startsWith('PK')) {
    const names = [];
    unzipEntries(bytes, (n) => { names.push(n); return false; });
    if (names.includes('word/document.xml')) return { kind: 'docx', ...docxToText(bytes) };
    const fb2 = names.find((n) => /\.fb2$/i.test(n));
    if (fb2) {
      const [entry] = unzipEntries(bytes, (n) => n === fb2);
      return { kind: 'fb2', ...fb2ToText(decodeText(entry.bytes)) };
    }
    throw new Error('В архиве нет FB2 или DOCX');
  }
  const text = decodeText(bytes);
  if (/<FictionBook/i.test(text.slice(0, 2000)) || lowName.endsWith('.fb2')) return { kind: 'fb2', ...fb2ToText(text) };
  if (/text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text) || /\.html?$/.test(lowName)) return { kind: 'html', ...htmlToText(text) };
  // MD: заголовки «# …» → «## …»
  return { kind: /\.md$|markdown/i.test(lowName + contentType) ? 'md' : 'txt', title: '', text: text.replace(/^#{1,3}\s+/gm, '## ') };
}

/* ---------------------------- умная нарезка ---------------------------- */
const TAG_RULES = [
  ['II7', /\bII\s?7|II\s?65|II\s?43|II\s?2\b|септаккорд\S*\s+(II|второй)/i],
  ['D7', /\b[DД]\s?(7|65|43|2)\b|доминантсептаккорд/i],
  ['VII7', /\bVII\s?7|VII\s?65|вводн\S*\s+септаккорд|ум\.?\s?VII/i],
  ['DD', /\b(DD|ДД)\s?\d|двойн\S*\s+доминант/i],
  ['K64', /\b[KК]\s?64|кадансов\S*\s+квартсекст/i],
  ['N6', /\bN\s?6|неаполитанск/i],
  ['T/S/D', /\b[TSDТСД]\s?(53|6|64)\b|главн\S*\s+трезвучи|тоник|субдоминант|доминант/i],
  ['разрешение', /разреш/i],
  ['обращения', /обращени|секстаккорд|квартсекстаккорд|квинтсекст|терцкварт|секундаккорд/i],
  ['голосоведение', /голосоведени|параллельн\S*\s+(квинт|октав)|удвоени/i],
  ['гармония', /гармони/i],
  ['сольфеджио', /сольфеджио|интонировани|диктант/i],
  ['интервалы', /интервал|тритон|терци|кварт|квинт|секст|септим|секунд/i],
  ['лады и тональности', /тональност|ключев\S*\s+знак|квинтов\S*\s+круг|гамм|мажор|минор|лад\b|лада\b|ладов/i],
  ['энгармонизм', /энгармони/i],
  ['ладовые тяготения', /тяготени|неустойчив|устойчив/i],
  ['альтерация', /альтераци|хроматизм|отклонени|модуляци/i],
  ['ритм и метр', /размер\b|метр\b|ритм|такт|длительност|синкоп/i]
];

export function tagText(text) {
  return TAG_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

const HEADING_RE = /^(##\s+.+|(глава|часть|раздел|урок|тема|параграф)\s+[\dIVXLC]+.*|§\s*\d+.*|\d{1,2}(\.\d{1,2}){0,2}\.?\s+[А-ЯЁA-Z][^.!?]{2,80})$/i;

export function splitSections(text) {
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line && line.length <= 120 && HEADING_RE.test(line)) {
      if (cur.lines.join('').trim() || cur.heading) sections.push(cur);
      cur = { heading: line.replace(/^##\s+/, '').trim(), lines: [] };
      continue;
    }
    cur.lines.push(raw);
  }
  if (cur.lines.join('').trim() || cur.heading) sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() })).filter((s) => s.body);
}

/* Главы → чанки ~2–6 тыс. символов: маленькие главы склеиваются, большие режутся
   по абзацам с перекрытием в один абзац. В начале каждого чанка — учебник,
   раздел и теги: по ним RAG находит нужный параграф. */
export function buildSmartChunks(sections, title, { target = 4500, max = 6500 } = {}) {
  const pieces = [];
  for (const s of sections) {
    if (s.body.length <= max) { pieces.push({ heading: s.heading, text: s.body }); continue; }
    const paras = s.body.split(/\n{2,}|\n(?=\s*[-•—]|\s*\d+[.)]\s)/).map((p) => p.trim()).filter(Boolean);
    let buf = [];
    let len = 0;
    for (const p of paras) {
      if (len + p.length > target && buf.length) {
        pieces.push({ heading: s.heading, text: buf.join('\n\n') });
        const last = buf[buf.length - 1];
        buf = last.length < 1200 ? [last] : [];
        len = buf.join('').length;
      }
      if (p.length > max) {
        for (let i = 0; i < p.length; i += target) pieces.push({ heading: s.heading, text: p.slice(Math.max(0, i - 300), i + target) });
        continue;
      }
      buf.push(p);
      len += p.length;
    }
    if (buf.length) pieces.push({ heading: s.heading, text: buf.join('\n\n') });
  }
  const merged = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length + p.text.length < 2000) {
      prev.text += `\n\n${p.heading ? p.heading + '\n' : ''}${p.text}`;
      continue;
    }
    merged.push({ ...p });
  }
  return merged.map((p) => {
    const tags = tagText(`${p.heading}\n${p.text}`);
    const header = `[Учебник: ${title}${p.heading ? ' | Раздел: ' + p.heading : ''}]${tags.length ? '\nТеги: ' + tags.join(', ') : ''}`;
    return { content: `${header}\n${p.text}`, heading: p.heading, tags };
  });
}

/* ---------------------------- сохранение ---------------------------- */
async function insertDocument(row) {
  const rows = await supabaseRest('/rest/v1/knowledge_documents', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ is_active: true, ...row }), timeoutMs: 15000
  });
  const id = Array.isArray(rows) ? rows[0]?.id : rows?.id;
  if (!id) throw new Error('Не удалось создать документ в базе знаний');
  return id;
}
async function insertChunks(docId, contents, startIndex = 0) {
  for (let i = 0; i < contents.length; i += 100) {
    const batch = contents.slice(i, i + 100).map((content, k) => ({ document_id: docId, chunk_index: startIndex + i + k, content }));
    await supabaseRest('/rest/v1/knowledge_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(batch), timeoutMs: 20000 });
  }
}

export async function ingestText({ title, text, sourceUrl = '', kind = 'txt', userId }) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
  if (clean.length < 200) throw new Error('В источнике почти нет текста (меньше 200 символов)');
  const name = String(title || '').trim().slice(0, 200) || 'Учебник';
  if (sourceUrl) {
    const dup = await supabaseRest(`/rest/v1/knowledge_documents?select=id,title,chunk_count&is_active=eq.true&meta->>source_url=eq.${encodeURIComponent(sourceUrl)}&limit=1`).catch(() => []);
    if (Array.isArray(dup) && dup[0]) return { duplicate: true, docId: dup[0].id, title: dup[0].title, chunks: dup[0].chunk_count };
  }
  const sections = splitSections(clean);
  const chunks = buildSmartChunks(sections.length ? sections : [{ heading: '', body: clean }], name);
  const tagCount = {};
  chunks.forEach((c) => c.tags.forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const docId = await insertDocument({
    title: name,
    scope: 'global',
    source_type: 'textbook',
    owner_user_id: userId,
    created_by: userId,
    content_preview: clean.slice(0, 220),
    chunk_count: chunks.length,
    meta: { source_url: sourceUrl || null, format: kind, chars: clean.length, sections: sections.length, tags: tagCount, ingested_by: 'textbook-ingestor' }
  });
  await insertChunks(docId, chunks.map((c) => c.content));
  const theory = chunks.filter((c) => c.tags.some((t) => !['ритм и метр'].includes(t))).length;
  return { docId, title: name, chunks: chunks.length, sections: sections.length, theoryChunks: theory, tags: tagCount };
}

/* ---------------------------- дистиллятор правил ---------------------------- */
const DISTILL_PROMPT = [
  'Ты — «Дистиллятор правил теории музыки» для базы знаний музыкального ИИ-помощника.',
  'Из фрагмента учебника выпиши ТОЛЬКО то, что в нём сказано явно: определения, правила построения,',
  'правила голосоведения и разрешения, исключения, канонические формулы (например «II7 → D43 → T53»).',
  'Каждое правило — отдельной строкой, начиная с «• ». Кратко, с обозначениями как в учебнике (T, S, D, II7, D65, K64 …).',
  'Ничего не добавляй от себя и не используй знания вне фрагмента. Если правил по теории музыки нет — ответь одним словом: НЕТ.'
].join('\n');

async function distillChunk(content) {
  const ep = utilityEndpoint();
  if (!ep.apiKey) throw new Error('Служебная модель не настроена');
  const model = utilityModel(['TEXTBOOK_DISTILL_MODEL', 'INTENT_MODEL']);
  const r = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: DISTILL_PROMPT }, { role: 'user', content: content.slice(0, 9000) }], max_tokens: 1200, temperature: 0 }),
    signal: AbortSignal.timeout(40000)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Модель ответила ${r.status}`);
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text || /^НЕТ\.?$/i.test(text)) return '';
  return text.split('\n').filter((l) => /^\s*[•\-*]\s+/.test(l)).map((l) => '• ' + l.replace(/^\s*[•\-*]\s+/, '').trim()).join('\n');
}

export async function distillStep({ docId, from = 0, batch = 3, userId }) {
  const [doc] = await supabaseRest(`/rest/v1/knowledge_documents?select=id,title,chunk_count,meta&id=eq.${encodeURIComponent(docId)}&limit=1`) || [];
  if (!doc) throw new Error('Документ не найден');
  const total = Number(doc.chunk_count) || 0;
  // Смотрим вперёд до 60 фрагментов и берём первые batch с музыкальными тегами:
  // предисловие, оглавление и страницы без теории не тратят ни запросов к модели, ни шагов.
  const scan = await supabaseRest(`/rest/v1/knowledge_chunks?select=chunk_index,content&document_id=eq.${encodeURIComponent(docId)}&chunk_index=gte.${Number(from)}&order=chunk_index.asc&limit=60`) || [];
  const isTheory = (r) => /\nТеги: /.test(r.content) && !/\nТеги: ритм и метр\n/.test(r.content);
  const theory = [];
  let rows = scan;
  for (let i = 0; i < scan.length; i++) {
    if (isTheory(scan[i])) theory.push(scan[i]);
    if (theory.length >= batch) { rows = scan.slice(0, i + 1); break; }
  }
  const results = await Promise.allSettled(theory.map((r) => distillChunk(r.content)));
  const rules = [];
  results.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value) {
      const head = (theory[i].content.match(/^\[Учебник: [^\]]*\]/) || [''])[0].replace('[Учебник:', '[Правила учебника:');
      rules.push(`${head}\nТеги: ${tagText(theory[i].content).join(', ')}\n${res.value}`);
    }
  });
  const errors = results.filter((r) => r.status === 'rejected').length;
  if (rules.length) {
    // Правила — отдельный глобальный документ source_type=textbook_rules (высокий приоритет в RAG).
    const existing = await supabaseRest(`/rest/v1/knowledge_documents?select=id,chunk_count&source_type=eq.textbook_rules&meta->>rules_for=eq.${encodeURIComponent(docId)}&limit=1`) || [];
    let rulesId = existing[0]?.id;
    let start = Number(existing[0]?.chunk_count) || 0;
    if (!rulesId) {
      rulesId = await insertDocument({
        title: `Правила учебника: ${doc.title}`, scope: 'global', source_type: 'textbook_rules', owner_user_id: userId, created_by: userId,
        content_preview: rules[0].slice(0, 220), chunk_count: 0, meta: { rules_for: docId, ingested_by: 'textbook-ingestor' }
      });
      start = 0;
    }
    await insertChunks(rulesId, rules, start);
    await supabaseRest(`/rest/v1/knowledge_documents?id=eq.${encodeURIComponent(rulesId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ chunk_count: start + rules.length }) });
  }
  const last = rows.length ? rows[rows.length - 1].chunk_index : from;
  const next = (rows === scan && scan.length < 60) || last + 1 >= total ? null : last + 1;
  return { processed: rows.length, distilled: theory.length, rulesAdded: rules.length, errors, next, total };
}

/* ---------------------------- HTTP-обработчики (через api/util.js) ---------------------------- */
function body(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }

export async function handleIngestUrl(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Нужен POST');
  const user = await requireStaff(req, res);
  if (!user) return;
  const src = normalizeSourceUrl(body(req).url);
  if (!src) return fail(res, 400, 'Нужна ссылка http(s)');
  try {
    const dl = await download(src);
    const name = decodeURIComponent((new URL(dl.finalUrl).pathname.split('/').pop() || '')).slice(0, 160);
    const parsed = bytesToText(dl.bytes, { contentType: dl.contentType, name });
    if (parsed.kind === 'pdf') {
      // PDF разбирает браузер администратора: отдаём размер и адрес для ingest-proxy.
      return res.status(200).json({ ok: true, needsClientParse: true, kind: 'pdf', url: src, size: dl.bytes.length, name });
    }
    const title = String(body(req).title || parsed.title || name.replace(/\.[a-z0-9]+$/i, '') || 'Учебник').slice(0, 200);
    const result = await ingestText({ title, text: parsed.text, sourceUrl: src, kind: parsed.kind, userId: user.id });
    return res.status(200).json({ ok: true, kind: parsed.kind, ...result });
  } catch (e) {
    return fail(res, 400, String(e?.message || e).slice(0, 300));
  }
}

export async function handleIngestText(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Нужен POST');
  const user = await requireStaff(req, res);
  if (!user) return;
  const b = body(req);
  try {
    const result = await ingestText({ title: b.title, text: b.text, sourceUrl: b.sourceUrl ? normalizeSourceUrl(b.sourceUrl) : '', kind: String(b.kind || 'txt').slice(0, 10), userId: user.id });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return fail(res, 400, String(e?.message || e).slice(0, 300));
  }
}

export async function handleIngestProxy(req, res) {
  const user = await requireStaff(req, res);
  if (!user) return;
  const src = normalizeSourceUrl(req.query?.url);
  const part = Math.max(0, Number(req.query?.part) || 0);
  if (!src) return fail(res, 400, 'Нужна ссылка http(s)');
  try {
    const start = part * PROXY_PART;
    const dl = await download(src, { range: `bytes=${start}-${start + PROXY_PART - 1}` });
    // Источник мог проигнорировать Range и отдать файл целиком — тогда режем сами.
    const slice = dl.status === 206 ? dl.bytes : dl.bytes.subarray(start, start + PROXY_PART);
    const total = dl.status === 206 ? dl.total : dl.bytes.length;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Total-Size', String(total));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(slice));
  } catch (e) {
    return fail(res, 400, String(e?.message || e).slice(0, 300));
  }
}

export async function handleIngestDistill(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Нужен POST');
  const user = await requireStaff(req, res);
  if (!user) return;
  const b = body(req);
  if (!/^[0-9a-f-]{36}$/i.test(String(b.docId || ''))) return fail(res, 400, 'Некорректный docId');
  try {
    return res.status(200).json({ ok: true, ...(await distillStep({ docId: b.docId, from: Number(b.from) || 0, userId: user.id })) });
  } catch (e) {
    return fail(res, 400, String(e?.message || e).slice(0, 300));
  }
}
