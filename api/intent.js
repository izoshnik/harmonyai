export const config = {
  maxDuration: 30
};

/* ============================================================================
   INTENT-КЛАССИФИКАТОР ДЛЯ ГЕНЕРАЦИИ ИЗОБРАЖЕНИЙ.
   Полностью изолирован от api/chat.js и api/generate-image.js — это отдельный
   лёгкий путь, который запускается ДО генерации, чтобы:
     1) решить, действительно ли пользователь просит картинку (need_image);
     2) понять, хватает ли деталей, или нужно уточнение (clarify);
     3) собрать развитый промпт для Flux на английском (image_prompt);
     4) либо сформулировать уточняющий вопрос на русском (clarify_question).

   Пайплайн:
     - Пред-фильтр по ключевым словам (дёшево, без вызова модели): если визуальных
       маркеров нет и режим не включён принудительно — сразу need_image=false.
     - Иначе — один вызов mini-модели (gpt-5.4-mini) с JSON-системным промптом.
     - Жёсткий парсинг JSON (модель иногда оборачивает в ```json``` или добавляет текст).
     - Fail-open: при любой ошибке/недоступности — {need_image:false}, чтобы обычный
       текстовый ответ не ломался. Включённый режим (forceImage) при ошибке отдаёт
       need_image=true с сырым текстом как image_prompt — генерация всё равно пойдёт. */

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderValue(value = '') {
  const low = String(value || '').trim().toLowerCase();
  return !low || low === 'undefined' || low === 'null' || low === 'your_key_here' || low === 'openai_base_url';
}

