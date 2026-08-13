/* ============================================================================
   HarmonyAI — «Плейлисты».

   Два экрана внутри окна настроек:
     • список плейлистов        — renderList(el)
     • содержимое плейлиста    — renderDetail(el, id)

   Виды плейлистов:
     liked  — «Мне нравится»: живой список лайков из Яндекс.Музыки;
     found  — «Найдено в HarmonyAi»: треки, которые встречались в чатах;
     свои   — созданные пользователем вручную.

   Где что лежит: собственные плейлисты и список найденного — в localStorage
   (мгновенный старт) и дублём в профиле (чтобы переезжали между
   устройствами). Модуль намеренно не знает про Supabase: сохранение
   в профиль делает index.html через глобальный saveSetting().

   Лайки и очередь — не локальные: всё уходит в MusicPlayer/MusicClient,
   поэтому сердечки здесь и в плеере всегда показывают одно и то же.
   ========================================================================== */

(function (global) {
  'use strict';

  var STORE_KEY = 'hm_music_playlists_v1';
  var FOUND_MAX = 300;      // сколько найденных треков держим локально
  var SYNC_MAX = 120;       // сколько из них уезжает в профиль
  var SYNC_DEBOUNCE = 1500;
  var LIKED_LIMIT = 300;

  /* --------------------------------------------------------------- утилиты */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var r = s % 60;
    return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r;
  }

  function plural(n, forms) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }
  function tracksWord(n) { return n + ' ' + plural(n, ['трек', 'трека', 'треков']); }

  function newId() {
    return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** В хранилище кладём только то, что нужно для показа и запуска. */
  function slim(t) {
    if (!t || !t.trackId) return null;
    return {
      trackId: String(t.trackId),
      title: String(t.title || ''),
      artist: String(t.artist || ''),
      cover: t.cover || '',
      duration: Number(t.duration) || 0,
      genre: t.genre || '',
      albumId: t.albumId || null,
      playable: t.playable !== false
    };
  }

  function notify(msg) {
    if (typeof global.showToast === 'function') { global.showToast(msg); return; }
    var n = document.getElementById('plToast');
    if (!n) {
      n = document.createElement('div');
      n.id = 'plToast';
      n.className = 'pl-toast';
      document.body.appendChild(n);
    }
    n.textContent = msg;
    n.classList.add('is-on');
    clearTimeout(n._t);
    n._t = setTimeout(function () { n.classList.remove('is-on'); }, 2600);
  }

  function player() { return global.MusicPlayer || null; }
  function client() { return global.MusicClient || null; }

  /* ------------------------------------------------------------- хранилище */

  function blank() { return { found: [], custom: [] }; }

  var store = blank();
  var loaded = false;
  var syncTimer = null;

  function normalizeStore(raw) {
    var out = blank();
    if (!raw || typeof raw !== 'object') return out;

    out.found = (Array.isArray(raw.found) ? raw.found : [])
      .map(slim).filter(Boolean).slice(0, FOUND_MAX);

    out.custom = (Array.isArray(raw.custom) ? raw.custom : []).map(function (p) {
      if (!p || typeof p !== 'object') return null;
      return {
        id: String(p.id || newId()),
        title: String(p.title || 'Без названия'),
        createdAt: Number(p.createdAt) || Date.now(),
        tracks: (Array.isArray(p.tracks) ? p.tracks : []).map(slim).filter(Boolean)
      };
    }).filter(Boolean);

    return out;
  }

  function load() {
    if (loaded) return store;
    loaded = true;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) store = normalizeStore(JSON.parse(raw));
    } catch (e) { store = blank(); }
    return store;
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* переполнено */ }
    // В профиль — реже и короче: настройки не место для сотен треков.
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      if (typeof global.saveSetting !== 'function') return;
      try {
        var p = global.saveSetting('musicPlaylists', {
          found: store.found.slice(0, SYNC_MAX),
          custom: store.custom.map(function (pl) {
            return { id: pl.id, title: pl.title, createdAt: pl.createdAt, tracks: pl.tracks.slice(0, SYNC_MAX) };
          })
        });
        if (p && typeof p.catch === 'function') p.catch(function () { /* оффлайн — осталось локально */ });
      } catch (e) { /* профиль недоступен */ }
    }, SYNC_DEBOUNCE);
  }

  /**
   * Подхватить сохранённое в профиле при входе.
   * Локальное и облачное сливаем, а не затираем: на другом устройстве
   * могли найти своё, и терять это нельзя.
   */
  function hydrate(remote) {
    load();
    var r = normalizeStore(remote);
    if (!r.found.length && !r.custom.length) return;

    var seen = Object.create(null);
    var merged = [];
    store.found.concat(r.found).forEach(function (t) {
      if (seen[t.trackId]) return;
      seen[t.trackId] = true;
      merged.push(t);
    });
    store.found = merged.slice(0, FOUND_MAX);

    var byId = Object.create(null);
    store.custom.forEach(function (p) { byId[p.id] = p; });
    r.custom.forEach(function (p) {
      if (!byId[p.id]) { store.custom.push(p); byId[p.id] = p; return; }
      var local = byId[p.id];
      var have = Object.create(null);
      local.tracks.forEach(function (t) { have[t.trackId] = true; });
      p.tracks.forEach(function (t) { if (!have[t.trackId]) local.tracks.push(t); });
    });

    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* неважно */ }
    refreshOpen();
  }

  /* ------------------------------------------- «Найдено в HarmonyAi» */

  /**
   * Запомнить треки, которые показались в чате.
   * Вызывается и на свежем поиске, и при отрисовке старой переписки,
   * поэтому повторы молча отбрасываем и порядок не ломаем.
   */
  function remember(tracks) {
    load();
    var list = (Array.isArray(tracks) ? tracks : [tracks]).map(slim).filter(Boolean);
    if (!list.length) return 0;

    var have = Object.create(null);
    store.found.forEach(function (t) { have[t.trackId] = true; });

    var added = 0;
    list.forEach(function (t) {
      if (have[t.trackId]) return;
      have[t.trackId] = true;
      store.found.unshift(t);
      added++;
    });
    if (!added) return 0;

    if (store.found.length > FOUND_MAX) store.found.length = FOUND_MAX;
    persist();
    refreshOpen();
    return added;
  }

  /* ------------------------------------------------- свои плейлисты */

  function createPlaylist(title) {
    load();
    var name = String(title || '').trim().slice(0, 60);
    if (!name) return null;
    var pl = { id: newId(), title: name, createdAt: Date.now(), tracks: [] };
    store.custom.push(pl);
    persist();
    return pl;
  }

  function removePlaylist(id) {
    load();
    var before = store.custom.length;
    store.custom = store.custom.filter(function (p) { return p.id !== id; });
    if (store.custom.length === before) return false;
    persist();
    return true;
  }

  function renamePlaylist(id, title) {
    load();
    var name = String(title || '').trim().slice(0, 60);
    var pl = store.custom.filter(function (p) { return p.id === id; })[0];
    if (!pl || !name) return false;
    pl.title = name;
    persist();
    return true;
  }

  function addToPlaylist(id, track) {
    load();
    var t = slim(track);
    var pl = store.custom.filter(function (p) { return p.id === id; })[0];
    if (!pl || !t) return false;
    if (pl.tracks.some(function (x) { return x.trackId === t.trackId; })) return false;
    pl.tracks.push(t);
    persist();
    return true;
  }

  function removeFromPlaylist(id, trackId) {
    load();
    var key = String(trackId);
    if (id === 'found') {
      var n = store.found.length;
      store.found = store.found.filter(function (t) { return t.trackId !== key; });
      if (store.found.length === n) return false;
      persist();
      return true;
    }
    var pl = store.custom.filter(function (p) { return p.id === id; })[0];
    if (!pl) return false;
    var m = pl.tracks.length;
    pl.tracks = pl.tracks.filter(function (t) { return t.trackId !== key; });
    if (pl.tracks.length === m) return false;
    persist();
    return true;
  }

  /* ------------------------------------------------------------- жанры */

  var GENRE_LABEL = {
    pop: 'Поп', ruspop: 'Русский поп', foreignpop: 'Зарубежный поп', estrada: 'Эстрада',
    rock: 'Рок', rusrock: 'Русский рок', foreignrock: 'Зарубежный рок',
    alternative: 'Альтернатива', indie: 'Инди', 'local-indie': 'Инди', punk: 'Панк',
    metal: 'Метал', hardrock: 'Хард-рок', prog: 'Прогрессив',
    rap: 'Рэп', rusrap: 'Русский рэп', foreignrap: 'Зарубежный рэп', hiphop: 'Хип-хоп',
    electronics: 'Электроника', dance: 'Танцевальная', house: 'House', techno: 'Techno',
    dnb: 'Drum & Bass', dubstep: 'Dubstep', trance: 'Trance', ambient: 'Эмбиент',
    jazz: 'Джаз', blues: 'Блюз', soul: 'Соул', rnb: 'R&B', funk: 'Фанк',
    classical: 'Классика', modernclassic: 'Современная классика', opera: 'Опера',
    folk: 'Фолк', rusfolk: 'Русский фолк', world: 'Мировая', country: 'Кантри',
    reggae: 'Регги', ska: 'Ска', disco: 'Диско', lounge: 'Лаунж', relax: 'Спокойное',
    soundtrack: 'Саундтреки', films: 'Из фильмов', videogame: 'Из игр', anime: 'Аниме',
    shanson: 'Шансон', bard: 'Барды', children: 'Детское', christmas: 'Новогоднее',
    industrial: 'Индастриал', experimental: 'Эксперимент', pop_electronic: 'Электропоп'
  };

  function genreLabel(code) {
    var k = String(code || '').toLowerCase();
    if (!k) return '';
    if (GENRE_LABEL[k]) return GENRE_LABEL[k];
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  /** Чипы строим по фактическим жанрам треков, а не по выдуманному списку. */
  function genresOf(tracks) {
    var count = Object.create(null);
    tracks.forEach(function (t) {
      var g = String(t.genre || '').toLowerCase();
      if (!g) return;
      count[g] = (count[g] || 0) + 1;
    });
    return Object.keys(count)
      .sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); })
      .map(function (g) { return { code: g, label: genreLabel(g), n: count[g] }; });
  }

  /* --------------------------------------------------- состояние экрана */

  var view = null;   // { el, mode:'list'|'detail', id, genre, tracks, loading, error }

  function refreshOpen() {
    if (!view || !view.el || !document.body.contains(view.el)) return;
    if (view.mode === 'list') renderList(view.el);
    else if (view.mode === 'detail') paintDetail();
  }

  /* Плеер сообщает о любом изменении — перерисовываем только строки,
     чтобы не сбивать прокрутку и не мигать обложкой. */
  document.addEventListener('music:state', function () {
    if (view && view.mode === 'detail') paintRows();
  });

  /* --------------------------------------------------------- экран списка */

  var ICON_CHEV = '<svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M1 1L7 7L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_BACK = '<svg width="10" height="16" viewBox="0 0 10 16" fill="none"><path d="M9 1L1 8L9 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 20.3c-1.3-.85-8-5.4-8-10.05A4.35 4.35 0 0 1 12 7.2a4.35 4.35 0 0 1 8 3.05c0 4.65-6.7 9.2-8 10.05Z"/></svg>';
  var ICON_HEART_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.3c-1.3-.85-8-5.4-8-10.05A4.35 4.35 0 0 1 12 7.2a4.35 4.35 0 0 1 8 3.05c0 4.65-6.7 9.2-8 10.05Z"/></svg>';
  var ICON_DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle fill="currentColor" cx="5.5" cy="12" r="1.8"/><circle fill="currentColor" cx="12" cy="12" r="1.8"/><circle fill="currentColor" cx="18.5" cy="12" r="1.8"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72c0 .83.92 1.33 1.62.88l10.5-6.86a1.05 1.05 0 0 0 0-1.76L9.62 4.26A1.05 1.05 0 0 0 8 5.14Z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="6" y="4.5" width="4" height="15" rx="1.6"/><rect fill="currentColor" x="14" y="4.5" width="4" height="15" rx="1.6"/></svg>';

  function coverHtml(track, cls) {
    if (track && track.cover) {
      return '<img class="' + cls + '" src="' + esc(track.cover) + '" alt="" loading="lazy" />';
    }
    return '<div class="' + cls + ' is-empty"></div>';
  }

  function renderList(el) {
    if (!el) return;
    load();
    view = { el: el, mode: 'list' };

    var rows = [];

    rows.push(
      '<button type="button" class="pl-row" data-open="liked">' +
      '  <span class="pl-row__cover pl-cover--liked">' + ICON_HEART_ON + '</span>' +
      '  <span class="pl-row__meta">' +
      '    <span class="pl-row__title">Мне нравится</span>' +
      '    <span class="pl-row__sub" id="plLikedSub">Лайки из Яндекс Музыки</span>' +
      '  </span>' +
      '  <span class="pl-row__chev">' + ICON_CHEV + '</span>' +
      '</button>'
    );

    rows.push(
      '<button type="button" class="pl-row" data-open="found">' +
      '  <span class="pl-row__cover pl-cover--found">H</span>' +
      '  <span class="pl-row__meta">' +
      '    <span class="pl-row__title">Найдено в HarmonyAi</span>' +
      '    <span class="pl-row__sub">' +
      (store.found.length ? esc(tracksWord(store.found.length)) : 'Пока пусто') +
      '    </span>' +
      '  </span>' +
      '  <span class="pl-row__chev">' + ICON_CHEV + '</span>' +
      '</button>'
    );

    store.custom.forEach(function (pl) {
      var first = pl.tracks[0] || null;
      rows.push(
        '<button type="button" class="pl-row" data-open="' + esc(pl.id) + '">' +
        coverHtml(first, 'pl-row__cover') +
        '  <span class="pl-row__meta">' +
        '    <span class="pl-row__title">' + esc(pl.title) + '</span>' +
        '    <span class="pl-row__sub">' +
        (pl.tracks.length ? esc(tracksWord(pl.tracks.length)) : 'Пока пусто') +
        '    </span>' +
        '  </span>' +
        '  <span class="pl-row__chev">' + ICON_CHEV + '</span>' +
        '</button>'
      );
    });

    el.innerHTML =
      '<div class="sth">' +
      '  <button type="button" class="sth-back" id="plBack" aria-label="Назад">' + ICON_BACK + '</button>' +
      '  <div class="sth-title">Плейлисты</div>' +
      '  <button type="button" class="pl-head-btn" id="plCreate" title="Создать плейлист" aria-label="Создать плейлист">' + ICON_PLUS + '</button>' +
      '</div>' +
      '<div class="pl-rows">' + rows.join('') + '</div>' +
      '<div class="pl-note">«Найдено в HarmonyAi» пополняется автоматически: сюда попадают треки, которые нашлись в чате.</div>';

    el.querySelector('#plBack').addEventListener('click', function () {
      if (typeof global.renderSettingsMain === 'function') global.renderSettingsMain();
    });

    el.querySelector('#plCreate').addEventListener('click', function () {
      var name = prompt('Название плейлиста', 'Мой плейлист');
      if (name === null) return;
      var pl = createPlaylist(name);
      if (!pl) { notify('Нужно название плейлиста'); return; }
      renderList(el);
    });

    Array.prototype.forEach.call(el.querySelectorAll('.pl-row'), function (row) {
      row.addEventListener('click', function () {
        renderDetail(el, row.getAttribute('data-open'));
      });
    });

    // Живой счётчик лайков — без блокировки отрисовки.
    var c = client();
    if (c && typeof c.likedIds === 'function') {
      c.likedIds().then(function (ids) {
        var sub = el.querySelector('#plLikedSub');
        if (!sub || !document.body.contains(sub)) return;
        sub.textContent = (ids && ids.length)
          ? tracksWord(ids.length)
          : 'Подключите Яндекс Музыку';
      }).catch(function () { /* статус неизвестен — подпись остаётся общей */ });
    }
  }

  /* ------------------------------------------------------- экран плейлиста */

  function playlistMeta(id) {
    load();
    if (id === 'liked') return { id: 'liked', title: 'Мне нравится', kind: 'liked', removable: false };
    if (id === 'found') return { id: 'found', title: 'Найдено в HarmonyAi', kind: 'found', removable: true };
    var pl = store.custom.filter(function (p) { return p.id === id; })[0];
    if (!pl) return null;
    return { id: pl.id, title: pl.title, kind: 'custom', removable: true };
  }

  function renderDetail(el, id) {
    if (!el) return;
    var meta = playlistMeta(id);
    if (!meta) { renderList(el); return; }

    view = { el: el, mode: 'detail', id: id, meta: meta, genre: 'all', tracks: [], loading: false, error: '' };

    if (meta.kind === 'liked') {
      view.loading = true;
      paintDetail();
      var c = client();
      if (!c || typeof c.likedTracks !== 'function') {
        view.loading = false;
        view.error = 'Модуль музыки не загрузился — обновите страницу.';
        paintDetail();
        return;
      }
      c.likedTracks(LIKED_LIMIT).then(function (d) {
        if (!view || view.id !== id) return;
        view.loading = false;
        view.tracks = (d && Array.isArray(d.items) ? d.items : []).map(slim).filter(Boolean);
        if (!view.tracks.length) {
          view.error = (d && d.personal === false)
            ? 'Подключите свой аккаунт Яндекс Музыки в Подключениях — тогда здесь появятся ваши лайки.'
            : 'В «Мне нравится» пока пусто.';
        }
        paintDetail();
      }).catch(function (e) {
        if (!view || view.id !== id) return;
        view.loading = false;
        view.error = (e && e.type === 'music_auth_required')
          ? 'Подключите Яндекс Музыку в Подключениях.'
          : 'Не удалось загрузить лайки. Попробуйте ещё раз.';
        paintDetail();
      });
      return;
    }

    view.tracks = (meta.kind === 'found')
      ? store.found.slice()
      : (store.custom.filter(function (p) { return p.id === id; })[0] || { tracks: [] }).tracks.slice();

    paintDetail();
    enrichGenres();
  }

  /**
   * У треков из старых чатов жанра нет — добираем его одним запросом,
   * иначе фильтр по жанрам будет почти пустым.
   */
  function enrichGenres() {
    var c = client();
    if (!c || typeof c.tracksByIds !== 'function' || !view || view.mode !== 'detail') return;

    var need = view.tracks.filter(function (t) { return !t.genre; }).map(function (t) { return t.trackId; });
    if (!need.length) return;

    var id = view.id;
    c.tracksByIds(need.slice(0, 200)).then(function (items) {
      if (!view || view.id !== id || !items || !items.length) return;
      var byId = Object.create(null);
      items.forEach(function (t) { if (t && t.trackId) byId[String(t.trackId)] = t; });

      var touched = false;
      view.tracks.forEach(function (t) {
        var fresh = byId[t.trackId];
        if (fresh && fresh.genre && !t.genre) { t.genre = fresh.genre; touched = true; }
      });
      if (!touched) return;

      // Жанры запоминаем, чтобы в следующий раз фильтр работал сразу.
      var map = Object.create(null);
      view.tracks.forEach(function (t) { if (t.genre) map[t.trackId] = t.genre; });
      store.found.forEach(function (t) { if (!t.genre && map[t.trackId]) t.genre = map[t.trackId]; });
      store.custom.forEach(function (p) {
        p.tracks.forEach(function (t) { if (!t.genre && map[t.trackId]) t.genre = map[t.trackId]; });
      });
      persist();
      paintDetail();
    }).catch(function () { /* жанры — украшение, без них список работает */ });
  }

  function visibleTracks() {
    if (!view || !view.tracks) return [];
    if (!view.genre || view.genre === 'all') return view.tracks;
    return view.tracks.filter(function (t) {
      return String(t.genre || '').toLowerCase() === view.genre;
    });
  }

  function paintDetail() {
    if (!view || view.mode !== 'detail' || !view.el) return;
    var el = view.el;
    var meta = view.meta;
    var list = visibleTracks();
    var hero = view.tracks[0] || null;

    var chips = '';
    var gs = genresOf(view.tracks);
    if (gs.length > 1) {
      chips = '<div class="pl-chips" id="plChips">' +
        '<button type="button" class="pl-chip' + (view.genre === 'all' ? ' is-on' : '') + '" data-g="all">Всё</button>' +
        gs.map(function (g) {
          return '<button type="button" class="pl-chip' + (view.genre === g.code ? ' is-on' : '') +
            '" data-g="' + esc(g.code) + '">' + esc(g.label) + '</button>';
        }).join('') +
        '</div>';
    }

    var body;
    if (view.loading) {
      body = '<div class="pl-empty">Загружаю треки…</div>';
    } else if (view.error) {
      body = '<div class="pl-empty">' + esc(view.error) + '</div>';
    } else if (!view.tracks.length) {
      body = '<div class="pl-empty">' + (meta.kind === 'custom'
        ? 'Плейлист пуст. Добавьте треки через меню «⋯» у любого трека.'
        : 'Пока пусто.') + '</div>';
    } else if (!list.length) {
      body = '<div class="pl-empty">В этом жанре треков нет.</div>';
    } else {
      body = '<div class="pl-tracks" id="plTracks"></div>';
    }

    el.innerHTML =
      '<div class="sth">' +
      '  <button type="button" class="sth-back" id="plBack" aria-label="Назад">' + ICON_BACK + '</button>' +
      '  <div class="sth-title">' + esc(meta.title) + '</div>' +
      (meta.kind === 'custom'
        ? '  <button type="button" class="pl-head-btn" id="plMore" title="Ещё" aria-label="Ещё">' + ICON_DOTS + '</button>'
        : '') +
      '</div>' +
      '<div class="pl-hero">' +
      (hero && hero.cover ? '<div class="pl-hero__bg" style="background-image:url(' + esc(hero.cover) + ')"></div>' : '') +
      '  <div class="pl-hero__veil"></div>' +
      '  <div class="pl-hero__inner">' +
      coverHtml(hero, 'pl-hero__cover') +
      '    <div class="pl-hero__meta">' +
      '      <div class="pl-hero__title">' + esc(meta.title) + '</div>' +
      '      <div class="pl-hero__sub">' + esc(view.loading ? 'Загрузка…' : tracksWord(view.tracks.length)) + '</div>' +
      '    </div>' +
      '    <button type="button" class="pl-hero__play" id="plPlayAll" aria-label="Слушать">' + ICON_PLAY + '</button>' +
      '  </div>' +
      '</div>' +
      chips +
      body;

    el.querySelector('#plBack').addEventListener('click', function () { renderList(el); });

    var more = el.querySelector('#plMore');
    if (more) more.addEventListener('click', function (ev) { openPlaylistMenu(ev, meta); });

    var chipsBox = el.querySelector('#plChips');
    if (chipsBox) {
      Array.prototype.forEach.call(chipsBox.querySelectorAll('.pl-chip'), function (b) {
        b.addEventListener('click', function () {
          view.genre = b.getAttribute('data-g');
          paintDetail();
        });
      });
    }

    var playAll = el.querySelector('#plPlayAll');
    if (playAll) {
      playAll.addEventListener('click', function () {
        var l = visibleTracks();
        if (!l.length) { notify('Нечего включать'); return; }
        var p = player();
        if (!p) { notify('Плеер не загрузился'); return; }
        p.setQueue(l.slice(), 0, null, { title: meta.title, subtitle: tracksWord(l.length) });
      });
    }

    paintRows();

    var p = player();
    if (p && typeof p.syncLiked === 'function') p.syncLiked();
  }

  /** Отдельно от paintDetail: перерисовка по событиям плеера не должна мигать. */
  function paintRows() {
    if (!view || view.mode !== 'detail' || !view.el) return;
    var box = view.el.querySelector('#plTracks');
    if (!box) return;

    var p = player();
    var cur = p && typeof p.currentTrack === 'function' ? p.currentTrack() : null;
    var curId = cur ? String(cur.trackId) : '';
    var playing = Boolean(p && typeof p.isPlaying === 'function' && p.isPlaying());
    var list = visibleTracks();

    box.innerHTML = list.map(function (t, i) {
      var isCur = t.trackId === curId;
      var liked = Boolean(p && typeof p.isTrackLiked === 'function' && p.isTrackLiked(t.trackId));
      return '<div class="pl-track' + (isCur ? ' is-current' : '') + (t.playable === false ? ' is-off' : '') +
        '" data-i="' + i + '" data-id="' + esc(t.trackId) + '">' +
        '<button type="button" class="pl-track__cover" aria-label="' + (isCur && playing ? 'Пауза' : 'Воспроизвести') + '">' +
        (t.cover ? '<img src="' + esc(t.cover) + '" alt="" loading="lazy" />' : '') +
        '<span class="pl-track__state">' + (isCur && playing ? ICON_PAUSE : ICON_PLAY) + '</span>' +
        '</button>' +
        '<div class="pl-track__meta">' +
        '<div class="pl-track__title">' + esc(t.title) + '</div>' +
        '<div class="pl-track__artist">' + esc(t.artist) + (t.duration ? ' · ' + fmtDur(t.duration) : '') + '</div>' +
        '</div>' +
        '<button type="button" class="pl-track__like' + (liked ? ' is-on' : '') +
        '" aria-label="' + (liked ? 'Убрать лайк' : 'Поставить лайк') + '" aria-pressed="' + (liked ? 'true' : 'false') + '">' +
        (liked ? ICON_HEART_ON : ICON_HEART) + '</button>' +
        '<button type="button" class="pl-track__dots" aria-label="Меню трека">' + ICON_DOTS + '</button>' +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.pl-track'), function (row) {
      var i = Number(row.getAttribute('data-i'));
      var track = list[i];
      if (!track) return;

      row.querySelector('.pl-track__cover').addEventListener('click', function (ev) {
        ev.stopPropagation();
        togglePlay(track, list, i);
      });
      row.querySelector('.pl-track__meta').addEventListener('click', function () {
        togglePlay(track, list, i);
      });
      row.querySelector('.pl-track__like').addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleLike(track);
      });
      row.querySelector('.pl-track__dots').addEventListener('click', function (ev) {
        ev.stopPropagation();
        openTrackMenu(ev, track);
      });
    });
  }

  /* ------------------------------------------------------ действия с треком */

  function togglePlay(track, list, index) {
    var p = player();
    if (!p) { notify('Плеер не загрузился'); return; }
    if (track.playable === false) { notify('Этот трек недоступен для прослушивания'); return; }

    var cur = typeof p.currentTrack === 'function' ? p.currentTrack() : null;
    if (cur && String(cur.trackId) === String(track.trackId)) { p.toggle(); return; }

    var meta = view && view.meta ? view.meta : null;
    p.setQueue(list.slice(), index, null, meta ? { title: meta.title, subtitle: tracksWord(list.length) } : null);
  }

  function toggleLike(track) {
    var p = player();
    if (!p || typeof p.likeTrack !== 'function') { notify('Плеер не загрузился'); return; }
    p.likeTrack(track);
    paintRows();
  }

  /* ------------------------------------------------------------ контекстные меню */

  var menuEl = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
  }
  function onDocClick(ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }
  function onEsc(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); } }

  function openMenu(anchorEv, rows) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'pl-menu';
    menuEl.innerHTML = rows.map(function (r, i) {
      return '<button type="button" class="pl-menu__row' + (r.danger ? ' is-danger' : '') +
        '" data-i="' + i + '">' + esc(r.label) + '</button>';
    }).join('');
    document.body.appendChild(menuEl);

    var btn = anchorEv.currentTarget || anchorEv.target;
    var r = btn.getBoundingClientRect();
    var w = menuEl.offsetWidth || 220;
    var h = menuEl.offsetHeight || 120;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var top = (r.bottom + h + 8 > window.innerHeight) ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';

    Array.prototype.forEach.call(menuEl.querySelectorAll('.pl-menu__row'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var item = rows[Number(b.getAttribute('data-i'))];
        closeMenu();
        if (item && typeof item.run === 'function') item.run();
      });
    });

    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('resize', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
  }

  function openTrackMenu(ev, track) {
    load();
    var p = player();
    var inQueue = Boolean(p && typeof p.isInQueue === 'function' && p.isInQueue(track.trackId));
    var meta = view && view.meta ? view.meta : null;
    var rows = [];

    /* Главное, ради чего меню и просили: очередь. */
    rows.push({
      label: inQueue ? 'Удалить из очереди' : 'Добавить в очередь',
      run: function () {
        if (!p) { notify('Плеер не загрузился'); return; }
        if (inQueue) {
          p.removeFromQueue(track.trackId);
          notify('Убрано из очереди');
        } else {
          p.addToQueue(track);
          notify('Добавлено в очередь');
        }
        paintRows();
      }
    });

    rows.push({
      label: (p && typeof p.isTrackLiked === 'function' && p.isTrackLiked(track.trackId))
        ? 'Убрать из «Мне нравится»' : 'В «Мне нравится»',
      run: function () { toggleLike(track); }
    });

    if (store.custom.length) {
      rows.push({
        label: 'Добавить в плейлист…',
        run: function () { openAddToPlaylistMenu(ev, track); }
      });
    } else {
      rows.push({
        label: 'Создать плейлист с этим треком',
        run: function () {
          var name = prompt('Название плейлиста', 'Мой плейлист');
          if (name === null) return;
          var pl = createPlaylist(name);
          if (!pl) { notify('Нужно название плейлиста'); return; }
          addToPlaylist(pl.id, track);
          notify('Добавлено в «' + pl.title + '»');
        }
      });
    }

    if (meta && meta.removable) {
      rows.push({
        label: meta.kind === 'found' ? 'Убрать из найденного' : 'Удалить из плейлиста',
        danger: true,
        run: function () {
          if (!removeFromPlaylist(meta.id, track.trackId)) return;
          view.tracks = view.tracks.filter(function (t) { return t.trackId !== track.trackId; });
          paintDetail();
        }
      });
    }

    openMenu(ev, rows);
  }

  function openAddToPlaylistMenu(ev, track) {
    load();
    var rows = store.custom.map(function (pl) {
      var has = pl.tracks.some(function (t) { return t.trackId === track.trackId; });
      return {
        label: (has ? '✓ ' : '') + pl.title,
        run: function () {
          if (has) { notify('Уже в «' + pl.title + '»'); return; }
          addToPlaylist(pl.id, track);
          notify('Добавлено в «' + pl.title + '»');
        }
      };
    });
    rows.push({
      label: '+ Новый плейлист',
      run: function () {
        var name = prompt('Название плейлиста', 'Мой плейлист');
        if (name === null) return;
        var pl = createPlaylist(name);
        if (!pl) { notify('Нужно название плейлиста'); return; }
        addToPlaylist(pl.id, track);
        notify('Добавлено в «' + pl.title + '»');
      }
    });
    openMenu(ev, rows);
  }

  function openPlaylistMenu(ev, meta) {
    openMenu(ev, [
      {
        label: 'Переименовать',
        run: function () {
          var name = prompt('Новое название', meta.title);
          if (name === null) return;
          if (!renamePlaylist(meta.id, name)) { notify('Нужно название плейлиста'); return; }
          renderDetail(view.el, meta.id);
        }
      },
      {
        label: 'Удалить плейлист',
        danger: true,
        run: function () {
          if (!confirm('Удалить плейлист «' + meta.title + '»?')) return;
          removePlaylist(meta.id);
          renderList(view.el);
        }
      }
    ]);
  }

  /* ------------------------------------------------------------------ экспорт */

  global.MusicPlaylists = {
    renderList: renderList,
    renderDetail: renderDetail,
    remember: remember,
    hydrate: hydrate,
    createPlaylist: createPlaylist,
    removePlaylist: removePlaylist,
    renamePlaylist: renamePlaylist,
    addToPlaylist: addToPlaylist,
    removeFromPlaylist: removeFromPlaylist,
    genresOf: genresOf,
    genreLabel: genreLabel,
    getStore: function () { load(); return store; },
    reset: function () { store = blank(); loaded = true; persist(); }
  };

})(typeof window !== 'undefined' ? window : globalThis);
