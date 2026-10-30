/* ============================================================================
   HarmonyAI — видеоплеер онлайн-кинотеатра (window.HmVideo).

   Один плеер для двух площадок:
     • VK Видео — официальный плеер video_ext.php + его JS API (videoplayer.js):
       play/pause/перемотка/громкость/события. Качество выбирается параметром
       hd (плеер перезагружается и продолжает с того же места).
     • YouTube — родной плеер YouTube (controls=1): качество, субтитры, скорость и
       автодубляж YouTube — в его же шестерёнке; наша полоса для YouTube скрыта.

   Наш интерфейс — полоса прогресса и кнопки ПОД кадром, а не поверх него:
   кадр остаётся плеером площадки, поэтому её реклама и кнопка «Пропустить»
   работают как задумано, а наши кнопки ничего не перекрывают.

   Настройки: Качество (144–1080, 1440/2160 — только Pro), Субтитры,
   Скорость (0.5×–3×), Дубляж (другие озвучки, найденные ИИ). Пункт, который
   площадка не умеет, виден, но приглушён — с пояснением.

   Библиотека «Фильмы и Сериалы» (HmVideo.library): всё, что начали смотреть,
   с местом остановки. Сериалы и серии фильмов собираются в общие плейлисты,
   остальное — в «Фильмы и видео». Лежит в localStorage и дублем в профиле.
   ============================================================================ */
