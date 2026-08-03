/* ============================================================================
   HarmonyAI — клиентский кэш музыки.

   Три уровня, все ради скорости:
     1. Память        — мгновенно, живёт до перезагрузки вкладки.
     2. sessionStorage — переживает переходы между чатами.
     3. Одиночный полёт — два одинаковых запроса дают ОДИН вызов сети.

   Ссылки на аудио хранятся только в памяти: они подписанные и короткоживущие,
   класть их в storage бессмысленно и небезопасно.
   ========================================================================== */

(function (global) {
  'use strict';

  var PREFIX = 'hm_music_';
  var MAX_MEMORY = 300;

  var memory = new Map();
  var inflight = new Map();

  var TTL = {
    SEARCH: 10 * 60 * 1000,
    COLLECTION: 30 * 60 * 1000,
    SUGGEST: 30 * 60 * 1000,
    // Подписанная ссылка живёт у Яндекса около 5 минут.
    // Берём 2.5 минуты с запасом, чтобы не отдать протухшую.
    PLAYBACK: 150 * 1000
  };

  function prune() {
    if (memory.size <= MAX_MEMORY) return;
    var excess = memory.size - MAX_MEMORY;
    var it = memory.keys();
    for (var i = 0; i < excess; i++) {
      var k = it.next();
      if (k.done) break;
      memory.delete(k.value);
    }
  }

  function get(key) {
    var now = Date.now();

    var hit = memory.get(key);
    if (hit) {
      if (hit.expires > now) return hit.value;
      memory.delete(key);
    }

    // Второй уровень — только для данных без подписанных ссылок.
    if (key.indexOf('play:') === 0) return null;
    try {
      var raw = global.sessionStorage.getItem(PREFIX + key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.expires <= now) {
        global.sessionStorage.removeItem(PREFIX + key);
        return null;
      }
      // Поднимаем в память, чтобы следующий доступ был мгновенным.
      memory.set(key, parsed);
      return parsed.value;
    } catch (e) {
      return null;
    }
  }

  function set(key, value, ttlMs) {
    var entry = { value: value, expires: Date.now() + (ttlMs || TTL.SEARCH) };
    memory.set(key, entry);
    prune();

    if (key.indexOf('play:') === 0) return;
    try {
      global.sessionStorage.setItem(PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      // Квота исчерпана — чистим своё и живём дальше на памяти.
      clearStorage();
    }
  }

  function clearStorage() {
    try {
      var doomed = [];
      for (var i = 0; i < global.sessionStorage.length; i++) {
        var k = global.sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) doomed.push(k);
      }
      doomed.forEach(function (k) { global.sessionStorage.removeItem(k); });
    } catch (e) { /* noop */ }
  }

  function clearAll() {
    memory.clear();
    inflight.clear();
    clearStorage();
  }

  /**
   * Кэш + дедупликация одновременных запросов.
   * Если пользователь быстро кликнет трижды — уйдёт один запрос.
   */
  function wrap(key, producer, ttlMs) {
    var cached = get(key);
    if (cached !== null && cached !== undefined) {
      return Promise.resolve(cached);
    }

    var pending = inflight.get(key);
    if (pending) return pending;

    var p = Promise.resolve()
      .then(producer)
      .then(function (value) {
        if (value !== null && value !== undefined) set(key, value, ttlMs);
        inflight.delete(key);
        return value;
      })
      .catch(function (err) {
        inflight.delete(key);
        throw err;
      });

    inflight.set(key, p);
    return p;
  }

  global.MusicCache = {
    TTL: TTL,
    get: get,
    set: set,
    wrap: wrap,
    clearAll: clearAll,
    stats: function () {
      return { memory: memory.size, inflight: inflight.size };
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
