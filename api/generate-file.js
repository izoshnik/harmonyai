/* ============================================================================
   POST /api/generate-file
   Тело: { format, filename, content, userId? }
     format   — "md" | "txt" | "pdf" | "docx"
     filename — базовое имя без расширения (санитизируется)
     content  — текст/markdown, уже сгенерированный ИИ на клиенте
     userId   — опционально, для логов
   Ответ: бинарный файл (attachment) с корректными заголовками.

   ВАЖНО: НОЛЬ внешних зависимостей. docx и pdf генерируются вручную
   (STORED-ZIP для .docx, самодельный PDF с base-14 Helvetica).
   ============================================================================ */

export const config = { maxDuration: 30 };

/* -------- Лёгкая защита: разрешённые источники (как в recognize.js/title.js) -------- */
const ALLOWED_HOSTS = ['harmonyai-zeta.vercel.app', 'localhost', '127.0.0.1'];
function originAllowed(req) {
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true; // некоторые webview не шлют заголовок — не блокируем жёстко
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}

/* -------- Лёгкий in-memory rate-limit по IP (~20/мин) -------- */
const RL_WINDOW_MS = 60 * 1000, RL_MAX = 20;
const _rlStore = new Map();
function rateLimited(req) {
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const rec = _rlStore.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    _rlStore.set(ip, { start: now, count: 1 });
    if (_rlStore.size > 5000) { for (const [k, v] of _rlStore) { if (now - v.start > RL_WINDOW_MS) _rlStore.delete(k); } }
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

const MAX_CONTENT = 20000; // символов — примерный бесплатный бюджет

/* -------- Санитизация имени файла -------- */
function sanitizeFilename(raw) {
  let name = String(raw == null ? '' : raw)
    .replace(/[\/\\]/g, ' ')        // разделители путей
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '') // управляющие символы
    .replace(/[<>:"|?*]/g, '')       // недопустимые в Windows
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length > 60) name = name.slice(0, 60).trim();
  if (!name) name = 'document';
  return name;
}

/* -------- XML-эскейп для docx -------- */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ===========================================================================
   CRC32 (стандартный полином 0xEDB88320) — таблица считается один раз.
   =========================================================================== */
const _crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ===========================================================================
   Минимальный STORED (method 0, без сжатия) ZIP-писатель.
   entries: [{ name, data(Buffer) }]. Возвращает Buffer готового zip.
   Байтовые смещения local-header'ов пишутся в central directory как есть.
   =========================================================================== */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 байт + имя)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (условная)
    local.writeUInt32LE(crc, 14);         // crc32
    local.writeUInt32LE(size, 18);        // compressed size
    local.writeUInt32LE(size, 22);        // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra len

    chunks.push(local, nameBuf, data);

    // Central directory record (46 байт + имя)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);               // flags
    cd.writeUInt16LE(0, 10);              // method
    cd.writeUInt16LE(0, 12);              // mod time
    cd.writeUInt16LE(0x21, 14);           // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra len
    cd.writeUInt16LE(0, 32);              // comment len
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // offset of local header
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // End of central directory (22 байта)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                    // disk
  eocd.writeUInt16LE(0, 6);                    // disk with CD
  eocd.writeUInt16LE(entries.length, 8);       // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);      // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);   // size of central dir
  eocd.writeUInt32LE(centralOffset, 16);       // offset of central dir
  eocd.writeUInt16LE(0, 20);                   // comment len

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* -------- Сборка .docx из текстового content -------- */
function buildDocx(content) {
  const paragraphs = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const body = paragraphs.map(line => {
    const text = xmlEscape(line);
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }).join('');

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') }
  ]);
}

/* ===========================================================================
   Минимальный PDF (base-14 Helvetica, WinAnsi).
   ОГРАНИЧЕНИЕ: base-14 Helvetica с WinAnsiEncoding не содержит кириллицы.
   Кириллица и прочие не-WinAnsi символы заменяются на '?' (best-effort),
   чтобы файл оставался валидным и никогда не падал. ASCII/латиница/базовая
   пунктуация отображаются корректно. Для полноценной кириллицы нужен
   встроенный TTF-шрифт с CID — это выходит за рамки zero-dependency.
   =========================================================================== */

// Оставляем печатаемый WinAnsi-диапазон, всё прочее (в т.ч. кириллицу) → '?'.
function toWinAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code === 9) { out += '    '; continue; }        // таб → пробелы
    if (code >= 32 && code <= 126) { out += ch; continue; } // ASCII
    if (code >= 160 && code <= 255) { out += ch; continue; } // Latin-1 supplement
    out += '?';
  }
  return out;
}

// Экранирование для литеральной строки PDF.
function pdfEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const words = line.split(' ');
  const rows = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= maxChars) {
      cur += ' ' + w;
    } else {
      rows.push(cur);
      cur = w;
    }
    // очень длинное слово — режем жёстко
    while (cur.length > maxChars) {
      rows.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : [''];
}

