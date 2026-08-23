/* ============================================================================
   API-КЛЮЧИ: ГЕНЕРАЦИЯ, ХЕШИРОВАНИЕ, ПОИСК.

   ПРАВИЛА, КОТОРЫЕ ЗДЕСЬ ЗАШИТЫ И НЕ ПОДЛЕЖАТ ОБСУЖДЕНИЮ:

   1. Ключ генерируется ТОЛЬКО из crypto.randomBytes. Никаких Math.random,
      Date.now, счётчиков и производных от user_id — иначе ключ предсказуем.
   2. В базу попадает ТОЛЬКО SHA-256 хеш ключа. Открытый ключ существует ровно
      один раз — в ответе на создание/перевыпуск. Ни один запрос после этого
      не может его вернуть: хеш односторонний, восстанавливать нечего.
   3. Для интерфейса храним префикс (первые 8 знаков тела) — по нему рисуется
      маска «sk-h-hd9d••••••••». Префикс не секрет и ключ не раскрывает.
   4. Сравнение хешей — timingSafeEqual, чтобы по времени ответа нельзя было
      подбирать ключ побайтово.

   ФОРМАТ: sk-h-<43 символа base62>  (32 случайных байта).
   32 байта = 256 бит энтропии — столько же, сколько у ключа AES-256.
   ============================================================================ */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const KEY_PREFIX = 'sk-h-';
const KEY_BYTES = 32;
const PREVIEW_LEN = 8;   // сколько знаков тела показываем в маске

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/* ============================================================================
   BASE62 БЕЗ СМЕЩЕНИЯ.
   Наивный `byte % 62` даёт первым 8 символам алфавита чуть большую вероятность
   (256 не делится на 62). Для ключа это ослабление энтропии, поэтому байты
   вне кратного диапазона отбрасываем и добираем новые.
   ============================================================================ */
function randomBase62(length) {
  const limit = 256 - (256 % BASE62.length); // 248
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b >= limit) continue;             // отбрасываем, чтобы не было перекоса
      out += BASE62[b % BASE62.length];
    }
  }
  return out;
}

/* ============================================================================
   СОЗДАНИЕ КЛЮЧА.
   Возвращает { key, hash, preview, prefix }:
     key     — открытый ключ, показать пользователю ОДИН раз и забыть
     hash    — то, что уходит в базу
     preview — первые 8 знаков тела для маски в интерфейсе
   ============================================================================ */
export function generateApiKey() {
  // 32 байта → 43 символа base62 (log62(2^256) ≈ 43).
  const body = randomBase62(43);
  const key = KEY_PREFIX + body;
  return {
    key,
    hash: hashApiKey(key),
    preview: body.slice(0, PREVIEW_LEN),
    prefix: KEY_PREFIX
  };
}

/* Хеш ключа. Соль не нужна и даже вредна: ключ — это 256 бит случайности,
   словарной атаки по нему не бывает, а искать запись мы должны по одному
   детерминированному значению (индекс в базе). */
export function hashApiKey(key) {
  return createHash('sha256').update(String(key || ''), 'utf8').digest('hex');
}

/* Маска для интерфейса: sk-h-hd9d•••••••• */
export function maskApiKey(preview) {
  const head = String(preview || '').slice(0, PREVIEW_LEN);
  return KEY_PREFIX + head + '••••••••';
}

/* Быстрая проверка формы ключа — до любого обращения к базе.
   Отсекает мусор, чужие форматы и попытки SQL/PostgREST-инъекции. */
export function looksLikeApiKey(value) {
  const key = String(value || '').trim();
  if (!key.startsWith(KEY_PREFIX)) return false;
  const body = key.slice(KEY_PREFIX.length);
  return body.length >= 32 && body.length <= 64 && /^[A-Za-z0-9]+$/.test(body);
}

/* Сравнение хешей за постоянное время. */
export function hashesEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ============================================================================
   ИЗВЛЕЧЕНИЕ КЛЮЧА ИЗ ЗАПРОСА.
   Поддерживаем оба варианта, которыми ходят клиенты Anthropic-совместимого API:
     Authorization: Bearer sk-h-...   (ANTHROPIC_AUTH_TOKEN)
     x-api-key: sk-h-...              (ANTHROPIC_API_KEY)
   ============================================================================ */
export function extractApiKey(req) {
  const xKey = String(req.headers?.['x-api-key'] || '').trim();
  if (xKey) return xKey;
  const auth = String(req.headers?.authorization || '').trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return auth;
}

/* ============================================================================
   ТОКЕН ДЛЯ ССЫЛКИ «ПОДЕЛИТЬСЯ ЧАТОМ».
   Не ключ доступа к аккаунту: даёт право только прочитать один конкретный чат.
   Тоже криптослучайный — угадать ссылку перебором нельзя.
   ============================================================================ */
export function generateShareToken() {
  return randomBase62(32);
}

/* ============================================================================
   ИДЕНТИФИКАТОР ЧАТА ДЛЯ URL /chat/<id>.
   Раньше был 'chat_' + Date.now() — предсказуемый: зная примерное время
   создания, чужой чат можно было найти перебором. Теперь 10 знаков base62
   (~59 бит), угадать нельзя. Проверка владельца всё равно остаётся на сервере —
   секретность id не заменяет авторизацию.
   ============================================================================ */
export function generateChatId() {
  return randomBase62(10);
}

/* ============================================================================
   ИДЕМПОТЕНТНОСТЬ ПЛАТЕЖЕЙ.
   Ключ идемпотентности ЮKassa должен быть случайным: если сделать его из
   user_id + Date.now(), два клика в одну секунду дадут один ключ и второй
   платёж молча склеится с первым.
   ============================================================================ */
export function generateIdempotenceKey() {
  return randomBytes(16).toString('hex');
}
