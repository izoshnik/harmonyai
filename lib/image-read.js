/* ============================================================================
   ЧТЕНИЕ ФОТО ПЕРЕД ОТВЕТОМ
   ----------------------------------------------------------------------------
   Раньше фото сразу уходило бесплатной модели со зрением, и она же решала
   задачу: путала значки («fis moll» → «Faidoll»), теряла стрелки и индексы
   аккордов, отвечала смесью языков. Теперь два шага:

     1) модель со зрением ТОЛЬКО переписывает фото — дословно, со всеми
        музыкальными обозначениями (печатный и рукописный текст, ноты на стане);
     2) сильная текстовая модель решает задачу по этой расшифровке, а
        музыкальное ядро заранее считает ноты (lib/music-tasks.js).

   Модели: Pro — сначала OCR_PRO_MODELS (по умолчанию claude-haiku у pro-ai.online,
   у Claude лучшее чтение документов), затем бесплатные; Free — только бесплатные
   модели OpenRouter со зрением (OCR_MODELS). Каждая следующая — запасная.
   ============================================================================ */
import { providerForModel } from './models.js';

function readEnv(name) { return String(process.env[name] || '').trim(); }

const FREE_OCR_DEFAULT = ['nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free'];
const PRO_OCR_DEFAULT = ['claude-haiku-4-5-20251001'];

export function ocrModels(pro) {
  const list = (name, def) => { const v = readEnv(name).split(',').map((x) => x.trim()).filter(Boolean); return v.length ? v : def; };
  const free = list('OCR_MODELS', FREE_OCR_DEFAULT);
  return pro ? Array.from(new Set(list('OCR_PRO_MODELS', PRO_OCR_DEFAULT).concat(free))) : free;
}

export const OCR_SYSTEM = [
  'Ты — точный распознаватель изображений для музыкального помощника. Твоя задача — ПЕРЕПИСАТЬ, а не решить.',
  'Перепиши дословно ВЕСЬ текст с изображения: печатный и рукописный, с нумерацией пунктов (1., 2., А), Б), В), Г)), как в оригинале.',
  'Музыкальные обозначения переписывай точно и в одну строку:',
  '— стрелки направления: ↑ (вверх) и ↓ (вниз);',
  '— цифровку аккордов пиши обычными цифрами сразу после буквы: I53, II2, V65, V7, K64, VI6, Б6, М64, Ув53, Ум53, D7, T53;',
  '— «ум VII» с маленькой «г» вверху — это гармонический вид: пиши «умVII7(г)»; знак «-5» вверху у аккорда — «(без5)»: I53(без5);',
  '— знак «=» между аккордами (VI6 = III6) сохраняй, рамки и скобки вокруг можно опустить;',
  '— тональности в немецких обозначениях пиши латиницей как в оригинале: a moll, A dur, fis moll, Es dur, h moll (не переводи и не искажай);',
  '— интервалы: ч1 ч4 ч5 ч8, м2 б2 м3 б3 м6 б6 м7 б7, ув2 ув4 ув5, ум4 ум5 ум7; ноты по-русски (до, ре, ми…) или латинскими буквами как в оригинале (a, fis, b).',
  'Подчёркнутые или выделенные слова выдели **жирным**. Неразборчивое место отметь [неразборчиво], ничего не придумывай.',
  'Если на изображении есть нотный стан: укажи ключ, ключевые знаки, размер и перепиши ноты по тактам в ABC-нотации (C — до первой октавы, c — до второй; ^ диез, _ бемоль, = бекар; длительности L:1/8 или L:1/4).',
  'Если это обычное фото без текста — коротко опиши, что на нём (предметы, люди, обстановка, надписи).',
  'Пиши по-русски. Без вступлений и комментариев. Формат ответа строго такой:',
  'ТИП: текст | ноты | текст+ноты | рукопись | фото | схема',
  'ТЕКСТ:',
  '<дословный текст>',
  'НОТЫ (ABC):',
  '<ABC или «нет»>',
  'ОПИСАНИЕ:',
  '<одно-два предложения: что изображено>'
].join('\n');

function imagePartsOf(message) {
  return Array.isArray(message?.content) ? message.content.filter((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url) : [];
}

export function lastUserImages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue;
    return { index: i, parts: imagePartsOf(list[i]) };
  }
  return { index: -1, parts: [] };
}

