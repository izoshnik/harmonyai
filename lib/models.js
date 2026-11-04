/* ===== ЕДИНЫЙ РЕЕСТР МОДЕЛЕЙ =================================================
   Продуктовая матрица:
     Free  — Adan:    gemini-3.5-flash-lite (основная, ключ GEMINI_API_KEY) → nemotron-3.5-super-vl:free →
                      inkling → gemma-4-31b → nemotron (OpenRouter) → deepseek-v4-flash (pro-ai.online);
                      картинки → Cloudflare
     Pro   — Dynatos: glm-5.3-flash (pro-ai.online) → gemini-3.5-flash → цепочка Adan; картинки → gpt-image-2
   Провайдеры: pro-ai.online (OPENAI_BASE_URL + OPENAI_API_KEY), OpenRouter
   (OPENROUTER_API_KEY) — модель с «/» в имени (vendor/model), и Google Gemini
   (GEMINI_API_KEY) — модели gemini-*.
   Служебные вызовы (классификаторы интента, заголовки чатов, модерация промптов)
   идут на UTILITY_MODEL — она самая дешёвая и в матрице уже оплачена.

   Модели семейства 5.4 в продукте не используются вообще. Раньше они попадали в
   биллинг двумя путями: как дефолты в коде и как значения переменных окружения,
   скопированные из .env.example. Поэтому имя модели теперь всегда проходит через
   pickModel(): запрещённое значение отбрасывается с предупреждением в лог, а
   запрос уходит на разрешённую модель. Файл лежит в /lib — он бандлится в
   функции и НЕ расходует лимит Vercel Hobby (12 функций уже занято).
   ========================================================================== */

export const FREE_TEXT_MODEL = 'deepseek-v4-flash';
export const PRO_TEXT_MODEL = 'glm-5.3-flash';
export const UTILITY_MODEL = FREE_TEXT_MODEL;
export const PRO_IMAGE_MODEL = 'gpt-image-2';
export const FREE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/* Ловит gpt-5.4, gpt-5.4-mini, openai/gpt-5.4 и т.п., но не задевает 5.45/15.4. */
const FORBIDDEN_MODEL_RE = /(?:^|[^\d.])5\.4(?![\d])/;

export function isForbiddenModel(name) {
  const raw = String(name == null ? '' : name).trim().toLowerCase();
  if (!raw) return false;
  return FORBIDDEN_MODEL_RE.test(raw);
}

/* Возвращает запрошенную модель, если она разрешена; иначе — fallback. */
/* Провайдер переименовывает модели: в ноябре 2026 pro-ai.online убрал
   deepseek-v4-flash (осталась deepseek-v4-flash), и всё, что ходило по
   старому имени, — запасная Adan, служебные задачи, корректор — получало
   «model not available». Старые имена (в том числе из переменных Vercel)
   переводим на новые здесь, в одном месте. */
const RENAMED_MODELS = { 'deepseek-v4-flash-0731': 'deepseek-v4-flash' };
export function currentModelName(name) {
  const raw = String(name == null ? '' : name).trim();
  return RENAMED_MODELS[raw.toLowerCase()] || raw;
}

export function pickModel(requested, fallback) {
  const safeFallback = currentModelName(String(fallback || UTILITY_MODEL).trim() || UTILITY_MODEL);
  const raw = currentModelName(requested == null ? '' : requested);
  if (!raw) return safeFallback;
  if (isForbiddenModel(raw)) {
    console.warn(`[models] модель "${raw}" исключена из продукта — использую "${safeFallback}"`);
    return safeFallback;
  }
  return raw;
}

/* Первое непустое значение из списка переменных окружения, прогнанное через pickModel. */
export function envModel(names, fallback) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = String(process.env[name] || '').trim();
    if (value) return pickModel(value, fallback);
  }
  return pickModel('', fallback);
}

