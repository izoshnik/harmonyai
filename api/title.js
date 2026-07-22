export const config = {
  maxDuration: 20
};

/* ============================================================================
   ГЕНЕРАТОР НАЗВАНИЯ ЧАТА.
   Отдельный лёгкий путь: получает первое сообщение пользователя и первый ответ
   ассистента, возвращает { title } — короткое описание ТЕМЫ переписки
   (3–6 слов, на русском), а не первые слова промпта.

   Принципы (как в api/intent.js):
     - Дешёвая mini-модель, один вызов, JSON-ответ.
     - Fail-open: при любой ошибке возвращаем { title: '' } — клиент сам
       откатится к нейтральному «Новый чат», отправка сообщений не ломается.
     - Лёгкая защита: проверка Origin/Referer + in-memory rate-limit по IP.
   ============================================================================ */

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

function compactErrorValue(value = '', max = 200) {
  return String(value || '').slice(0, max);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* -------- Лёгкая защита: разрешённые источники -------- */
const ALLOWED_HOSTS = [
  'harmonyai-zeta.vercel.app',
  'localhost',
  '127.0.0.1'
];
function originAllowed(req) {
  // Разрешаем запросы без Origin/Referer (некоторые мобильные webview их не шлют),
  // но если заголовок есть — он должен указывать на наш хост.
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

/* -------- Лёгкий in-memory rate-limit по IP (сбрасывается при холодном старте) -------- */
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30; // не более 30 запросов названия в минуту с одного IP
const _rlStore = new Map();
function rateLimited(req) {
  const ip = String(
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown'
  );
  const now = Date.now();
  const rec = _rlStore.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    _rlStore.set(ip, { start: now, count: 1 });
    // Периодическая уборка, чтобы Map не рос бесконечно.
    if (_rlStore.size > 5000) {
      for (const [k, v] of _rlStore) { if (now - v.start > RL_WINDOW_MS) _rlStore.delete(k); }
    }
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

function extractJsonObject(raw = '') {
  const text = String(raw).trim();
  if (!text) return null;
  // Прямой парс.
  try { return JSON.parse(text); } catch (e) { /* ниже */ }
  // Из ```json ... ``` или из первого {...}.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (e) { /* ниже */ } }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch (e) { /* ниже */ } }
  return null;
}

function sanitizeTitle(raw = '') {
  let t = String(raw || '')
    .replace(/["«»`*_#]/g, '')     // без кавычек/markdown
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Убираем финальную точку, оставляем ? и !.
  t = t.replace(/\.+$/, '').trim();
  // Ограничиваем длину по словам, максимум ~48 символов.
  if (t.length > 48) t = t.slice(0, 48).replace(/\s+\S*$/, '').trim();
  return t;
}

function buildMessages(userText, assistantText) {
  const sys =
    'Ты формируешь КОРОТКОЕ название чата по теме переписки. ' +
    'Верни строго JSON вида {"title":"..."}. ' +
    'Требования к title: 2–6 слов на русском языке, отражает СУТЬ/ТЕМУ разговора, ' +
    'а не первые слова пользователя; без кавычек, без точки в конце, с заглавной буквы. ' +
    'Пример: для вопроса про параллельные квинты → "Параллельные квинты в гармонии". ' +
    'Если тема бытовая/общая — сформулируй её обобщённо.';
  const usr =
    'Первое сообщение пользователя:\n' + userText.slice(0, 1500) +
    (assistantText ? ('\n\nОтвет ассистента (начало):\n' + assistantText.slice(0, 1200)) : '') +
    '\n\nВерни JSON с полем title.';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr }
  ];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  // Лёгкая защита.
  if (!originAllowed(req)) return res.status(403).json({ title: '' });
  if (rateLimited(req)) return res.status(429).json({ title: '' });

  try {
    const { message = '', answer = '' } = req.body || {};
    const userText = normalizeText(message);
    const assistantText = normalizeText(answer);
    if (!userText) return res.status(200).json({ title: '' });

    const apiKey = readEnv('OPENAI_API_KEY');
    const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
    if (!apiKey || isPlaceholderValue(apiKey) || isPlaceholderValue(baseUrl)) {
      // Без ключа — fail-open: клиент сделает фолбэк сам.
      return res.status(200).json({ title: '' });
    }

    const model = readEnv('TITLE_MODEL') || readEnv('INTENT_MODEL') || 'gpt-5.4-mini';
    try {
      const response = await withTimeout(
        fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: buildMessages(userText, assistantText),
            temperature: 0.2,
            max_tokens: 40,
            response_format: { type: 'json_object' }
          })
        }),
        15000,
        'Title generator timed out'
      );
      if (!response.ok) {
        console.warn('[title] non-ok:', response.status);
        return res.status(200).json({ title: '' });
      }
      let data = {};
      try { data = await response.json(); } catch (e) { data = {}; }
      const raw = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJsonObject(raw);
      const title = sanitizeTitle(parsed?.title || '');
      return res.status(200).json({ title });
    } catch (e) {
      console.warn('[title] generator error (fail-open):', compactErrorValue(e?.message, 200));
      return res.status(200).json({ title: '' });
    }
  } catch (error) {
    console.error('[title] handler error:', compactErrorValue(error?.message, 500));
    return res.status(200).json({ title: '' });
  }
}