(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var mm = (m < 10 ? '0' : '') + m, rr = (r < 10 ? '0' : '') + r;
    return h ? h + ':' + mm + ':' + rr : mm + ':' + rr;
  }
  function isPro() { try { return typeof global.isProUser === 'function' && global.isProUser(); } catch (e) { return false; } }
  function toast(msg) { try { if (typeof global.showToast === 'function') global.showToast(msg); } catch (e) { /* без тоста */ } }

  /* ----------------------------------------------------------- иконки
     Сетка 24×24, толстая скруглённая линия 2.4 и залитые формы там, где
     контур читается хуже (play, динамик). */
  var S = ' fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  var IC = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.2v13.6c0 1 1.1 1.6 1.9 1.1l10.4-6.8a1.3 1.3 0 0 0 0-2.2L9.4 4.1c-.8-.5-1.9.1-1.9 1.1z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.6" width="4.4" height="14.8" rx="1.7" fill="currentColor"/><rect x="13.6" y="4.6" width="4.4" height="14.8" rx="1.7" fill="currentColor"/></svg>',
    vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.6v4.8c0 .7.5 1.2 1.2 1.2h2.9l4.2 3.5c.8.6 1.9.1 1.9-.9V5.8c0-1-1.1-1.5-1.9-.9L7.6 8.4H4.7c-.7 0-1.2.5-1.2 1.2z" fill="currentColor"/><path d="M16.6 9.2a4.1 4.1 0 0 1 0 5.6M19.4 6.6a8 8 0 0 1 0 10.8"' + S + '/></svg>',
    volLow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.6v4.8c0 .7.5 1.2 1.2 1.2h2.9l4.2 3.5c.8.6 1.9.1 1.9-.9V5.8c0-1-1.1-1.5-1.9-.9L7.6 8.4H4.7c-.7 0-1.2.5-1.2 1.2z" fill="currentColor"/><path d="M16.6 9.2a4.1 4.1 0 0 1 0 5.6"' + S + '/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.6v4.8c0 .7.5 1.2 1.2 1.2h2.9l4.2 3.5c.8.6 1.9.1 1.9-.9V5.8c0-1-1.1-1.5-1.9-.9L7.6 8.4H4.7c-.7 0-1.2.5-1.2 1.2z" fill="currentColor"/><path d="M16.8 9.4l5 5.2M21.8 9.4l-5 5.2"' + S + '/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"' + S.replace('2.4', '2.1') + '/><circle cx="12" cy="12" r="3.1"' + S.replace('2.4', '2.1') + '/></svg>',
    full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 4H20v5.8M20 4l-6.4 6.4M9.8 20H4v-5.8M4 20l6.4-6.4"' + S + '/></svg>',
    fullExit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4l-6.2 6.2M13.8 4.8v5.4h5.4M4 20l6.2-6.2M10.2 19.2v-5.4H4.8"' + S + '/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"' + S.replace('2.4', '2.7') + '/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"' + S + '/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"' + S + '/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2 8.8-9.4"' + S + '/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"' + S + '/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"' + S + '/></svg>',
    film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3"' + S.replace('2.4', '2.1') + '/><path d="M10 9.4v5.2c0 .5.5.8.9.5l4-2.6a.6.6 0 0 0 0-1L10.9 8.9c-.4-.3-.9 0-.9.5z" fill="currentColor"/></svg>'
  };

  var QUALITIES = [2160, 1440, 1080, 720, 480, 360, 240, 144];
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  var VK_HD = { 360: 1, 480: 2, 720: 3, 1080: 4, 1440: 5, 2160: 6 };

  /* ----------------------------------------------------------- загрузчики */
  var scripts = {};
  function loadScript(src) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scripts[src]; reject(new Error('script')); };
      document.head.appendChild(s);
    });
    return scripts[src];
  }
  var ytReady = null;
  function loadYouTube() {
    if (global.YT && global.YT.Player) return Promise.resolve(global.YT);
    if (ytReady) return ytReady;
    ytReady = new Promise(function (resolve, reject) {
      var prev = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') try { prev(); } catch (e) { /* чужой колбэк */ } resolve(global.YT); };
      loadScript('https://www.youtube.com/iframe_api').catch(function (e) { ytReady = null; reject(e); });
      setTimeout(function () { if (!(global.YT && global.YT.Player)) { ytReady = null; reject(new Error('yt timeout')); } }, 15000);
    });
    return ytReady;
  }

  /* ----------------------------------------------------------- адаптеры
     Общий контракт: play, pause, seek(t), setVolume(0..1), setMuted(bool),
     caps() → {qualities:[...], speeds:[...], captions:[...]}, setQuality(q),
     setSpeed(x), setCaptions(code|''), destroy(). События — через ui.* */

  function vkAdapter(item, stage, ui, opts) {
    var iframe = null, api = null, inited = false, quality = opts.quality || 0, alive = true;
    var resumeAt = opts.start || 0, wantPlay = true, fallbackTimer = 0;
    function src() {
      var u = item.embed + (item.embed.indexOf('?') >= 0 ? '&' : '?') + 'js_api=1&autoplay=1';
      if (quality && VK_HD[quality]) u += '&hd=' + VK_HD[quality];
      return u;
    }
    function mount() {
      if (api) try { api.destroy(); } catch (e) { /* уже нет */ }
      api = null; inited = false;
      if (iframe) iframe.remove();
      iframe = document.createElement('iframe');
      iframe.className = 'hv-frame';
      iframe.src = src();
      iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock';
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.title = item.title || 'VK Видео';
      stage.appendChild(iframe);
      clearTimeout(fallbackTimer);
      // Если API плеера не ответил — управление остаётся в самом кадре VK.
      fallbackTimer = setTimeout(function () { if (alive && !inited) ui.limited('Управление — в самом плеере VK'); }, 7000);
      // API плеера подключаем только после загрузки кадра: команда init,
      // отправленная в ещё пустой iframe, теряется, и плеер «молчит».
      var frame = iframe;
      var loaded = new Promise(function (r) { frame.addEventListener('load', function () { r(); }, { once: true }); });
      Promise.all([loadScript('https://vk.com/js/api/videoplayer.js'), loaded]).then(function () {
        if (!alive || frame !== iframe || !global.VK || !global.VK.VideoPlayer) return;
        try { api = global.VK.VideoPlayer(iframe); } catch (e) { ui.limited('Управление — в самом плеере VK'); return; }
        var E = global.VK.VideoPlayer.Events || {};
        api.on(E.INITED || 'inited', function (s) {
          inited = true; ui.limited('');
          ui.duration(s.duration);
          if (resumeAt > 3) { api.seek(resumeAt); resumeAt = 0; }
          if (wantPlay) api.play();
        });
        api.on(E.TIMEUPDATE || 'timeupdate', function (s) { ui.time(s.time, s.duration); });
        api.on(E.STARTED || 'started', function (s) { ui.playing(true); ui.duration(s.duration); });
        api.on(E.RESUMED || 'resumed', function () { ui.playing(true); });
        api.on(E.PAUSED || 'paused', function () { ui.playing(false); });
        api.on(E.ENDED || 'ended', function () { ui.playing(false); ui.ended(); });
        api.on(E.VOLUMECHANGE || 'volumechange', function (s) { ui.volume(s.volume, s.muted); });
        api.on(E.QUALITYCHANGE || 'qualitychange', function (s) { if (s.quality) ui.actual(s.quality); });
        api.on(E.ADSTARTED || 'adStarted', function () { ui.ad(true); });
        api.on(E.ADCOMPLETED || 'adCompleted', function () { ui.ad(false); });
        api.on(E.ERROR || 'error', function () { ui.error('VK не отдаёт это видео на сторонние сайты. Попробуйте другой вариант ниже.'); });
      }).catch(function () { ui.limited('Управление — в самом плеере VK'); });
    }
    mount();
    return {
      kind: 'vk',
      play: function () { wantPlay = true; if (api) api.play(); },
      pause: function () { wantPlay = false; if (api) api.pause(); },
      seek: function (t) { if (api) api.seek(t); },
      setVolume: function (v) { if (api) api.setVolume(clamp(v, 0, 1)); },
      setMuted: function (m) { if (api) { if (m) api.mute(); else api.unmute(); } },
      caps: function () {
        var q = [1080, 720, 480, 360];
        if ((item.height || 0) >= 1440) q.unshift(1440);
        if ((item.height || 0) >= 2160) q.unshift(2160);
        return { qualities: q, auto: true, speeds: [1], captions: [] };
      },
      quality: function () { return quality; },
      setQuality: function (q) {
        resumeAt = api ? api.getCurrentTime() : resumeAt; wantPlay = true; quality = q;
        ui.quality(q); mount();
      },
      setSpeed: function () { /* VK не даёт менять скорость во встроенном плеере */ },
      setCaptions: function () { /* субтитров в API VK нет */ },
      destroy: function () { alive = false; clearTimeout(fallbackTimer); if (api) try { api.destroy(); } catch (e) { /* нет */ } if (iframe) iframe.remove(); }
    };
  }

  function ytAdapter(item, stage, ui, opts) {
    var host = document.createElement('div'); host.className = 'hv-frame';
    stage.appendChild(host);
    var p = null, poll = 0, alive = true, tracks = [], capsCode = '';
    loadYouTube().then(function (YT) {
      if (!alive) return;
      p = new YT.Player(host, {
        videoId: item.id,
        playerVars: {
          autoplay: 1, controls: 1, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 0, fs: 1,
          modestbranding: 1, hl: 'ru', cc_lang_pref: 'ru', start: Math.floor(opts.start || 0),
          origin: location.origin
        },
        events: {
          onReady: function () {
            ui.limited('');
            ui.duration(p.getDuration());
            try { ui.volume(p.getVolume() / 100, p.isMuted()); } catch (e) { /* нет */ }
            p.playVideo();
            clearInterval(poll);
            poll = setInterval(function () {
              if (!p || !p.getCurrentTime) return;
              try { ui.time(p.getCurrentTime(), p.getDuration(), p.getVideoLoadedFraction()); } catch (e) { /* пока нет */ }
            }, 250);
          },
          onStateChange: function (e) {
            if (e.data === 1) ui.playing(true);
            else if (e.data === 2) ui.playing(false);
            else if (e.data === 0) { ui.playing(false); ui.ended(); }
          },
          onPlaybackRateChange: function (e) { ui.speed(e.data); },
          onApiChange: function () {
            try {
              var list = p.getOption('captions', 'tracklist') || [];
              tracks = list.map(function (t) { return { code: t.languageCode, label: t.displayName || t.languageName || t.languageCode }; });
              ui.refreshMenu();
            } catch (e) { /* модуль субтитров ещё не готов */ }
          },
          onError: function (e) {
            ui.error(e.data === 101 || e.data === 150 ? 'Автор запретил показ этого видео на других сайтах. Попробуйте другой вариант ниже.' : 'YouTube не смог открыть это видео.');
          }
        }
      });
    }).catch(function () { ui.error('YouTube недоступен. Попробуйте вариант из VK.'); });
    return {
      kind: 'yt',
      play: function () { if (p && p.playVideo) p.playVideo(); },
      pause: function () { if (p && p.pauseVideo) p.pauseVideo(); },
      seek: function (t) { if (p && p.seekTo) p.seekTo(t, true); },
      setVolume: function (v) { if (p && p.setVolume) { p.setVolume(Math.round(clamp(v, 0, 1) * 100)); if (v > 0) p.unMute(); } },
      setMuted: function (m) { if (p) { if (m) p.mute(); else p.unMute(); } },
      caps: function () {
        var rates = [1];
        try { rates = (p && p.getAvailablePlaybackRates && p.getAvailablePlaybackRates()) || [1]; } catch (e) { /* по умолчанию */ }
        return { qualities: [], auto: true, speeds: rates, captions: tracks };
      },
      quality: function () { return 0; },
      setQuality: function () { /* YouTube выбирает качество сам: API выбора убрано самим YouTube */ },
      setSpeed: function (x) { if (p && p.setPlaybackRate) { p.setPlaybackRate(x); ui.speed(x); } },
      setCaptions: function (code) {
        if (!p) return;
        capsCode = code || '';
        try {
          if (!code) { p.unloadModule('captions'); }
          else { p.loadModule('captions'); p.setOption('captions', 'track', { languageCode: code }); }
        } catch (e) { /* нет модуля */ }
        ui.captions(capsCode);
      },
      destroy: function () { alive = false; clearInterval(poll); try { if (p && p.destroy) p.destroy(); } catch (e) { /* нет */ } host.remove(); }
    };
  }

  /* ----------------------------------------------------------- библиотека */
  var LIB_KEY = 'hm_video_library_v1';
  var lib = null, syncTimer = 0;

  function baseTitle(t) {
    return String(t || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .replace(/s\d{1,2}\s*e\d{1,4}|\d{1,2}\s*[xх]\s*\d{1,3}/gi, ' ')
      .replace(/\d{1,4}\s*(?:-?[йя]\s*)?(?:сезон\S*|серия|эпизод)|(?:сезон\S*|серия|эпизод|episode)\s*№?\s*\d{1,4}/g, ' ')
      .replace(/[^a-zа-я0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function slimItem(it) {
    return {
      source: it.source, id: it.id, title: String(it.title || '').slice(0, 160), image: it.image || '', embed: it.embed || '',
      duration: it.duration || 0, height: it.height || 0, season: it.season || 0, episode: it.episode || 0, voice: it.voice || '',
      pos: it.pos || 0, addedAt: it.addedAt || Date.now()
    };
  }
  function libLoad() {
    if (lib) return lib;
    lib = { groups: [], singles: [] };
    try {
      var raw = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
      if (raw && Array.isArray(raw.groups)) lib.groups = raw.groups;
      if (raw && Array.isArray(raw.singles)) lib.singles = raw.singles;
    } catch (e) { /* пусто */ }
    return lib;
  }
  function libSave() {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { /* переполнено */ }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      if (typeof global.saveSetting !== 'function') return;
      try {
        var slim = { groups: lib.groups.slice(0, 40).map(function (g) { return { key: g.key, title: g.title, kind: g.kind, cover: g.cover, updatedAt: g.updatedAt, items: g.items.slice(0, 80) }; }), singles: lib.singles.slice(0, 100) };
        var r = global.saveSetting('videoLibrary', slim);
        if (r && r.catch) r.catch(function () { /* осталось локально */ });
      } catch (e) { /* оффлайн */ }
    }, 1500);
    document.dispatchEvent(new CustomEvent('video:library'));
  }
  function groupFor(item, intent) {
    intent = intent || {};
    var series = item.episode > 0 || /^(series|episode|anime)$/.test(intent.kind || '');
    if (series) {
      var t = intent.title || item.title;
      return { key: 'series:' + baseTitle(t), title: intent.title || baseTitle(item.title), kind: 'series' };
    }
    if (intent.franchise) return { key: 'franchise:' + baseTitle(intent.franchise), title: intent.franchise, kind: 'franchise' };
    return null;
  }
  var library = {
    all: function () { return libLoad(); },
    add: function (item, intent) {
      libLoad();
      var g = groupFor(item, intent);
      var entry = slimItem(item);
      if (intent && intent.title && !entry.label) entry.label = intent.title;
      if (g) {
        var grp = lib.groups.filter(function (x) { return x.key === g.key; })[0];
        if (!grp) { grp = { key: g.key, title: g.title, kind: g.kind, cover: item.image || '', items: [] }; lib.groups.unshift(grp); }
        var have = grp.items.filter(function (x) { return x.source === item.source && x.id === item.id; })[0];
        if (!have) grp.items.push(entry);
        grp.items.sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode) || (a.addedAt - b.addedAt); });
        grp.updatedAt = Date.now();
        lib.groups.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      } else {
        lib.singles = lib.singles.filter(function (x) { return !(x.source === item.source && x.id === item.id); });
        lib.singles.unshift(entry);
        lib.singles = lib.singles.slice(0, 200);
      }
      libSave();
    },
    position: function (item, pos) {
      libLoad();
      var hit = null;
      lib.singles.concat.apply(lib.singles, lib.groups.map(function (g) { return g.items; })).forEach(function (x) { if (x.source === item.source && x.id === item.id) hit = x; });
      if (hit && Math.abs((hit.pos || 0) - pos) >= 5) { hit.pos = Math.floor(pos); try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { /* нет места */ } }
    },
    find: function (item) {
      libLoad();
      var hit = null;
      lib.singles.concat.apply(lib.singles, lib.groups.map(function (g) { return g.items; })).forEach(function (x) { if (x.source === item.source && x.id === item.id) hit = x; });
      return hit;
    },
    remove: function (groupKey, source, id) {
      libLoad();
      if (groupKey === 'singles') lib.singles = lib.singles.filter(function (x) { return !(x.source === source && x.id === id); });
      else {
        lib.groups.forEach(function (g) { if (g.key === groupKey) g.items = g.items.filter(function (x) { return !(x.source === source && x.id === id); }); });
        lib.groups = lib.groups.filter(function (g) { return g.items.length; });
      }
      libSave();
    },
    removeGroup: function (key) { libLoad(); lib.groups = lib.groups.filter(function (g) { return g.key !== key; }); libSave(); },
    hydrate: function (remote) {
      if (!remote || typeof remote !== 'object') return;
      libLoad();
      (remote.groups || []).forEach(function (g) {
        var mine = lib.groups.filter(function (x) { return x.key === g.key; })[0];
        if (!mine) { lib.groups.push(g); return; }
        (g.items || []).forEach(function (it) { if (!mine.items.some(function (x) { return x.source === it.source && x.id === it.id; })) mine.items.push(it); });
      });
      (remote.singles || []).forEach(function (it) { if (!lib.singles.some(function (x) { return x.source === it.source && x.id === it.id; })) lib.singles.push(it); });
      try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { /* нет места */ }
    }
  };

  /* ----------------------------------------------------------- плеер */

  function srcLabel(it) { return it && it.source === 'yt' ? 'YouTube' : 'VK Видео'; }
  function voiceLabel(v) {
    if (!v) return 'Русский';
    if (v.voice === 'Оригинал') return 'Английский · оригинал';
    if (v.voice === 'Субтитры') return 'Оригинал с субтитрами';
    if (v.voice === 'Без пометки') return 'Русский · без пометки';
    return (v.lang === 'en' ? 'Английский · ' : 'Русский · ') + v.voice;
  }
  function itemMeta(it, intent) {
    var bits = [];
    if (it.season || it.episode) bits.push((it.season ? it.season + ' сезон' : '') + (it.season && it.episode ? ', ' : '') + (it.episode ? it.episode + ' серия' : ''));
    else if (intent && intent.year) bits.push(String(intent.year));
    if (it.voice) bits.push(it.voice);
    if (it.duration) bits.push(fmt(it.duration));
    bits.push(srcLabel(it));
    return bits.join(' · ');
  }

  /* create(data, opts) → {el, load(item), destroy()}
     data: ответ сервера {best, items, episodes, voices, intent}
     opts: {autoplay, start, compact, onClose} */
  function create(data, opts) {
    opts = opts || {};
    data = data || {};
    var intent = data.intent || {};
    var cur = data.best || (data.items || [])[0];
    var el = document.createElement('div');
    el.className = 'hv' + (opts.modal ? ' hv--modal' : '');
    el.tabIndex = 0;
    el.innerHTML =
      '<div class="hv-top">' +
      '  <button type="button" class="hv-ib hv-collapse" aria-label="Свернуть плеер">' + IC.chev + '</button>' +
      '  <div class="hv-head"><div class="hv-title"></div><div class="hv-meta"></div></div>' +
      '  <button type="button" class="hv-ib hv-save" aria-label="В плейлист «Фильмы и Сериалы»" title="В «Фильмы и Сериалы»">' + IC.plus + '</button>' +
      (opts.modal ? '  <button type="button" class="hv-ib hv-x" aria-label="Закрыть">' + IC.close + '</button>' : '') +
      '</div>' +
      '<div class="hv-stage">' +
      '  <button type="button" class="hv-poster" aria-label="Смотреть"><span class="hv-bigplay">' + IC.play + '</span><span class="hv-dur"></span></button>' +
      '  <div class="hv-note" hidden></div>' +
      '  <div class="hv-end" hidden></div>' +
      '</div>' +
      '<div class="hv-bar">' +
      '  <div class="hv-prog" role="slider" aria-label="Перемотка" tabindex="0"><div class="hv-track"><i class="hv-buf"></i><i class="hv-played"></i><i class="hv-knob"></i></div><span class="hv-tip" hidden></span></div>' +
      '  <div class="hv-row">' +
      '    <button type="button" class="hv-ib hv-play" aria-label="Смотреть">' + IC.play + '</button>' +
      '    <div class="hv-vol"><button type="button" class="hv-ib hv-volbtn" aria-label="Звук">' + IC.vol + '</button><input class="hv-volr" type="range" min="0" max="100" value="100" aria-label="Громкость"></div>' +
      '    <span class="hv-time">00:00</span>' +
      '    <span class="hv-sp"></span>' +
      '    <button type="button" class="hv-ib hv-gear" aria-label="Настройки" aria-haspopup="menu">' + IC.gear + '</button>' +
      '    <button type="button" class="hv-ib hv-full" aria-label="На весь экран">' + IC.full + '</button>' +
      '  </div>' +
      '</div>' +
      '<div class="hv-menu" role="menu" hidden></div>' +
      '<div class="hv-eps" hidden></div>' +
      '<details class="hv-more" hidden><summary>Другие варианты</summary><div class="hv-list"></div></details>';

    var $ = function (s) { return el.querySelector(s); };
    var stage = $('.hv-stage'), poster = $('.hv-poster'), note = $('.hv-note'), endBox = $('.hv-end');
    var prog = $('.hv-prog'), played = $('.hv-played'), buf = $('.hv-buf'), knob = $('.hv-knob'), tip = $('.hv-tip');
    var playBtn = $('.hv-play'), volBtn = $('.hv-volbtn'), volR = $('.hv-volr'), timeEl = $('.hv-time');
    var menu = $('.hv-menu');
    var adapter = null, st = { playing: false, t: 0, d: 0, vol: 1, muted: false, speed: 1, captions: '', quality: 0, ad: false, dragging: false };
    var lastSaved = 0, started = false;

    function setPlayIcon() {
      playBtn.innerHTML = st.playing ? IC.pause : IC.play;
      playBtn.setAttribute('aria-label', st.playing ? 'Пауза' : 'Смотреть');
      el.classList.toggle('is-playing', st.playing);
    }
    function setVolIcon() {
      volBtn.innerHTML = st.muted || st.vol === 0 ? IC.mute : (st.vol < 0.5 ? IC.volLow : IC.vol);
      volR.value = String(Math.round((st.muted ? 0 : st.vol) * 100));
      volR.style.setProperty('--v', volR.value + '%');
    }
    function paint() {
      var d = st.d || cur.duration || 0;
      var f = d ? clamp(st.t / d, 0, 1) : 0;
      played.style.width = (f * 100) + '%';
      knob.style.left = (f * 100) + '%';
      timeEl.textContent = d ? fmt(st.t) + ' / ' + fmt(d) : fmt(st.t);
      prog.setAttribute('aria-valuenow', String(Math.floor(st.t)));
      prog.setAttribute('aria-valuemax', String(Math.floor(d)));
    }

    var ui = {
      time: function (t, d, loaded) {
        if (!st.dragging) st.t = Number(t) || 0;
        if (d) st.d = Number(d) || st.d;
        if (loaded != null) buf.style.width = clamp(loaded * 100, 0, 100) + '%';
        paint();
        if (st.t - lastSaved > 10 || st.t < lastSaved) { lastSaved = st.t; library.position(cur, st.t); }
      },
      duration: function (d) { if (d) { st.d = Number(d); paint(); } },
      playing: function (on) {
        st.playing = !!on; setPlayIcon();
        if (on) { endBox.hidden = true; if (!started) { started = true; library.add(cur, intent); } }
      },
      volume: function (v, m) { if (v != null) st.vol = Number(v); st.muted = !!m; setVolIcon(); },
      quality: function (q) { st.quality = q; if (!menu.hidden) render(menuPanel); },
      actual: function (q) { st.actual = q; if (!menu.hidden) render(menuPanel); },
      speed: function (x) { st.speed = x; if (!menu.hidden) render(menuPanel); },
      captions: function (c) { st.captions = c; if (!menu.hidden) render(menuPanel); },
      refreshMenu: function () { if (!menu.hidden) render(menuPanel); },
      ad: function (on) { st.ad = !!on; el.classList.toggle('is-ad', st.ad); },
      limited: function (msg) { el.classList.toggle('is-limited', !!msg); showNote(msg, false); },
      error: function (msg) { showNote(msg, true); },
      ended: function () { showEnd(); }
    };
    function showNote(msg, err) {
      note.hidden = !msg; note.textContent = msg || ''; note.classList.toggle('is-err', !!err);
      if (err) { var more = $('.hv-more'); if (more && !more.hidden) more.open = true; }
    }

    function nextEpisode() {
      var eps = data.episodes || [];
      for (var i = 0; i < eps.length; i++) if (eps[i].episode > (cur.episode || 0)) return eps[i];
      return null;
    }
    function showEnd() {
      var nx = nextEpisode();
      if (!nx) return;
      endBox.hidden = false;
      endBox.innerHTML = '<button type="button" class="hv-next">' + IC.play + '<span>Следующая серия · ' + nx.episode + '</span></button>';
      endBox.querySelector('.hv-next').onclick = function () { load(nx, { autoplay: true }); };
    }

    function head() {
      // YouTube показываем его родным плеером: свои кнопки, качество, субтитры,
      // скорость и автодубляж — всё в шестерёнке YouTube. Наши кнопки — только для VK.
      el.classList.toggle('hv--native', cur.source === 'yt');
      $('.hv-title').textContent = (intent.title && (cur.episode || intent.kind === 'movie' || intent.kind === 'cartoon')) ? intent.title : cur.title;
      $('.hv-title').title = cur.title;
      $('.hv-meta').textContent = itemMeta(cur, intent);
      poster.style.backgroundImage = cur.image ? 'url("' + String(cur.image).replace(/["\\]/g, '') + '")' : '';
      $('.hv-dur').textContent = cur.duration ? fmt(cur.duration) : '';
    }

    function start(at) {
      if (adapter) adapter.destroy();
      showNote('', false); endBox.hidden = true;
      el.classList.add('is-on');
      st.t = at || 0; st.d = cur.duration || 0; st.quality = 0; st.actual = 0; st.speed = 1; st.captions = ''; started = false; lastSaved = st.t;
      paint();
      adapter = (cur.source === 'yt' ? ytAdapter : vkAdapter)(cur, stage, ui, { start: at || 0 });
      st.playing = true; setPlayIcon();
    }
    function load(item, o) {
      o = o || {};
      cur = item; head(); renderEpisodes(); renderList();
      if (o.autoplay || el.classList.contains('is-on')) start(o.start || 0);
      else { if (adapter) { adapter.destroy(); adapter = null; } el.classList.remove('is-on'); }
    }
    function toggle() {
      if (!adapter) { var saved = library.find(cur); start(saved && saved.pos > 10 && (!cur.duration || saved.pos < cur.duration - 30) ? saved.pos : 0); return; }
      if (st.playing) adapter.pause(); else adapter.play();
    }

    poster.addEventListener('click', toggle);
    playBtn.addEventListener('click', toggle);

    /* громкость: на телефоне — только «без звука», ползунок на компьютере */
    volBtn.addEventListener('click', function () {
      st.muted = !(st.muted || st.vol === 0);
      if (!st.muted && st.vol === 0) st.vol = 0.6;
      if (adapter) adapter.setMuted(st.muted);
      setVolIcon();
    });
    volR.addEventListener('input', function () {
      st.vol = Number(volR.value) / 100; st.muted = st.vol === 0;
      if (adapter) { adapter.setVolume(st.vol); adapter.setMuted(st.muted); }
      setVolIcon();
    });

    /* перемотка: клик и перетаскивание по полосе, подсказка времени */
    function fracAt(x) { var r = prog.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1); }
    prog.addEventListener('pointerdown', function (e) {
      if (!adapter || !st.d) return;
      st.dragging = true; prog.setPointerCapture(e.pointerId); el.classList.add('is-seeking');
      st.t = fracAt(e.clientX) * st.d; paint();
    });
    prog.addEventListener('pointermove', function (e) {
      var d = st.d || cur.duration;
      if (d) { var f = fracAt(e.clientX); tip.hidden = false; tip.textContent = fmt(f * d); tip.style.left = (f * 100) + '%'; }
      if (st.dragging) { st.t = fracAt(e.clientX) * st.d; paint(); }
    });
    prog.addEventListener('pointerleave', function () { if (!st.dragging) tip.hidden = true; });
    function endDrag(e) {
      if (!st.dragging) return;
      st.dragging = false; el.classList.remove('is-seeking'); tip.hidden = true;
      st.t = fracAt(e.clientX) * st.d; paint();
      if (adapter) adapter.seek(st.t);
    }
    prog.addEventListener('pointerup', endDrag);
    prog.addEventListener('pointercancel', function () { st.dragging = false; el.classList.remove('is-seeking'); tip.hidden = true; });
    prog.addEventListener('keydown', function (e) {
      if (!adapter) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); st.t = clamp(st.t + (e.key === 'ArrowRight' ? 10 : -10), 0, st.d || 1e9); adapter.seek(st.t); paint(); }
    });

    /* полноэкранный режим: настоящий, а на iPhone (без Fullscreen API для блоков) — CSS */
    var fullBtn = $('.hv-full');
    function isFs() { return document.fullscreenElement === el || document.webkitFullscreenElement === el || el.classList.contains('hv-fs'); }
    function setFsIcon() { var on = isFs(); fullBtn.innerHTML = on ? IC.fullExit : IC.full; fullBtn.setAttribute('aria-label', on ? 'Выйти из полноэкранного режима' : 'На весь экран'); el.classList.toggle('is-fs', on); }
    function exitFs() {
      if (el.classList.contains('hv-fs')) { el.classList.remove('hv-fs'); document.documentElement.classList.remove('hv-lock'); setFsIcon(); return; }
      if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitExitFullscreen && document.webkitFullscreenElement) document.webkitExitFullscreen();
    }
    fullBtn.addEventListener('click', function () {
      if (isFs()) { exitFs(); return; }
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { try { var r = req.call(el); if (r && r.catch) r.catch(function () { el.classList.add('hv-fs'); document.documentElement.classList.add('hv-lock'); setFsIcon(); }); } catch (e) { el.classList.add('hv-fs'); } }
      else { el.classList.add('hv-fs'); document.documentElement.classList.add('hv-lock'); }
      setFsIcon();
    });
    document.addEventListener('fullscreenchange', setFsIcon);
    document.addEventListener('webkitfullscreenchange', setFsIcon);

    /* свернуть: на весь экран — выйти; иначе — свернуть в строку (видео на паузу) */
    $('.hv-collapse').addEventListener('click', function () {
      if (isFs()) { exitFs(); return; }
      var on = !el.classList.contains('is-collapsed');
      el.classList.toggle('is-collapsed', on);
      $('.hv-collapse').setAttribute('aria-label', on ? 'Развернуть плеер' : 'Свернуть плеер');
      if (on && adapter && st.playing) adapter.pause();
      closeMenu();
    });
    $('.hv-save').addEventListener('click', function () {
      library.add(cur, intent);
      toast('Добавлено в «Фильмы и Сериалы»');
      $('.hv-save').classList.add('is-done');
      $('.hv-save').innerHTML = IC.check;
    });
    if (opts.modal) $('.hv-x').addEventListener('click', function () { destroy(); if (opts.onClose) opts.onClose(); });

    el.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
      else if (e.key === 'f') { fullBtn.click(); }
      else if (e.key === 'm') { volBtn.click(); }
      else if (e.key === 'Escape') { if (!menu.hidden) closeMenu(); else if (el.classList.contains('hv-fs')) exitFs(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && adapter && e.target === el) { e.preventDefault(); st.t = clamp(st.t + (e.key === 'ArrowRight' ? 10 : -10), 0, st.d || 1e9); adapter.seek(st.t); paint(); }
    });

    /* ----------------------------- меню настроек */
    var menuPanel = 'main';
    function caps() { return adapter ? adapter.caps() : (cur.source === 'yt' ? { qualities: [], auto: true, speeds: [1], captions: [] } : { qualities: [1080, 720, 480, 360], auto: true, speeds: [1], captions: [] }); }
    function curQualityLabel() { return st.quality ? st.quality + 'p' : 'Авто' + (st.actual ? ' · ' + st.actual + 'p' : ''); }
    function curVoice() {
      var vs = data.voices || [];
      for (var i = 0; i < vs.length; i++) if (vs[i].item && vs[i].item.id === cur.id && vs[i].item.source === cur.source) return vs[i];
      return cur.voice ? { voice: cur.voice, lang: cur.lang || 'ru' } : null;
    }
    function row(attrs, label, value, extra) {
      return '<button type="button" class="hv-mi' + (extra || '') + '" ' + attrs + '><span class="hv-mi-l">' + label + '</span>' + (value != null ? '<span class="hv-mi-v">' + value + '</span>' : '') + '</button>';
    }
    function render(panel) {
      menuPanel = panel;
      var c = caps(), html = '';
      var backHead = function (t) { return '<div class="hv-mh"><button type="button" class="hv-ib hv-mback" aria-label="Назад">' + IC.back + '</button><span>' + t + '</span></div>'; };
      if (panel === 'main') {
        var cv = curVoice();
        html = row('data-go="quality"', 'Качество', esc(curQualityLabel()) + IC.right) +
          row('data-go="captions"', 'Субтитры', (st.captions ? esc((c.captions.filter(function (x) { return x.code === st.captions; })[0] || {}).label || st.captions) : 'Выкл') + IC.right) +
          row('data-go="speed"', 'Скорость', (st.speed === 1 ? 'Обычная' : st.speed + '×') + IC.right) +
          row('data-go="voice"', 'Дубляж', esc(cv ? voiceLabel(cv).split(' · ')[0] : 'Русский') + IC.right);
      } else if (panel === 'quality') {
        html = backHead('Качество');
        html += row('data-q="0"', (st.quality === 0 ? IC.check : '<i class="hv-ck"></i>') + 'Авто', c.auto ? null : '', st.quality === 0 ? ' is-on' : '');
        QUALITIES.forEach(function (q) {
          var proOnly = q >= 1440 && !isPro();
          var ok = c.qualities.indexOf(q) >= 0;
          var on = st.quality === q;
          var right = proOnly ? '<span class="hv-pro">Только с Pro</span>' : (ok ? null : '<span class="hv-na">' + (cur.source === 'yt' ? 'YouTube выбирает сам' : 'нет в видео') + '</span>');
          html += row('data-q="' + q + '"' + (proOnly ? ' data-pro="1"' : '') + (!ok && !proOnly ? ' disabled' : ''), (on ? IC.check : '<i class="hv-ck"></i>') + q + 'p' + (q >= 720 ? ' <b class="hv-hd">' + (q >= 2160 ? '4K' : 'HD') + '</b>' : ''), right, (on ? ' is-on' : '') + (proOnly ? ' is-pro' : ''));
        });
      } else if (panel === 'speed') {
        html = backHead('Скорость');
        SPEEDS.forEach(function (x) {
          var ok = c.speeds.indexOf(x) >= 0, on = st.speed === x;
          html += row('data-s="' + x + '"' + (ok ? '' : ' disabled'), (on ? IC.check : '<i class="hv-ck"></i>') + (x === 1 ? 'Обычная' : x + '×'), ok ? null : '<span class="hv-na">' + (cur.source === 'vk' ? 'VK не даёт менять' : 'недоступно') + '</span>', on ? ' is-on' : '');
        });
      } else if (panel === 'captions') {
        html = backHead('Субтитры');
        html += row('data-c=""', (!st.captions ? IC.check : '<i class="hv-ck"></i>') + 'Выкл', null, !st.captions ? ' is-on' : '');
        if (c.captions.length) {
          c.captions.forEach(function (t) { var on = st.captions === t.code; html += row('data-c="' + esc(t.code) + '"', (on ? IC.check : '<i class="hv-ck"></i>') + esc(t.label), null, on ? ' is-on' : ''); });
        } else {
          html += '<div class="hv-mnote">' + (cur.source === 'vk' ? 'Встроенный плеер VK не отдаёт субтитры.' : (adapter ? 'У этого видео нет субтитров.' : 'Запустите видео — список появится.')) + '</div>';
        }
      } else if (panel === 'voice') {
        html = backHead('Дубляж');
        var vs = (data.voices || []).slice();
        var cv2 = curVoice();
        if (!vs.length) html += '<div class="hv-mnote">Других озвучек не нашлось. Попросите в чате, например: «давай в оригинале» или «найди в озвучке LostFilm».</div>';
        vs.sort(function (a, b) { return (a.lang === 'ru' ? 0 : 1) - (b.lang === 'ru' ? 0 : 1); });
        vs.forEach(function (v, i) {
          var on = cv2 && v.item && v.item.id === cur.id;
          html += row('data-v="' + i + '"', (on ? IC.check : '<i class="hv-ck"></i>') + esc(voiceLabel(v)), '<span class="hv-na">' + srcLabel(v.item) + '</span>', on ? ' is-on' : '');
        });
        data._voicesSorted = vs;
      }
      menu.innerHTML = html;
      menu.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { render(b.getAttribute('data-go')); }; });
      var back = menu.querySelector('.hv-mback'); if (back) back.onclick = function () { render('main'); };
      menu.querySelectorAll('[data-q]').forEach(function (b) {
        b.onclick = function () {
          if (b.getAttribute('data-pro')) { closeMenu(); if (typeof global.goToDynatos === 'function') global.goToDynatos(); return; }
          var q = Number(b.getAttribute('data-q'));
          if (!adapter) { st.quality = q; closeMenu(); return; }
          if (adapter.kind === 'vk' && q !== st.quality) adapter.setQuality(q); else st.quality = q;
          closeMenu();
        };
      });
      menu.querySelectorAll('[data-s]').forEach(function (b) { b.onclick = function () { var x = Number(b.getAttribute('data-s')); if (adapter) adapter.setSpeed(x); st.speed = x; closeMenu(); }; });
      menu.querySelectorAll('[data-c]').forEach(function (b) { b.onclick = function () { var code = b.getAttribute('data-c'); if (adapter) adapter.setCaptions(code); st.captions = code; closeMenu(); }; });
      menu.querySelectorAll('[data-v]').forEach(function (b) {
        b.onclick = function () {
          var v = data._voicesSorted[Number(b.getAttribute('data-v'))];
          if (!v || !v.item) return;
          var at = st.t > 5 && Math.abs((v.item.duration || 0) - (cur.duration || 0)) < 120 ? st.t : 0;
          closeMenu(); load(v.item, { autoplay: true, start: at });
        };
      });
    }
    function openMenu() { render('main'); menu.hidden = false; el.classList.add('is-menu'); }
    function closeMenu() { menu.hidden = true; el.classList.remove('is-menu'); }
    $('.hv-gear').addEventListener('click', function (e) { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
    function outside(e) { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.hv-gear')) closeMenu(); }
    document.addEventListener('pointerdown', outside, true);

    /* ----------------------------- серии и другие варианты */
    function renderEpisodes() {
      var box = $('.hv-eps');
      var eps = data.episodes || [];
      if (eps.length < 2) { box.hidden = true; return; }
      box.hidden = false;
      var season = cur.season || (eps[0] && eps[0].season) || intent.season || 1;
      box.innerHTML = '<div class="hv-eps-h">' + season + ' сезон</div><div class="hv-eps-row">' + eps.map(function (e, i) {
        var on = e.id === cur.id && e.source === cur.source;
        return '<button type="button" class="hv-ep' + (on ? ' is-on' : '') + '" data-i="' + i + '" title="' + esc(e.title) + '">' + e.episode + '</button>';
      }).join('') + '</div>';
      box.querySelectorAll('.hv-ep').forEach(function (b) { b.onclick = function () { load(eps[Number(b.getAttribute('data-i'))], { autoplay: true }); }; });
      var on = box.querySelector('.hv-ep.is-on'); if (on && on.scrollIntoView) try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* старый браузер */ }
    }
    function renderList() {
      var more = $('.hv-more'), list = $('.hv-list');
      var items = (data.items || []).filter(function (x) { return !(x.id === cur.id && x.source === cur.source); }).slice(0, 10);
      if (!items.length) { more.hidden = true; return; }
      more.hidden = false;
      list.innerHTML = items.map(function (x, i) {
        return '<button type="button" class="hv-li" data-i="' + i + '">' +
          '<span class="hv-li-img"' + (x.image ? ' style="background-image:url(&quot;' + esc(String(x.image).replace(/["\\]/g, '')) + '&quot;)"' : '') + '>' + (x.duration ? '<i>' + fmt(x.duration) + '</i>' : '') + '</span>' +
          '<span class="hv-li-m"><b>' + esc(x.title) + '</b><span>' + esc([x.voice, srcLabel(x)].filter(Boolean).join(' · ')) + '</span></span></button>';
      }).join('');
      list.querySelectorAll('.hv-li').forEach(function (b) { b.onclick = function () { load(items[Number(b.getAttribute('data-i'))], { autoplay: true }); more.open = false; }; });
    }

    function destroy() {
      if (adapter) adapter.destroy(); adapter = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('fullscreenchange', setFsIcon);
      document.removeEventListener('webkitfullscreenchange', setFsIcon);
      document.documentElement.classList.remove('hv-lock');
      el.remove();
    }

    if (!cur) { el.innerHTML = '<div class="hv-empty">Видео не найдено</div>'; return { el: el, destroy: function () { el.remove(); } }; }
    head(); renderEpisodes(); renderList(); setVolIcon(); paint();
    if (opts.autoplay) start(opts.start || 0);
    return { el: el, load: load, destroy: destroy, current: function () { return cur; }, pause: function () { if (adapter) adapter.pause(); } };
  }

  /* Плеер в отдельном окне — для запуска из «Фильмов и Сериалов». */
  function openModal(item, list, intent) {
    var wrap = document.createElement('div');
    wrap.className = 'hv-modal';
    var eps = (list || []).filter(function (x) { return x.episode; });
    var p = create({ best: item, items: list || [], episodes: eps.length > 1 ? eps : [], voices: [], intent: intent || {} }, {
      modal: true, autoplay: true, start: item.pos && (!item.duration || item.pos < item.duration - 30) ? item.pos : 0,
      onClose: function () { wrap.remove(); document.documentElement.classList.remove('hv-lock'); }
    });
    wrap.appendChild(p.el);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) { p.destroy(); wrap.remove(); document.documentElement.classList.remove('hv-lock'); } });
    document.body.appendChild(wrap);
    document.documentElement.classList.add('hv-lock');
    setTimeout(function () { try { p.el.focus(); } catch (e) { /* нет */ } }, 50);
    return p;
  }

  /* ----------------------------------------------------------- «Фильмы и Сериалы» */
  function renderLibrary(el, onBack, groupKey) {
    var L = libLoad();
    var headHtml = function (title, backId) {
      return '<div class="vl-head"><button type="button" class="vl-back" id="' + backId + '" aria-label="Назад"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><b>' + esc(title) + '</b></div>';
    };
    var plural = function (n, f) { var a = n % 100, b = n % 10; return n + ' ' + (a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]); };
    var rowHtml = function (x, key, i) {
      var sub = [x.season || x.episode ? (x.season ? x.season + ' сезон' : '') + (x.season && x.episode ? ', ' : '') + (x.episode ? x.episode + ' серия' : '') : '', x.voice, x.duration ? (x.pos > 30 ? fmt(x.pos) + ' из ' : '') + fmt(x.duration) : '', srcLabel(x)].filter(Boolean).join(' · ');
      var pct = x.duration && x.pos ? clamp(x.pos / x.duration * 100, 0, 100) : 0;
      return '<div class="vl-row"><button type="button" class="vl-open" data-k="' + esc(key) + '" data-i="' + i + '">' +
        '<span class="vl-img"' + (x.image ? ' style="background-image:url(&quot;' + esc(String(x.image).replace(/["\\]/g, '')) + '&quot;)"' : '') + '>' + (pct ? '<i style="width:' + pct.toFixed(1) + '%"></i>' : '') + '</span>' +
        '<span class="vl-m"><b>' + esc(x.label && !x.episode ? x.label : x.title) + '</b><span>' + esc(sub) + '</span></span></button>' +
        '<button type="button" class="vl-del" data-k="' + esc(key) + '" data-i="' + i + '" aria-label="Убрать">' + IC.close + '</button></div>';
    };
    if (groupKey) {
      var g = L.groups.filter(function (x) { return x.key === groupKey; })[0];
      if (!g) { renderLibrary(el, onBack); return; }
      el.innerHTML = headHtml(g.title, 'vlBack') + '<div class="vl-list">' + g.items.map(function (x, i) { return rowHtml(x, g.key, i); }).join('') + '</div>';
      el.querySelector('#vlBack').onclick = function () { renderLibrary(el, onBack); };
      el.querySelectorAll('.vl-open').forEach(function (b) { b.onclick = function () { var it = g.items[Number(b.getAttribute('data-i'))]; openModal(it, g.items, { title: g.title, kind: g.kind === 'series' ? 'series' : 'movie' }); }; });
      el.querySelectorAll('.vl-del').forEach(function (b) { b.onclick = function () { var it = g.items[Number(b.getAttribute('data-i'))]; library.remove(g.key, it.source, it.id); renderLibrary(el, onBack, g.key); }; });
      return;
    }
    var groupsHtml = L.groups.map(function (g) {
      var n = g.items.length;
      return '<button type="button" class="pl-row vl-group" data-g="' + esc(g.key) + '">' +
        (g.cover ? '<img class="pl-row__cover" src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="pl-row__cover is-empty"></span>') +
        '<span class="pl-row__meta"><span class="pl-row__title">' + esc(g.title) + '</span><span class="pl-row__sub">' + (g.kind === 'series' ? plural(n, ['серия', 'серии', 'серий']) : plural(n, ['фильм', 'фильма', 'фильмов'])) + '</span></span>' +
        '<span class="pl-row__chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span></button>';
    }).join('');
    el.innerHTML = headHtml('Фильмы и Сериалы', 'vlBack') +
      (L.groups.length ? '<div class="vl-h">Сериалы и серии фильмов</div><div class="pl-rows">' + groupsHtml + '</div>' : '') +
      '<div class="vl-h">Фильмы и видео</div>' +
      (L.singles.length ? '<div class="vl-list">' + L.singles.map(function (x, i) { return rowHtml(x, 'singles', i); }).join('') + '</div>' : '') +
      (!L.groups.length && !L.singles.length ? '<div class="pl-note">Пока пусто. Попросите в чате: «включи Интерстеллар» или «третья серия второго сезона Мандалорца» — всё, что начнёте смотреть, появится здесь.</div>' : '');
    el.querySelector('#vlBack').onclick = function () { if (onBack) onBack(); };
    el.querySelectorAll('.vl-group').forEach(function (b) { b.onclick = function () { renderLibrary(el, onBack, b.getAttribute('data-g')); }; });
    el.querySelectorAll('.vl-open').forEach(function (b) { b.onclick = function () { openModal(L.singles[Number(b.getAttribute('data-i'))], [], {}); }; });
    el.querySelectorAll('.vl-del').forEach(function (b) { b.onclick = function () { var it = L.singles[Number(b.getAttribute('data-i'))]; library.remove('singles', it.source, it.id); renderLibrary(el, onBack); }; });
  }

  /* Включён ли плагин VK Video у этого пользователя (по умолчанию — да). */
  function enabled() { try { return localStorage.getItem('hm_vk_video_off') !== '1'; } catch (e) { return true; } }
  function setEnabled(on) { try { if (on) localStorage.removeItem('hm_vk_video_off'); else localStorage.setItem('hm_vk_video_off', '1'); } catch (e) { /* нет */ } }

  global.HmVideo = { create: create, openModal: openModal, library: library, renderLibrary: renderLibrary, enabled: enabled, setEnabled: setEnabled, fmt: fmt, icons: IC };
})(window);