function normalizeText(text = '') {
  return String(text)
    .replace(/ /g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compactErrorValue(value, limit = 500) {
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

// Грубый первый фильтр: есть ли в сообщении намёк на визуальный контент.
// Используется только чтобы НЕ дёргать LLM-классификатор на каждом «спасибо» и
// «расскажи про тональность». Не решает итоговое need_image — это делает LLM.
const VISUAL_HINT_KEYWORDS = [
  // русские триггеры генерации / рисования
  'нарисуй', 'нарисовать', 'нарису', 'сгенерируй картинк', 'сгенерируй изображени',
  'сгенерируй мне', 'сгенерируй фото', 'создай изображени', 'создай картинк',
  'сделай картинк', 'сделай изображени', 'сделай фото', 'сгенерир', 'создай картинку',
  'сделай картинку', 'нарисуй мне', 'изобрази', 'покажи как выглядит', 'нарисуй картинку',
  // английские
  'draw ', 'draw a', 'draw me', 'generate image', 'generate a picture', 'generate a picture of',
  'generate an image', 'create an image', 'create a picture', 'make a picture', 'make an image',
  'render', 'illustrate',
  // контекстные намёки
  'обложк', 'иллюстраци', 'постер', 'арт', 'визуализ', 'эскиз', 'картинк', 'изображени',
  'фото', 'портрет', 'пейзаж', 'логотип', 'иконк', 'обои', 'баннер', 'фон для'
];

function hasVisualHint(text = '') {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  return VISUAL_HINT_KEYWORDS.some((kw) => low.includes(kw));
}

// Извлекаем последние ~6 текстовых сообщений истории для контекста классификатора,
// чтобы понимать «нарисуй это» / «давай ещё» после обсуждения темы. Фото/файлы
// в историю классификатору не передаём — только текст, держим запрос лёгким.
function recentTextTurns(history = [], limit = 6) {
  const turns = [];
  for (let i = history.length - 1; i >= 0 && turns.length < limit; i -= 1) {
    const m = history[i];
    if (!m || m.role === 'system') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join(' ');
    }
    text = normalizeText(text).slice(0, 600);
    if (text) turns.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', text });
  }
  return turns;
}

// Надёжно достаём JSON из ответа модели: она часто оборачивает в ```json ... ```
// или добавляет пояснения до/после. Берём первую {...}-блочную конструкцию.
function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 1) прямой парсинг, если модель отдала чистый JSON
  try { return JSON.parse(text); } catch (e) { /* идём дальше */ }
  // 2) вырезаем fenced-блок ```json ... ``` или ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* идём дальше */ }
  }
  // 3) ищем первую сбалансированную {...} в тексте
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
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function buildClassifierMessages(userText, turns, forceImage) {
  const historyBlock = turns.length
    ? '\n\nКонтекст последних сообщений чата (последнее — самое свежее):\n' +
      turns.map((t) => `${t.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${t.text}`).join('\n')
    : '';

  const systemPrompt = [
    'Ты — модуль анализа намерений. Пользователь написал сообщение в музыкальном ассистенте HarmonyAI.',
    'Определи по сообщению (и краткому контексту чата, если он есть):',
    '1) need_image: true/false — действительно ли пользователь просит СГЕНЕРИРОВАТЬ изображение,',
    '   а не просто упомянул слово «картинка»/«ноты» в разговоре или просит объяснить теорию.',
    '2) clarify: true/false — достаточно ли конкретики для качественной генерации (что именно изобразить,',
    '   стиль, настроение, ракурс), или лучше задать уточняющий вопрос.',
    '3) image_prompt: если need_image=true и clarify=false — готовый развитый промпт для image-модели (Flux)',
    '   НА АНГЛИЙСКОМ, с деталями стиля, композиции, освещения, настроения. Не копируй сырой текст пользователя —',
    '   переформулируй в чёткое визуальное описание. Без водяных знаков и текста на картинке, если не просят.',
    '4) clarify_question: если need_image=true и clarify=true — короткий уточняющий вопрос пользователю НА РУССКОМ,',
    '   который поможет собрать недостающие детали (что именно, в каком стиле, для чего).',
    '',
    forceImage
      ? 'ВАЖНО: пользователь явно включил режим генерации изображения — он точно хочет картинку. ' +
        'Поэтому need_image=true всегда. Тебе остаётся только решить, хватает ли деталей (clarify), ' +
        'и собрать image_prompt или clarify_question.'
      : 'Если пользователь просто обсуждает музыку, теорию, ноты как текст или общается — need_image=false.',
    '',
    'Отвечай ТОЛЬКО валидным JSON без пояснений и без markdown-обёртки. Формат:',
    '{"need_image": true|false, "clarify": true|false, "image_prompt": "...", "clarify_question": "..."}',
    'Поля image_prompt/clarify_question могут быть пустой строкой, если не применимы.'
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Сообщение пользователя:${userText}${historyBlock}` }
  ];
}

function normalizeIntentResult(parsed, userText, forceImage) {
  const needImage = forceImage ? true : Boolean(parsed?.need_image);
  const clarify = Boolean(parsed?.clarify);
  let imagePrompt = String(parsed?.image_prompt || '').trim();
  let clarifyQuestion = String(parsed?.clarify_question || '').trim();

  // Подстраховка: если решили генерировать, но промпт пуст — используем сырой текст
  // пользователя (на английском не получится, но лучше чем ничего; Flux понимает и русские запросы).
  if (needImage && !clarify && !imagePrompt) {
    imagePrompt = normalizeText(userText).slice(0, 1000);
  }
  // Если уточняем, но вопрос пуст — ставим разумный дефолт, чтобы фронт не показал пустоту.
  if (needImage && clarify && !clarifyQuestion) {
    clarifyQuestion = 'Опишите подробнее, что именно вы хотите увидеть на изображении: сюжет, стиль, настроение, ракурс.';
  }

  return {
    need_image: needImage,
    clarify,
    image_prompt: imagePrompt.slice(0, 1200),
    clarify_question: clarifyQuestion.slice(0, 600)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { message, history = [], forceImage = false, userId = null } = req.body || {};
    const userText = normalizeText(message);

    // 1) Пред-фильтр по ключевым словам (первый грубый барьер — без вызова модели).
    //    Если режим не включён принудительно и визуальных маркеров нет — это точно не генерация.
    if (!forceImage && !hasVisualHint(userText)) {
      return res.status(200).json({ need_image: false, clarify: false, image_prompt: '', clarify_question: '' });
    }

    // 2) LLM-классификатор (mini — дёшево и быстро).
    const apiKey = readEnv('OPENAI_API_KEY');
    const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
    if (!apiKey || isPlaceholderValue(apiKey) || isPlaceholderValue(baseUrl)) {
      // Без ключа — fail-open: не блокируем пользователя.
      // Если режим включён — отдаём генерацию с сырым текстом; иначе обычный текстовый путь.
      if (forceImage) {
        return res.status(200).json({
          need_image: true, clarify: false,
          image_prompt: userText.slice(0, 1000), clarify_question: ''
        });
      }
      return res.status(200).json({ need_image: false, clarify: false, image_prompt: '', clarify_question: '' });
    }

    const turns = recentTextTurns(Array.isArray(history) ? history : []);
    const classifierMessages = buildClassifierMessages(userText, turns, Boolean(forceImage));
    const classifierModel = readEnv('INTENT_MODEL') || 'gpt-5.4-mini';

    try {
      const response = await withTimeout(
        fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: classifierModel,
            messages: classifierMessages,
            temperature: 0,
            max_tokens: 600,
            response_format: { type: 'json_object' }
          })
        }),
        18000,
        'Intent classifier timed out'
      );

      if (!response.ok) {
        // Нестрого: при ошибке модели не ломаем чат — откатываемся к эвристике.
        console.warn('[intent] classifier non-ok:', response.status);
        return res.status(200).json(normalizeIntentResult({}, userText, Boolean(forceImage)));
      }

      let data = {};
      try { data = await response.json(); } catch (e) { data = {}; }
      const raw = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJsonObject(raw);
      if (!parsed) {
        console.warn('[intent] no JSON parsed from classifier output:', compactErrorValue(raw, 200));
        return res.status(200).json(normalizeIntentResult({}, userText, Boolean(forceImage)));
      }
      return res.status(200).json(normalizeIntentResult(parsed, userText, Boolean(forceImage)));
    } catch (e) {
      console.warn('[intent] classifier error (fail-open):', compactErrorValue(e?.message, 200));
      return res.status(200).json(normalizeIntentResult({}, userText, Boolean(forceImage)));
    }
  } catch (error) {
    // Внешний catch — любая непредвиденная ошибка не должна рвать отправку сообщения.
    console.error('[intent] handler error:', compactErrorValue(error?.message, 500));
    return res.status(200).json({ need_image: false, clarify: false, image_prompt: '', clarify_question: '' });
  }
}