/* ===== ПУБЛИЧНЫЕ ИМЕНА МОДЕЛЕЙ ДЛЯ ВНЕШНЕГО API ==============================
   Наружу (в /v1/models, в документации, в ответах шлюза) мы отдаём ТОЛЬКО
   dynatos и adanatos. Внутренние имена моделей апстрима — коммерческая
   информация поставщика и не должны утекать ни в ответе, ни в тексте ошибки,
   ни в логах, доступных клиенту.

   Развязка нужна ещё и для того, чтобы менять апстрим без изменения публичного
   контракта: достаточно переопределить DYNATOS_MODEL / ADANATOS_MODEL в
   переменных окружения — клиенты этого не заметят.
   ========================================================================== */

export const PUBLIC_MODELS = {
  dynatos: {
    id: 'dynatos',
    label: 'Dynatos',
    description: 'Флагманская модель: длинный контекст, сложные задачи, код',
    envNames: ['DYNATOS_MODEL', 'DYNATOS_MODEL_FALLBACK'],
    internalFallback: PRO_TEXT_MODEL,
    contextWindow: 1000000,
    maxOutputTokens: 64000
  },
  adanatos: {
    id: 'adanatos',
    label: 'Adan',
    description: 'Быстрая и дешёвая модель для повседневных задач',
    envNames: ['ADANATOS_MODEL', 'ADANATOS_MODEL_FALLBACK'],
    internalFallback: FREE_TEXT_MODEL,
    contextWindow: 1000000,
    maxOutputTokens: 32000
  }
};

export const PUBLIC_MODEL_IDS = Object.keys(PUBLIC_MODELS);

/* Короткие имена: модель на сайте называется Adan, и в API её можно звать
   так же. Учёт и цены остаются на каноническом id (adanatos). */
export const PUBLIC_MODEL_ALIASES = { adan: 'adanatos' };
export function canonicalPublicId(publicId) {
  const id = String(publicId || '').trim().toLowerCase();
  return PUBLIC_MODEL_ALIASES[id] || id;
}

/* Публичный id → внутреннее имя модели. Неизвестный id даёт null:
   вызывающий обязан вернуть 404/400, а НЕ молча подставить другую модель —
   иначе пользователь заплатит по тарифу одной модели за ответ другой. */
export function resolvePublicModel(publicId) {
  const id = canonicalPublicId(publicId);
  const row = PUBLIC_MODELS[id];
  if (!row) return null;
  return {
    id,
    label: row.label,
    internal: envModel(row.envNames, row.internalFallback),
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens
  };
}

/* Есть ли такой публичный id. */
export function isPublicModel(publicId) {
  return Boolean(PUBLIC_MODELS[canonicalPublicId(publicId)]);
}

/* Внутреннее имя → публичный id. Нужно на выходе шлюза: в ответе апстрима
   поле model содержит внутреннее имя, и его надо подменить перед отдачей.
   Если соответствия нет — отдаём запрошенный клиентом id, но никогда
   не внутреннее имя. */
export function toPublicModelId(internalName, requestedPublicId) {
  const internal = String(internalName || '').trim().toLowerCase();
  for (const id of PUBLIC_MODEL_IDS) {
    const resolved = resolvePublicModel(id);
    if (resolved && resolved.internal.toLowerCase() === internal) return id;
  }
  return isPublicModel(requestedPublicId)
    ? canonicalPublicId(requestedPublicId)
    : PUBLIC_MODEL_IDS[0];
}

/* ============================================================================
   ПРОВАЙДЕРЫ
   • pro-ai.online — основной OpenAI-совместимый шлюз (бывший codex-api.online:
     провайдер сменил адрес, старое значение OPENAI_BASE_URL подменяется само).
   • OpenRouter — модели вида vendor/model (например nvidia/nemotron-3.5-super-vl:free).
   ========================================================================== */
export const DEFAULT_BASE_URL = 'https://api.pro-ai.online/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
function utilReadEnv(name) { return String(process.env[name] || '').trim(); }

export function providerBaseUrl() {
  const raw = utilReadEnv('OPENAI_BASE_URL');
  if (!raw || /codex-api\.online/i.test(raw) || /^(undefined|null|openai_base_url)$/i.test(raw)) return DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}
export function isOpenRouterModel(name) { return String(name || '').includes('/'); }

