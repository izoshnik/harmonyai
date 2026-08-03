/* ============================================================================
   HarmonyAI — серверный кэш для музыкального модуля.

   Три механизма, все ради скорости:
     1. TTL-кэш в памяти функции.
     2. Single-flight (дедупликация): 10 одновременных запросов «believer»
        порождают ОДИН запрос к Яндексу, остальные ждут тот же промис.
     3. Stale-While-Revalidate: если запись просрочена, но ещё свежая
        в пределах staleMs — отдаём её МГНОВЕННО и обновляем в фоне.
        Пользователь никогда не ждёт повторный сетевой поход.

   Serverless-инстанс живёт между вызовами (warm), поэтому кэш реально
   работает. Холодный старт просто промахивается — это безопасно.
   ========================================================================== */

const store = new Map();      // key -> { value, expiresAt, staleUntil }
const inflight = new Map();   // key -> Promise

// Потолок записей, чтобы память инстанса не росла бесконечно.
const MAX_ENTRIES = 800;

export const TTL = {
  // Поиск меняется редко — держим дольше, это самый частый запрос.
  SEARCH: 10 * 60 * 1000,
  SEARCH_STALE: 60 * 60 * 1000,
  // Метаданные трека практически неизменны.
  TRACK: 6 * 60 * 60 * 1000,
  TRACK_STALE: 24 * 60 * 60 * 1000,
  // Ссылка на аудио подписана и живёт минуты — короткий TTL, без stale.
  PLAYBACK: 2 * 60 * 1000,
  PLAYBACK_STALE: 0,
  // Плейлисты/артисты/альбомы.
  ENTITY: 30 * 60 * 1000,
  ENTITY_STALE: 3 * 60 * 60 * 1000,
  // Подсказки поиска.
  SUGGEST: 30 * 60 * 1000,
  SUGGEST_STALE: 6 * 60 * 60 * 1000,
};

function prune() {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.staleUntil <= now) store.delete(k);
  }
  // Если всё ещё много — выкидываем самые старые (Map хранит порядок вставки).
  while (store.size > MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey === undefined) break;
    store.delete(firstKey);
  }
}

export function cacheGet(key) {
  const rec = store.get(key);
  if (!rec) return { hit: false, stale: false, value: undefined };
  const now = Date.now();
  if (now < rec.expiresAt) return { hit: true, stale: false, value: rec.value };
  if (now < rec.staleUntil) return { hit: true, stale: true, value: rec.value };
  store.delete(key);
  return { hit: false, stale: false, value: undefined };
}

export function cacheSet(key, value, ttlMs, staleMs = 0) {
  const now = Date.now();
  store.set(key, {
    value,
    expiresAt: now + Math.max(0, ttlMs),
    staleUntil: now + Math.max(0, ttlMs) + Math.max(0, staleMs),
  });
  prune();
}

export function cacheDelete(key) {
  store.delete(key);
}

/**
 * Главная обёртка. Возвращает { value, cached, stale }.
 *
 * @param {string}   key
 * @param {Function} producer  async () => value
 * @param {number}   ttlMs
 * @param {number}   staleMs   окно stale-while-revalidate (0 — выключено)
 */
export async function cacheWrap(key, producer, ttlMs, staleMs = 0) {
  const found = cacheGet(key);

  if (found.hit && !found.stale) {
    return { value: found.value, cached: true, stale: false };
  }

  if (found.hit && found.stale) {
    // Отдаём просроченное немедленно, обновляем в фоне.
    if (!inflight.has(key)) {
      const bg = Promise.resolve()
        .then(producer)
        .then((fresh) => { cacheSet(key, fresh, ttlMs, staleMs); return fresh; })
        .catch(() => found.value)   // фон падать не должен
        .finally(() => { inflight.delete(key); });
      inflight.set(key, bg);
    }
    return { value: found.value, cached: true, stale: true };
  }

  // Single-flight: параллельные одинаковые запросы ждут один промис.
  if (inflight.has(key)) {
    const value = await inflight.get(key);
    return { value, cached: true, stale: false };
  }

  const p = Promise.resolve()
    .then(producer)
    .then((fresh) => { cacheSet(key, fresh, ttlMs, staleMs); return fresh; })
    .finally(() => { inflight.delete(key); });

  inflight.set(key, p);
  const value = await p;
  return { value, cached: false, stale: false };
}

/** Прогрев без ожидания — используется для префетча ссылки на лучший трек. */
export function cachePrime(key, producer, ttlMs, staleMs = 0) {
  const found = cacheGet(key);
  if (found.hit && !found.stale) return;
  if (inflight.has(key)) return;
  const p = Promise.resolve()
    .then(producer)
    .then((fresh) => { cacheSet(key, fresh, ttlMs, staleMs); return fresh; })
    .catch(() => undefined)
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
}

export function cacheStats() {
  return { entries: store.size, inflight: inflight.size };
}
