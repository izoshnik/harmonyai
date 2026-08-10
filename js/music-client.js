/* ============================================================================
   HarmonyAI — клиент музыкального API.

   Единственное место, которое ходит в /api/music.
   Использует существующий buildEndpointCandidates() из index.html,
   чтобы работать и локально, и на проде, и с зеркала.
   ========================================================================== */

(function (global) {
  'use strict';

  var TIMEOUT_MS = 12000;

  function endpoints() {
    if (typeof global.buildEndpointCandidates === 'function') {
      try {
        var list = global.buildEndpointCandidates('/api/music');
        if (list && list.length) return list;
      } catch (e) { /* падаем на запасной вариант */ }
    }
    return ['/api/music'];
  }

  function currentUserId() {
    /* В HarmonyAI текущий пользователь живёт в переменной curUser, объявленной
       внутри инлайн-скрипта index.html. Из внешнего файла она не видна,
       поэтому index.html кладёт id в window.__hmUserId перед каждым запросом.
       Остальные варианты — запас на случай другого окружения. */
    try {
      if (global.__hmUserId) return global.__hmUserId;
      if (global.curUser && global.curUser.id) return global.curUser.id;
      if (global.currentUser && global.currentUser.id) return global.currentUser.id;
      if (global.userProfile && global.userProfile.id) return global.userProfile.id;
    } catch (e) { /* noop */ }
    return null;
  }

  /** Один вызов API с перебором адресов и таймаутом. */
  async function call(action, payload, options) {
    var opts = options || {};
    var body = Object.assign({ action: action, userId: currentUserId() }, payload || {});
    var urls = endpoints();
    var lastError = null;

    for (var i = 0; i < urls.length; i++) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, opts.timeout || TIMEOUT_MS);

      try {
        var res = await fetch(urls[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
          keepalive: Boolean(opts.keepalive)
        });
        clearTimeout(timer);

        var data = await res.json().catch(function () { return {}; });

        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || ('HTTP ' + res.status));
          err.status = res.status;
          err.type = data.type || null;
          err.code = data.code || null;
          // 4xx — ответ сервера по существу, перебирать адреса бессмысленно.
          if (res.status >= 400 && res.status < 500) throw err;
          lastError = err;
          continue;
        }

        return data;
      } catch (e) {
        clearTimeout(timer);
        if (e && (e.status >= 400 && e.status < 500)) throw e;
        lastError = e;
      }
    }

    throw lastError || new Error('Музыкальный сервис недоступен');
  }

  var C = global.MusicCache;

  /* --------------------------------------------------------------- публичное */

  /**
   * Главный вызов: фраза → треки + готовая ссылка на аудио.
   * Один запрос на весь сценарий «включи X».
   */
  function resolve(kind, query) {
    var key = 'resolve:' + kind + ':' + String(query).toLowerCase();
    return C.wrap(key, function () {
      return call('resolve', { kind: kind, query: query });
    }, C.TTL.SEARCH).then(function (data) {
      // Ссылку из кэша resolve переиспользовать нельзя — она протухает
      // быстрее самого кэша. Складываем её отдельно с коротким TTL.
      if (data && data.playback && data.bestMatch) {
        C.set('play:' + data.bestMatch.trackId, data.playback, C.TTL.PLAYBACK);
      }
      return data;
    });
  }

  function search(query, limit) {
    var key = 'search:' + String(query).toLowerCase() + ':' + (limit || 8);
    return C.wrap(key, function () {
      return call('search', { query: query, limit: limit || 8 });
    }, C.TTL.SEARCH);
  }

  function suggest(part) {
    var key = 'suggest:' + String(part).toLowerCase();
    return C.wrap(key, function () {
      return call('suggest', { part: part });
    }, C.TTL.SUGGEST);
  }

  /**
   * Ссылка на аудио. Сначала память — там она часто уже есть после resolve.
   * Тогда воспроизведение начинается без единого запроса в сеть.
   */
  function playback(trackId, nextTrackId) {
    var key = 'play:' + trackId;
    var cached = C.get(key);
    if (cached) {
      // Заодно тихо греем следующий.
      if (nextTrackId && !C.get('play:' + nextTrackId)) prefetch([nextTrackId]);
      return Promise.resolve(cached);
    }
    return C.wrap(key, function () {
      return call('play', { trackId: trackId, nextTrackId: nextTrackId || null });
    }, C.TTL.PLAYBACK);
  }

  /** Фоновый прогрев — ответ не ждём и ошибки игнорируем. */
  function prefetch(trackIds) {
    if (!trackIds || !trackIds.length) return;
    var need = trackIds.filter(function (id) { return id && !C.get('play:' + id); });
    if (!need.length) return;
    call('prefetch', { trackIds: need.slice(0, 3) }).catch(function () { /* noop */ });
  }

  function collection(kind, params) {
    var key = 'coll:' + kind + ':' + JSON.stringify(params);
    return C.wrap(key, function () {
      return call(kind, params);
    }, C.TTL.COLLECTION);
  }

  /* ------------------------------------------------------------ авторизация */

  function status() { return call('status', {}); }
  function authStart() { return call('auth_start', {}); }
  function authPoll(deviceCode) { return call('auth_poll', { deviceCode: deviceCode }); }
  function authToken(token) { return call('auth_token', { token: token }); }
  function authDisconnect() { return call('auth_disconnect', {}); }

  function like(trackId, liked) {
    return call('like', { trackId: trackId, like: liked !== false });
  }

  /* Идентификаторы избранного — чтобы сердечко в плеере совпадало с
     приложением Яндекс.Музыки. Ответ маленький, но ходить за ним на каждый
     трек незачем: держим его в памяти вкладки одну минуту. */
  var likedCache = { at: 0, promise: null };
  function likedIds(force) {
    var now = Date.now();
    if (!force && likedCache.promise && now - likedCache.at < 60000) return likedCache.promise;
    likedCache.at = now;
    likedCache.promise = call('liked_ids', {}).then(function (d) {
      return (d && Array.isArray(d.ids)) ? d.ids : [];
    }).catch(function () { return []; });
    return likedCache.promise;
  }
  function forgetLiked() { likedCache.at = 0; likedCache.promise = null; }

  global.MusicClient = {
    call: call,
    resolve: resolve,
    search: search,
    suggest: suggest,
    playback: playback,
    prefetch: prefetch,
    collection: collection,
    status: status,
    authStart: authStart,
    authPoll: authPoll,
    authToken: authToken,
    authDisconnect: authDisconnect,
    like: like,
    likedIds: likedIds,
    forgetLiked: forgetLiked
  };

})(typeof window !== 'undefined' ? window : globalThis);