/* ДЛИННЫЙ КОНТЕКСТ. Публично обе модели — 1 000 000 токенов. pro-ai.online
   режет контекст до 128K, а у OpenRouter те же модели держат ~1M. Поэтому
   запрос длиннее LONG_CONTEXT_THRESHOLD токенов уходит на ту же модель через
   OpenRouter (LONG_CONTEXT_MODEL переопределяет). */
export const LONG_CONTEXT_THRESHOLD = 120000;
const LONG_CONTEXT_TWINS = { 'glm-5.3-flash': 'z-ai/glm-5.3-flash', 'deepseek-v4-flash': 'deepseek/deepseek-v4-flash' };
export function longContextModel(internal) {
  const env = utilReadEnv('LONG_CONTEXT_MODEL');
  if (env) return env;
  const n = String(internal || '').trim();
  if (n.includes('/')) return n; // уже OpenRouter
  return LONG_CONTEXT_TWINS[n] || 'z-ai/glm-5.3-flash';
}

/* ============================================================================
   GEMINI (ключ Google AI Studio — тот же GEMINI_API_KEY, что смотрит видео).
   Модели gemini-* идут в OpenAI-совместимый шлюз Google:
   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions.
   Ключ нового формата «AQ.» принимается не всеми способами авторизации, поэтому
   providerFetch() пробует заголовок x-goog-api-key, при 401/403 — параметр
   ?key= и Bearer, и запоминает сработавший способ (как lib/video-watch.js).
   ========================================================================== */
export const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
export function geminiApiKey() {
  const k = utilReadEnv('GEMINI_API_KEY') || utilReadEnv('GOOGLE_AI_API_KEY');
  return /^(undefined|null|your_key_here)$/i.test(k) ? '' : k;
}
export function isGeminiModel(name) { return /^gemini-/i.test(String(name || '').trim()); }
/* Gemini для чата: Adan — быстрая Flash Lite, запасная для Pro — Flash. */
export function geminiChatModel() { return utilReadEnv('GEMINI_CHAT_MODEL') || 'gemini-3.5-flash-lite'; }
export function geminiProModel() { return utilReadEnv('GEMINI_PRO_MODEL') || 'gemini-3.5-flash'; }

/* Куда и с какими заголовками отправлять запрос к модели. */
export function providerForModel(name) {
  if (isGeminiModel(name) && geminiApiKey()) {
    return {
      baseUrl: (utilReadEnv('GEMINI_OPENAI_BASE') || GEMINI_OPENAI_BASE).replace(/\/+$/, ''),
      apiKey: geminiApiKey(),
      headers: {},
      openrouter: false,
      gemini: true
    };
  }
  if (isOpenRouterModel(name)) {
    return {
      baseUrl: (utilReadEnv('OPENROUTER_BASE_URL') || OPENROUTER_BASE_URL).replace(/\/+$/, ''),
      apiKey: utilReadEnv('OPENROUTER_API_KEY'),
      headers: { 'HTTP-Referer': utilReadEnv('SITE_URL') || 'https://harmonyai.ru', 'X-Title': 'HarmonyAI' },
      openrouter: true
    };
  }
  return { baseUrl: providerBaseUrl(), apiKey: utilReadEnv('OPENAI_API_KEY'), headers: {}, openrouter: false };
}

/* Запрос к провайдеру модели с правильной авторизацией.
   pr — результат providerForModel(); path — '/chat/completions' и т.п.;
   init — как у fetch (body — строка JSON: её можно повторить). apiKey —
   запасной ключ, если у провайдера своего нет (pro-ai.online из вызывающего). */
