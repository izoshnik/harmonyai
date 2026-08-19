export const config = {
  maxDuration: 30
};

import { UTILITY_MODEL, envModel } from '../lib/models.js';

/* ============================================================================
   МУЗЫКАЛЬНЫЙ INTENT-КЛАССИФИКАТОР (LLM).

   Зачем нужен: раньше музыку ловил только регэксп-детектор в
   js/music-intents.js. Он понимал «включи X», но ломался на всём живом:
     «найди Believer и расскажи кто его написал» — блокировалось словом
     «расскажи» и уходило в обычный чат без трека;
     «хочется чего-нибудь под Imagine Dragons» — вообще не распознавалось.

   Теперь решение принимает модель. Регэкспы остались только как мгновенный
   путь для однозначных команд плеера («пауза», «следующий») — там LLM не
   нужна, и платить за неё задержкой нельзя.

   Контракт ответа (всегда 200, даже при ошибке — fail-open):
   {
     is_music: boolean,        // нужно ли вообще трогать музыкальный модуль
     intent: 'play'|'find'|'control'|'none',
     kind: 'track'|'album'|'artist'|'playlist',
     query: string,            // ЧИСТЫЙ поисковый запрос: «Believer Imagine Dragons»
     control: string,          // для intent='control': pause|resume|next|...
     want_answer: boolean,     // помимо трека пользователь просит текстовый ответ
     answer_request: string,   // о чём именно спрашивает (для промпта ответа)
     confidence: 'high'|'low'
   }

   Ключевой принцип: is_music=false при любых сомнениях. Ложное срабатывание
   (вместо ответа по теории музыки прилетел трек) хуже пропуска — пропуск
   просто уйдёт в обычный чат, как было всегда.
   ========================================================================== */

const KINDS = new Set(['track', 'album', 'artist', 'playlist']);
const CONTROLS = new Set([
  'pause', 'resume', 'next', 'previous', 'shuffle', 'repeat',
  'louder', 'quieter', 'mute', 'like', 'close'
]);

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderValue(value = '') {
  const low = String(value || '').trim().toLowerCase();
  return !low || low === 'undefined' || low === 'null' || low === 'your_key_here' || low === 'openai_base_url';
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compactErrorValue(value, limit = 300) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return normalizeText(text).slice(0, limit);
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || 'Request timed out')), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* Пустой (не музыкальный) ответ — им же отвечаем на любую ошибку.

   decided — БЫЛО ЛИ РЕШЕНИЕ ПРИНЯТО. Раньше «модель прочитала фразу и решила,
   что это не музыка» и «классификатор недоступен» (нет ключа, 5xx, таймаут)
   отдавались одним и тем же телом, и клиент не мог их различить. Теперь
   вердикт модели — decided:true (клиент ему подчиняется и уводит фразу в
   обычный чат), а отказ инфраструктуры — decided:false (клиент откатывается
   на локальные правила, и «включи Кино — Группа крови» продолжает работать
   даже без OPENAI_API_KEY). */
function noMusic(decided = false) {
  return {
    is_music: false,
    decided: Boolean(decided),
    intent: 'none',
    kind: 'track',
    query: '',
    control: '',
    want_answer: false,
    answer_request: '',
    confidence: 'low'
  };
}

/* Надёжный разбор JSON: модель любит обернуть ответ в ```json ... ``` */
function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* дальше */ }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* дальше */ }
  }

  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* Короткий контекст чата: «а кто её написал?» после трека — тоже музыкальный ход. */
function recentTextTurns(history = [], limit = 4) {
  const turns = [];
  for (let i = history.length - 1; i >= 0 && turns.length < limit; i -= 1) {
    const m = history[i];
    if (!m || m.role === 'system') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ');
    }
    text = normalizeText(text).slice(0, 300);
    if (text) turns.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', text });
  }
  return turns;
}