async function callVision(model, parts, userText, timeoutMs) {
  const provider = providerForModel(model);
  if (!provider.apiKey || !provider.baseUrl) return { text: '', reason: 'no_key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const content = [
      { type: 'text', text: 'Перепиши изображение' + (parts.length > 1 ? 'я (по порядку, «Фото 1», «Фото 2»…)' : '') + ' по правилам.' + (userText ? ` Вопрос пользователя к фото (НЕ отвечай на него, только учти, что важно переписать): «${String(userText).slice(0, 300)}»` : '') },
      ...parts.slice(0, 6).map((p) => ({ type: 'image_url', image_url: { url: p.image_url.url } }))
    ];
    const body = { model, messages: [{ role: 'system', content: OCR_SYSTEM }, { role: 'user', content }], temperature: 0, max_tokens: 3000 };
    if (provider.openrouter) body.reasoning = { effort: 'low', exclude: true };
    const r = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, ...(provider.headers || {}) },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); return { text: '', reason: 'http_' + r.status + ' ' + t.slice(0, 120) }; }
    const data = await r.json().catch(() => ({}));
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    return { text, reason: text ? '' : 'empty' };
  } catch (e) {
    return { text: '', reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

/* Расшифровка годится, если в ней есть разделы и хоть немного содержания. */
function usable(text) {
  const t = String(text || '');
  if (t.length < 20) return false;
  if (/не\s+(?:вижу|могу\s+увидеть|получил[а]?)\s+(?:изображени|фото|картинк)/i.test(t)) return false;
  return /ТЕКСТ:|ОПИСАНИЕ:|ТИП:/i.test(t) || t.length > 60;
}

export function parseReading(text) {
  const t = String(text || '');
  const type = (/ТИП:\s*([^\n]+)/i.exec(t) || [])[1] || '';
  const grab = (name, next) => {
    const re = new RegExp(name + ':\\s*([\\s\\S]*?)(?=\\n(?:' + next + '):|$)', 'i');
    return ((re.exec(t) || [])[1] || '').trim();
  };
  return {
    type: type.trim().toLowerCase(),
    text: grab('ТЕКСТ', 'НОТЫ \\(ABC\\)|ОПИСАНИЕ'),
    abc: grab('НОТЫ \\(ABC\\)', 'ОПИСАНИЕ').replace(/^нет\.?$/i, ''),
    description: grab('ОПИСАНИЕ', 'ТИП')
  };
}

/* Прочитать фото из последнего сообщения пользователя.
   → { raw, type, text, abc, description, model } или null. */
export async function readChatImages(messages, { pro = false, userText = '', totalMs = 45000, models = null } = {}) {
  const { parts } = lastUserImages(messages);
  if (!parts.length) return null;
  const started = Date.now();
  for (const model of (Array.isArray(models) && models.length ? models : ocrModels(pro))) {
    const left = totalMs - (Date.now() - started);
    if (left < 6000) break;
    const r = await callVision(model, parts, userText, Math.min(left, 30000));
    if (usable(r.text)) {
      const p = parseReading(r.text);
      return { raw: r.text, ...p, model };
    }
    console.warn(`[image-read] ${model} → ${r.reason || 'unusable'}`);
  }
  return null;
}

/* Документ/задание/ноты (а не просто фото) — отвечать лучше текстовой модели. */
export function isDocumentReading(reading) {
  if (!reading) return false;
  if (/текст|ноты|рукопис|схем/.test(reading.type || '')) return true;
  return String(reading.text || '').replace(/\s+/g, ' ').length > 120;
}

/* Вставить расшифровку в последнее сообщение пользователя; dropImages — убрать
   сами картинки (тогда ответ пишет текстовая модель). */
export function withReading(messages, reading, { dropImages = false } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const { index } = lastUserImages(list);
  if (index < 0 || !reading) return list;
  const m = list[index];
  const note = '[ДОСЛОВНАЯ РАСШИФРОВКА ФОТО — сделана системой распознавания; опирайся на неё, это и есть содержимое фото]\n' +
    (reading.type ? 'Тип: ' + reading.type + '\n' : '') +
    (reading.text ? 'Текст:\n' + reading.text + '\n' : '') +
    (reading.abc ? 'Ноты (ABC):\n' + reading.abc + '\n' : '') +
    (reading.description ? 'Что на фото: ' + reading.description : '');
  let content = Array.isArray(m.content) ? m.content.slice() : [{ type: 'text', text: String(m.content || '') }];
  if (dropImages) content = content.filter((p) => !(p && p.type === 'image_url'));
  content.push({ type: 'text', text: note });
  list[index] = { ...m, content };
  return list;
}