function buildPdf(content) {
  const MAX_CHARS = 90;   // символов в строке (Helvetica 11pt, ширина ~500pt)
  const LINES_PER_PAGE = 50;
  const FONT_SIZE = 11;
  const LEADING = 14.5;
  const MARGIN_LEFT = 56;
  const MARGIN_TOP = 786;  // от низа страницы (A4 высота 842)

  // Готовим строки: WinAnsi + перенос.
  const rawLines = toWinAnsi(String(content)).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const allLines = [];
  for (const l of rawLines) {
    for (const w of wrapLine(l, MAX_CHARS)) allLines.push(w);
  }
  if (allLines.length === 0) allLines.push('');

  // Разбиваем на страницы.
  const pages = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push(['']);

  // --- Раскладка объектов ---
  // 1: Catalog, 2: Pages, 3: Font.
  // Затем для каждой страницы: Page-объект и Contents-объект.
  const numPages = pages.length;
  const pageObjIds = [];
  const contentObjIds = [];
  let nextId = 4;
  for (let p = 0; p < numPages; p++) {
    pageObjIds.push(nextId++);
    contentObjIds.push(nextId++);
  }
  const totalObjs = nextId - 1;

  const objects = []; // objects[id] = string body (без "N 0 obj" обёртки)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [' +
    pageObjIds.map(id => `${id} 0 R`).join(' ') +
    `] /Count ${numPages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  for (let p = 0; p < numPages; p++) {
    const pageId = pageObjIds[p];
    const contentId = contentObjIds[p];

    // Поток контента страницы.
    let stream = 'BT\n/F1 ' + FONT_SIZE + ' Tf\n' + LEADING + ' TL\n' +
      MARGIN_LEFT + ' ' + MARGIN_TOP + ' Td\n';
    const lines = pages[p];
    for (let i = 0; i < lines.length; i++) {
      stream += '(' + pdfEscape(lines[i]) + ') Tj\n';
      if (i < lines.length - 1) stream += 'T*\n';
    }
    stream += 'ET';

    const streamBuf = Buffer.from(stream, 'latin1');
    objects[contentId] = `<< /Length ${streamBuf.length} >>\nstream\n${stream}\nendstream`;

    objects[pageId] = '<< /Type /Page /Parent 2 0 R ' +
      '/MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 3 0 R >> >> ' +
      `/Contents ${contentId} 0 R >>`;
  }

  // --- Сериализация с подсчётом байтовых смещений ---
  const parts = [];
  let pos = 0;
  const push = (str) => { const b = Buffer.from(str, 'latin1'); parts.push(b); pos += b.length; };

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = new Array(totalObjs + 1).fill(0);

  push(header);
  for (let id = 1; id <= totalObjs; id++) {
    offsets[id] = pos;
    push(`${id} 0 obj\n${objects[id]}\nendobj\n`);
  }

  const xrefStart = pos;
  let xref = 'xref\n0 ' + (totalObjs + 1) + '\n';
  xref += '0000000000 65535 f \n';
  for (let id = 1; id <= totalObjs; id++) {
    xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);

  push('trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\n' +
    'startxref\n' + xrefStart + '\n%%EOF');

  return Buffer.concat(parts);
}

/* -------- Метаданные форматов -------- */
const FORMATS = {
  txt:  { ext: 'txt',  mime: 'text/plain; charset=utf-8' },
  md:   { ext: 'md',   mime: 'text/markdown; charset=utf-8' },
  pdf:  { ext: 'pdf',  mime: 'application/pdf' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
};

/* -------- Content-Disposition с RFC 5987 для не-ASCII имён -------- */
function contentDisposition(name, ext) {
  const full = `${name}.${ext}`;
  // ASCII-fallback: заменяем всё не-ASCII на '_'.
  // eslint-disable-next-line no-control-regex
  const ascii = full.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' });

  if (!originAllowed(req)) return res.status(403).json({ error: 'forbidden', message: 'Недопустимый источник запроса.' });
  if (rateLimited(req)) return res.status(429).json({ error: 'rate_limited', message: 'Слишком много запросов. Попробуйте через минуту.' });

  try {
    const body = req.body || {};
    const format = String(body.format || '').toLowerCase().trim();
    const content = typeof body.content === 'string' ? body.content : (body.content == null ? '' : String(body.content));
    const userId = body.userId || null;

    if (!FORMATS[format]) {
      return res.status(400).json({ error: 'bad_format', message: 'Неизвестный формат файла.' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'empty_content', message: 'Содержимое файла пустое.' });
    }
    if (content.length > MAX_CONTENT) {
      return res.status(413).json({ error: 'too_large', message: 'Файл слишком большой для вашего тарифа.' });
    }

    const name = sanitizeFilename(body.filename);
    const fmt = FORMATS[format];

    let buffer;
    if (format === 'txt' || format === 'md') {
      buffer = Buffer.from(content, 'utf8');
    } else if (format === 'docx') {
      buffer = buildDocx(content);
    } else { // pdf
      buffer = buildPdf(content);
    }

    if (userId) {
      try { console.log(`[generate-file] user=${userId} format=${format} bytes=${buffer.length}`); } catch (e) { /* noop */ }
    }

    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Content-Disposition', contentDisposition(name, fmt.ext));
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[generate-file]', e);
    return res.status(500).json({ error: 'internal', message: e?.message || 'Внутренняя ошибка сервера' });
  }
}