function buildMessages(userText, turns, nowPlaying) {
  const historyBlock = turns.length
    ? '\n\nПоследние сообщения чата (последнее — самое свежее):\n' +
      turns.map((t) => `${t.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${t.text}`).join('\n')
    : '';

  const playingBlock = nowPlaying
    ? `\n\nСейчас в плеере играет: ${nowPlaying}`
    : '\n\nСейчас в плеере ничего не играет.';

  const systemPrompt = [
    'Ты — маршрутизатор запросов музыкального ассистента HarmonyAI.',
    'HarmonyAI умеет: (а) отвечать текстом про музыку, теорию, ноты; (б) находить и включать',
    'реальные записи из Яндекс.Музыки; (в) управлять своим плеером.',
    'Твоя задача — по сообщению пользователя понять, надо ли трогать музыкальный модуль.',
    '',
    'Верни JSON со строго такими полями:',
    '- is_music (boolean): true, если пользователь хочет ПОСЛУШАТЬ/НАЙТИ конкретную запись',
    '  или управляет плеером. false — если это разговор, теория, история, разбор, ноты,',
    '  просьба написать текст/картинку, или просто болтовня.',
    '- intent: "play" (включить сразу), "find" (найти и показать, без немедленного запуска),',
    '  "control" (команда плееру), "none".',
    '- kind: "track" | "album" | "artist" | "playlist" — что именно искать. По умолчанию "track".',
    '- query (string): ЧИСТЫЙ поисковый запрос для Яндекс.Музыки — только название и/или',
    '  исполнитель, БЕЗ глаголов, вежливых слов и без второй части просьбы.',
    '  Исправь очевидные опечатки в названии («Beliver» → «Believer»).',
    '  Если знаешь исполнителя по названию — добавь его: «Believer» → «Believer Imagine Dragons».',
    '  Если пользователь просит «что-нибудь похожее/под настроение» — подставь конкретный',
    '  запрос, который лучше всего отражает просьбу.',
    '- control: одно из pause|resume|next|previous|shuffle|repeat|louder|quieter|mute|like|close',
    '  (только при intent="control", иначе пустая строка).',
    '- want_answer (boolean): true, если КРОМЕ трека пользователь просит что-то рассказать,',
    '  объяснить, перевести, разобрать. «Найди Believer и расскажи кто его написал» → true.',
    '  «Включи Believer» → false.',
    '- answer_request (string): если want_answer=true — коротко, что именно надо рассказать',
    '  (например: «кто написал песню и когда вышла»). Иначе пустая строка.',
    '- confidence: "high" — уверен; "low" — похоже на музыку, но возможна ошибка.',
    '',
    'ВАЖНЫЕ ГРАНИЦЫ (ошибка здесь дороже пропуска):',
    '- ГЛАВНОЕ ПРАВИЛО: глагол поиска («найди», «поищи», «загугли», «посмотри») сам по себе',
    '  НЕ делает запрос музыкальным. Музыкальным его делает ОБЪЕКТ: название записи,',
    '  исполнитель, альбом, плейлист. Если после глагола идёт что угодно другое —',
    '  инструкция, справка, товар, документ, погода, новости, рецепт, курс, поиск в',
    '  интернете — это обычный запрос: is_music=false, intent="none", query="".',
    '- «Расскажи про Believer», «кто написал Believer», «разбери гармонию Believer»',
    '  БЕЗ просьбы найти/включить — это разговор: is_music=false.',
    '- Вопросы по теории, сольфеджио, нотации, истории музыки — всегда is_music=false.',
    '- Просьбы написать ноты, сгенерировать картинку, перевести текст — is_music=false.',
    '- Если пользователь написал одно голое название («Believer», «Imagine Dragons»),',
    '  это скорее всего просьба включить: is_music=true, intent="play", confidence="low".',
    '- Если сомневаешься между разговором и музыкой — выбирай is_music=false.',
    '',
    'ПРИМЕРЫ НЕМУЗЫКАЛЬНЫХ ЗАПРОСОВ С ГЛАГОЛОМ ПОИСКА (частая ошибка):',
    '- «Найди в интернете как получить иностранную карту в РФ» →',
    '  {"is_music":false,"intent":"none","kind":"track","query":"",',
    '   "control":"","want_answer":false,"answer_request":"","confidence":"high"}',
    '- «Загугли погоду в Москве на выходные» →',
    '  {"is_music":false,"intent":"none","kind":"track","query":"",',
    '   "control":"","want_answer":false,"answer_request":"","confidence":"high"}',
    '- «Найди информацию про Шостаковича» → это справка, а не запись:',
    '  {"is_music":false,"intent":"none","kind":"track","query":"",',
    '   "control":"","want_answer":false,"answer_request":"","confidence":"high"}',
    '',
    'ПРИМЕРЫ СОСТАВНЫХ ПРОСЬБ (главный источник ошибок):',
    '- «Найди и опиши как был написан трек Beliver» →',
    '  {"is_music":true,"intent":"find","kind":"track","query":"Believer Imagine Dragons",',
    '   "control":"","want_answer":true,"answer_request":"как создавалась песня","confidence":"high"}',
    '- «Включи Believer и расскажи, кто его написал» →',
    '  {"is_music":true,"intent":"play","kind":"track","query":"Believer Imagine Dragons",',
    '   "control":"","want_answer":true,"answer_request":"кто автор песни","confidence":"high"}',
    '- «Найди песню Группа крови и переведи текст» →',
    '  {"is_music":true,"intent":"find","kind":"track","query":"Группа крови Кино",',
    '   "control":"","want_answer":true,"answer_request":"перевод и смысл текста","confidence":"high"}',
    'Ключевое правило: вторая просьба НЕ отменяет поиск. Глагол «найди»/«включи»',
    'важнее, чем «расскажи»/«опиши» рядом с ним. Название всё равно вынеси в query.',
    '',
    'Отвечай ТОЛЬКО валидным JSON, без markdown-обёртки и пояснений.'
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Сообщение пользователя: ${userText}${playingBlock}${historyBlock}` }
  ];
}

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return noMusic(false);

  let intent = String(parsed.intent || '').trim().toLowerCase();
  if (!['play', 'find', 'control', 'none'].includes(intent)) intent = 'none';

  let control = String(parsed.control || '').trim().toLowerCase();
  if (!CONTROLS.has(control)) control = '';

  let kind = String(parsed.kind || 'track').trim().toLowerCase();
  if (!KINDS.has(kind)) kind = 'track';

  // Запрос чистим ещё раз: модель иногда всё-таки оставляет глагол или кавычки.
  let query = normalizeText(parsed.query || '')
    .replace(/^[«"'\s]+|[»"'\s.!,]+$/g, '')
    .slice(0, 160);

  let isMusic = Boolean(parsed.is_music);

  // Согласованность важнее того, что сказала модель:
  // «музыкальный» ответ без запроса и без команды бесполезен.
  // Это всё ещё РЕШЕНИЕ модели (decided:true) — фраза уходит в обычный чат.
  if (intent === 'control') {
    if (!control) return noMusic(true);
    query = '';
  } else if (intent === 'play' || intent === 'find') {
    if (!query || query.length < 2) return noMusic(true);
  } else {
    isMusic = false;
  }
  if (!isMusic) return noMusic(true);

  const wantAnswer = intent === 'control' ? false : Boolean(parsed.want_answer);

  return {
    is_music: true,
    decided: true,
    intent,
    kind,
    query,
    control,
    want_answer: wantAnswer,
    answer_request: wantAnswer ? normalizeText(parsed.answer_request || '').slice(0, 300) : '',
    confidence: parsed.confidence === 'low' ? 'low' : 'high'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { message, history = [], nowPlaying = '' } = req.body || {};
    const userText = normalizeText(message).slice(0, 600);

    // Пустое или явно длинное сообщение (письмо, текст песни, документ) — не команда.
    // Это осознанный вердикт, а не сбой: decided=true.
    if (!userText || userText.length > 400) return res.status(200).json(noMusic(true));

    const apiKey = readEnv('OPENAI_API_KEY');
    const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
    if (!apiKey || isPlaceholderValue(apiKey) || isPlaceholderValue(baseUrl)) {
      // Без ключа классификатор недоступен — decided=false, клиент откатится
      // на локальные правила и явные музыкальные команды продолжат работать.
      return res.status(200).json(noMusic(false));
    }

    const turns = recentTextTurns(Array.isArray(history) ? history : []);
    const model = envModel(['MUSIC_INTENT_MODEL', 'INTENT_MODEL'], UTILITY_MODEL);

    const response = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: buildMessages(userText, turns, normalizeText(nowPlaying).slice(0, 160)),
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' }
        })
      }),
      // Жёсткий таймаут: этот вызов стоит перед КАЖДЫМ похожим на музыку сообщением,
      // и лучше промахнуться, чем заставить человека ждать.
      9000,
      'Music intent classifier timed out'
    );

    if (!response.ok) {
      console.warn('[music-intent] non-ok:', response.status);
      return res.status(200).json(noMusic(false));
    }

    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    const raw = String(data?.choices?.[0]?.message?.content || '').trim();
    return res.status(200).json(normalizeResult(extractJsonObject(raw)));
  } catch (error) {
    // Fail-open: сбой не должен решать за пользователя. decided=false —
    // клиент вернётся к локальным правилам, обычный чат работает как обычно.
    console.warn('[music-intent] error (fail-open):', compactErrorValue(error?.message));
    return res.status(200).json(noMusic(false));
  }
}
