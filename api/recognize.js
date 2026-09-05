/* ===== ЕДИНЫЙ РЕЕСТР МОДЕЛЕЙ =================================================
   Продуктовая матрица:
     Free  — Adanatos: текст/файлы/нотация → claude-haiku-4-5, картинки → Cloudflare Workers AI
     Pro   — Dynatos:  текст/файлы/нотация → gpt-5.5,          картинки → gpt-image-2
   Служебные вызовы (классификаторы интента, заголовки чатов, модерация промптов)
   идут на UTILITY_MODEL — она самая дешёвая и в матрице уже оплачена.

   Модели семейства 5.4 в продукте не используются вообще. Раньше они попадали в
   биллинг двумя путями: как дефолты в коде и как значения переменных окружения,
   скопированные из .env.example. Поэтому имя модели теперь всегда проходит через
   pickModel(): запрещённое значение отбрасывается с предупреждением в лог, а
   запрос уходит на разрешённую модель. Файл лежит в /lib — он бандлится в
   функции и НЕ расходует лимит Vercel Hobby (12 функций уже занято).
   ========================================================================== */

export const FREE_TEXT_MODEL = 'claude-haiku-4-5-20251001';
export const PRO_TEXT_MODEL = 'gpt-5.5';
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
export function pickModel(requested, fallback) {
  const safeFallback = String(fallback || UTILITY_MODEL).trim() || UTILITY_MODEL;
  const raw = String(requested == null ? '' : requested).trim();
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
    contextWindow: 200000,
    maxOutputTokens: 64000
  },
  adanatos: {
    id: 'adanatos',
    label: 'Adanatos',
    description: 'Быстрая и дешёвая модель для повседневных задач',
    envNames: ['ADANATOS_MODEL', 'ADANATOS_MODEL_FALLBACK'],
    internalFallback: FREE_TEXT_MODEL,
    contextWindow: 200000,
    maxOutputTokens: 32000
  }
};

export const PUBLIC_MODEL_IDS = Object.keys(PUBLIC_MODELS);

/* Публичный id → внутреннее имя модели. Неизвестный id даёт null:
   вызывающий обязан вернуть 404/400, а НЕ молча подставить другую модель —
   иначе пользователь заплатит по тарифу одной модели за ответ другой. */
export function resolvePublicModel(publicId) {
  const id = String(publicId || '').trim().toLowerCase();
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
  return Boolean(PUBLIC_MODELS[String(publicId || '').trim().toLowerCase()]);
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
    ? String(requestedPublicId).trim().toLowerCase()
    : PUBLIC_MODEL_IDS[0];
}