let geminiAuthMode = 'header';
export async function providerFetch(pr, path, init = {}, apiKey = '') {
  const key = pr.apiKey || apiKey;
  const go = (mode) => {
    let url = `${pr.baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json', ...(pr.headers || {}), ...(init.headers || {}) };
    if (mode === 'query') url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    else if (mode === 'header') headers['x-goog-api-key'] = key;
    else headers.Authorization = `Bearer ${key}`;
    return fetch(url, { ...init, headers });
  };
  if (!pr.gemini) return go('bearer');
  const first = await go(geminiAuthMode);
  if (first.status !== 401 && first.status !== 403) return first;
  for (const mode of ['header', 'query', 'bearer'].filter((m) => m !== geminiAuthMode)) {
    const r = await go(mode);
    if (r.status !== 401 && r.status !== 403) { geminiAuthMode = mode; return r; }
  }
  return first;
}

/* ВРЕМЕННО НЕДОСТУПНЫЕ МОДЕЛИ (общая отметка для чата и служебных задач).
   pro-ai.online иногда отвечает 502 «could not be verified» на всё подряд —
   каждый такой ответ стоит 3–5 секунд. Модель, которая только что так упала,
   минуту не трогаем и сразу идём к запасной. Отметка живёт в памяти функции. */
const _coolDown = new Map();
export function coolDownModel(name, ms = 60000) { if (name) _coolDown.set(String(name), Date.now() + ms); }
export function isCoolingDown(name) {
  const until = _coolDown.get(String(name || ''));
  if (!until) return false;
  if (Date.now() >= until) { _coolDown.delete(String(name)); return false; }
  return true;
}
/* Ошибка шлюза/провайдера, после которой модель стоит пропустить на минуту. */
export function isProviderOutage(status, text = '') {
  const low = String(text || '').toLowerCase();
  return status === 502 || status === 503 || status === 504
    || low.includes('could not be verified') || low.includes('temporarily unavailable') || low.includes('service_unavailable');
}

/* ============================================================================
   СКРЫТЫЕ РАССУЖДЕНИЯ ПО УМОЛЧАНИЮ
   Модели pro-ai.online (кроме claude и картинок) принимают reasoning_effort
   low|medium|high|xhigh (см. /v1/models → supported_reasoning_efforts). Без
   параметра часть из них «думает» на уровне по умолчанию — это секунды до
   первого слова ответа. Явное 'low' безопасно лишь для тех, кто действительно
   думает сам: гибридной модели, которая по умолчанию отвечает сразу, этот
   параметр мог бы рассуждения как раз включить. Поэтому сервер учится: увидел
   скрытые рассуждения там, где их не просили (reasoning_content в потоке или в
   ответе), — со следующего запроса эта модель получает reasoning_effort:'low'.
   Хуже от этого не становится ни в одном случае.
   ========================================================================== */
const _thinksByDefault = new Set();
export function supportsReasoningEffort(name) {
  const n = String(name || '');
  return Boolean(n) && !isOpenRouterModel(n) && !/^(claude|gpt-image)/i.test(n);
}
export function noteUnaskedReasoning(name) {
  if (!supportsReasoningEffort(name) || _thinksByDefault.has(name)) return;
  _thinksByDefault.add(name);
  console.warn(`[models] ${name} рассуждает без запроса — дальше шлём reasoning_effort=low`);
}
/* Есть ли в нестримовом ответе следы скрытых рассуждений. */
export function responseHasReasoning(data) {
  const m = data?.choices?.[0]?.message || {};
  return Boolean(String(m.reasoning_content || m.reasoning || '').trim()) || Number(data?.usage?.completion_tokens_details?.reasoning_tokens) > 0;
}
/* Уровень рассуждений для «быстрого» запроса (без «Думать»): 'low' или ''. */
export function fastReasoningEffort(name) {
  return _thinksByDefault.has(name) ? 'low' : '';
}

/* ============================================================================
   СЛУЖЕБНАЯ МОДЕЛЬ (распознавание намерений, заголовки чатов, модерация картинок,
   музыкальные команды, дистиллятор учебников): быстрая deepseek-v4-flash
   на pro-ai.online. Переопределяется переменными *_MODEL у каждого вызова.
   ========================================================================== */
export function utilityEndpoint() {
  return { apiKey: utilReadEnv('OPENAI_API_KEY'), baseUrl: providerBaseUrl(), model: UTILITY_MODEL };
}
export function utilityModel(envNames) {
  return envModel(envNames, UTILITY_MODEL);
}
