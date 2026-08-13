/* ============================================================================
   HarmonyAI — глобальный плеер.

   Принципы:
     • Один <audio> на весь сайт. Переход между чатами не рвёт звук.
     • Подписанная ссылка протухает — при ошибке молча берём новую и продолжаем
       С ТОГО ЖЕ МЕСТА. Пользователь ничего не замечает.
     • Следующий трек всегда прогрет заранее → «далее» без паузы.
     • MediaSession: обложка, кнопки и перемотка в шторке телефона и на
       локскрине — музыка продолжает играть в фоне со свёрнутым браузером.
     • Состояние в localStorage — после F5 очередь на месте.

   Два вида:
     1. Компактная строка в колонке чата — обложка, название, лайк, пауза.
     2. Полноэкранное окно трека — открывается нажатием на строку.
        Фон обоих видов — размытая обложка (liquid glass).

   Лайк уходит в Яндекс.Музыку пользователя: трек появляется у него
   в «Мне нравится» в самом приложении Яндекса.
   ========================================================================== */

(function (global) {
  'use strict';

  var STORE_KEY = 'hm_music_player_v1';
  var SAVE_DEBOUNCE_MS = 1200;

  var el = {};
  var audio = null;
  var saveTimer = null;
  var lastSaveAt = 0;
  var posTimer = 0;

  var state = {
    queue: [],
    index: -1,
    playing: false,
    shuffle: false,
    repeat: 'off',      // off | all | one
    volume: 1,
    muted: false,
    collection: null,
    retrying: false,
    failStreak: 0,
    expanded: false,
    seeking: false,
    liked: null,        // Set идентификаторов или null, пока не загружено
    likedLoaded: false
  };

  /* ------------------------------------------------------------------ иконки

     Инлайн-SVG вместо текстовых глифов: глифы в разных системах выглядят
     по-разному и ломают вёрстку. currentColor — чтобы иконка красилась
     обычным CSS-свойством color. */

  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72c0 .83.92 1.33 1.62.88l10.5-6.86a1.05 1.05 0 0 0 0-1.76L9.62 4.26A1.05 1.05 0 0 0 8 5.14Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="6" y="4.5" width="4" height="15" rx="1.6"/><rect fill="currentColor" x="14" y="4.5" width="4" height="15" rx="1.6"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="5" y="5" width="2.2" height="14" rx="1.1"/><path fill="currentColor" d="M19 6.6v10.8c0 .82-.93 1.3-1.6.85l-8.1-5.4a1 1 0 0 1 0-1.7l8.1-5.4c.67-.45 1.6.03 1.6.85Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="16.8" y="5" width="2.2" height="14" rx="1.1"/><path fill="currentColor" d="M5 6.6v10.8c0 .82.93 1.3 1.6.85l8.1-5.4a1 1 0 0 0 0-1.7L6.6 5.75C5.93 5.3 5 5.78 5 6.6Z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 20.3c-1.3-.85-8-5.4-8-10.05A4.35 4.35 0 0 1 12 7.2a4.35 4.35 0 0 1 8 3.05c0 4.65-6.7 9.2-8 10.05Z"/></svg>',
    heartOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.3c-1.3-.85-8-5.4-8-10.05A4.35 4.35 0 0 1 12 7.2a4.35 4.35 0 0 1 8 3.05c0 4.65-6.7 9.2-8 10.05Z"/></svg>',
    heartBroken: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 20.3c-1.3-.85-8-5.4-8-10.05A4.35 4.35 0 0 1 12 7.2a4.35 4.35 0 0 1 8 3.05c0 4.65-6.7 9.2-8 10.05Z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m12.6 7.4-2 3.4 2.7 1.7-2.1 3.3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9.5 6 6 6-6"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle fill="currentColor" cx="5.5" cy="12" r="1.8"/><circle fill="currentColor" cx="12" cy="12" r="1.8"/><circle fill="currentColor" cx="18.5" cy="12" r="1.8"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3.5v11M8.6 6.9 12 3.5l3.4 3.4M6 12.5V19a1.8 1.8 0 0 0 1.8 1.8h8.4A1.8 1.8 0 0 0 18 19v-6.5"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 7h3.5l7 10H21M3 17h3.5l2.2-3.1M14.6 8.2 21 7M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M17 3.5 20 6.5l-3 3M20 6.5H7A3.5 3.5 0 0 0 3.5 10v1M7 20.5 4 17.5l3-3M4 17.5h13a3.5 3.5 0 0 0 3.5-3.5v-1"/></svg>',
    repeatOne: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M17 3.5 20 6.5l-3 3M20 6.5H7A3.5 3.5 0 0 0 3.5 10v1M7 20.5 4 17.5l3-3M4 17.5h13a3.5 3.5 0 0 0 3.5-3.5v-1"/><path fill="currentColor" d="M11.4 9.6h1.3v5h-1.3v-3.8l-1 .5-.3-1z"/></svg>',
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 7h12M4 12h12M4 17h8M19 6.5v7.2"/><circle fill="currentColor" cx="17.3" cy="15.4" r="2.1"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.5h3L11 6v12l-4-3.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M14.5 9a4.2 4.2 0 0 1 0 6M17 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    volumeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.5h3L11 6v12l-4-3.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m15 10 5 5M20 10l-5 5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>'
  };

  /* ------------------------------------------------------------------ утилиты */

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function current() {
    return state.index >= 0 && state.index < state.queue.length
      ? state.queue[state.index]
      : null;
  }

  function nextIndex() {
    if (!state.queue.length) return -1;
    if (state.repeat === 'one') return state.index;
    if (state.shuffle) {
      if (state.queue.length === 1) return 0;
      var r = state.index;
      while (r === state.index) r = Math.floor(Math.random() * state.queue.length);
      return r;
    }
    if (state.index + 1 < state.queue.length) return state.index + 1;
    return state.repeat === 'all' ? 0 : -1;
  }

  function notify(msg) {
    if (typeof global.showToast === 'function') { global.showToast(msg); return; }
    console.warn('[music]', msg);
  }

  function client() { return global.MusicClient || null; }

  /* ------------------------------------------------------------------ разметка */

  function iconBtn(id, icon, label, cls) {
    return '<button type="button" class="music-ico' + (cls ? ' ' + cls : '') + '" id="' + id +
      '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + icon + '</button>';
  }

  function ensureDom() {
    if (el.bar) return;
    buildBar();
    buildScreen();
    buildAudio();
    bindEvents();
  }

  /* Компактная строка: живёт ВНУТРИ колонки чата, сразу под топбаром
     с выбором модели. Не перекрывает поле ввода и не выходит за рамки чата. */
  function buildBar() {
    var bar = document.getElementById('musicPlayerBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'musicPlayerBar';
      var main = document.getElementById('main');
      var chatArea = document.getElementById('chatArea');
      if (main && chatArea) main.insertBefore(bar, chatArea);
      else if (main) main.appendChild(bar);
      else document.body.appendChild(bar);
    }

    bar.className = 'music-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Музыкальный плеер');
    bar.innerHTML =
      '<div class="music-bar__amb" id="mbAmb" aria-hidden="true"></div>' +
      '<div class="music-bar__row" id="mbRow" role="button" tabindex="0" aria-label="Открыть плеер">' +
      '  <span class="music-bar__coverwrap"><img class="music-bar__cover" id="mbCover" alt="" /></span>' +
      '  <span class="music-bar__meta">' +
      '    <span class="music-bar__title" id="mbTitle"></span>' +
      '    <span class="music-bar__artist" id="mbArtist"></span>' +
      '  </span>' +
      '  <span class="music-bar__acts">' +
      iconBtn('mbLike', ICON.heart, 'Нравится', 'music-ico--like') +
      iconBtn('mbPlay', ICON.play, 'Воспроизвести', 'music-ico--play') +
      '  </span>' +
      '</div>' +
      '<div class="music-bar__line" aria-hidden="true"><i id="mbLine"></i></div>';

    el.bar = bar;
    el.amb = bar.querySelector('#mbAmb');
    el.row = bar.querySelector('#mbRow');
    el.cover = bar.querySelector('#mbCover');
    el.title = bar.querySelector('#mbTitle');
    el.artist = bar.querySelector('#mbArtist');
    el.like = bar.querySelector('#mbLike');
    el.play = bar.querySelector('#mbPlay');
    el.line = bar.querySelector('#mbLine');
  }

  /* Полноэкранное окно трека. Живёт в <body>, чтобы блюр перекрывал весь экран. */
  function buildScreen() {
    var scr = document.getElementById('musicScreen');
    if (!scr) {
      scr = document.createElement('div');
      scr.id = 'musicScreen';
      document.body.appendChild(scr);
    }

    scr.className = 'music-screen';
    scr.setAttribute('role', 'dialog');
    scr.setAttribute('aria-modal', 'true');
    scr.setAttribute('aria-label', 'Проигрывается');
    scr.hidden = true;
    scr.innerHTML =
      '<div class="music-screen__amb" id="msAmb" aria-hidden="true"></div>' +
      '<div class="music-screen__veil" aria-hidden="true"></div>' +
      '<div class="music-screen__inner">' +
      '  <div class="music-screen__grip" aria-hidden="true"></div>' +
      '  <div class="music-screen__top">' +
      iconBtn('msCollapse', ICON.chevron, 'Свернуть') +
      iconBtn('msMenu', ICON.dots, 'Ещё') +
      '  </div>' +
      '  <div class="music-screen__art"><img id="msArt" alt="" /></div>' +
      '  <div class="music-screen__head">' +
      '    <div class="music-screen__titles">' +
      '      <div class="music-screen__title" id="msTitle"></div>' +
      '      <div class="music-screen__artist" id="msArtist"></div>' +
      '    </div>' +
      iconBtn('msShare', ICON.share, 'Поделиться') +
      '  </div>' +
      '  <div class="music-screen__seekwrap">' +
      '    <div class="music-seek" id="msSeek" role="slider" tabindex="0" aria-label="Перемотка"' +
      '         aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '      <i class="music-seek__buf" id="msBuf"></i>' +
      '      <i class="music-seek__played" id="msPlayed"></i>' +
      '      <i class="music-seek__thumb" id="msThumb"></i>' +
      '    </div>' +
      '    <div class="music-screen__times"><span id="msCur">0:00</span><span id="msDur">0:00</span></div>' +
      '  </div>' +
      '  <div class="music-screen__controls">' +
      iconBtn('msDislike', ICON.heartBroken, 'Не нравится') +
      iconBtn('msPrev', ICON.prev, 'Предыдущий', 'music-ico--step') +
      '    <button type="button" class="music-main" id="msPlay" title="Воспроизвести" aria-label="Воспроизвести">' + ICON.play + '</button>' +
      iconBtn('msNext', ICON.next, 'Следующий', 'music-ico--step') +
      iconBtn('msLike', ICON.heart, 'Нравится', 'music-ico--like') +
      '  </div>' +
      '</div>' +
      '<div class="music-sheet" id="msSheet" hidden>' +
      '  <div class="music-sheet__panel">' +
      '    <div class="music-sheet__grip" aria-hidden="true"></div>' +
      '    <div class="music-sheet__rows">' +
      '      <button type="button" class="music-sheet__row" id="shShuffle">' + ICON.shuffle + '<span>Вперемешку</span><b id="shShuffleV"></b></button>' +
      '      <button type="button" class="music-sheet__row" id="shRepeat">' + ICON.repeat + '<span>Повтор</span><b id="shRepeatV"></b></button>' +
      '      <div class="music-sheet__row music-sheet__row--vol">' + ICON.volume +
      '        <input type="range" id="shVol" min="0" max="100" value="100" aria-label="Громкость" />' +
      '      </div>' +
      '      <button type="button" class="music-sheet__row" id="shClose">' + ICON.close + '<span>Закрыть плеер</span></button>' +
      '    </div>' +
      '    <div class="music-sheet__title">Очередь</div>' +
      '    <div class="music-queue" id="msQueue"></div>' +
      '  </div>' +
      '</div>';

    el.screen = scr;
    el.msAmb = scr.querySelector('#msAmb');
    el.msArt = scr.querySelector('#msArt');
    el.msTitle = scr.querySelector('#msTitle');
    el.msArtist = scr.querySelector('#msArtist');
    el.msPlay = scr.querySelector('#msPlay');
    el.msPrev = scr.querySelector('#msPrev');
    el.msNext = scr.querySelector('#msNext');
    el.msLike = scr.querySelector('#msLike');
    el.msDislike = scr.querySelector('#msDislike');
    el.msShare = scr.querySelector('#msShare');
    el.msCollapse = scr.querySelector('#msCollapse');
    el.msMenu = scr.querySelector('#msMenu');
    el.seek = scr.querySelector('#msSeek');
    el.buf = scr.querySelector('#msBuf');
    el.played = scr.querySelector('#msPlayed');
    el.thumb = scr.querySelector('#msThumb');
    el.cur = scr.querySelector('#msCur');
    el.dur = scr.querySelector('#msDur');
    el.sheet = scr.querySelector('#msSheet');
    el.queue = scr.querySelector('#msQueue');
    el.shShuffle = scr.querySelector('#shShuffle');
    el.shRepeat = scr.querySelector('#shRepeat');
    el.shShuffleV = scr.querySelector('#shShuffleV');
    el.shRepeatV = scr.querySelector('#shRepeatV');
    el.shVol = scr.querySelector('#shVol');
    el.shClose = scr.querySelector('#shClose');
    el.inner = scr.querySelector('.music-screen__inner');
  }

  function buildAudio() {
    audio = document.getElementById('musicAudio');
    if (audio) return;
    audio = document.createElement('audio');
    audio.id = 'musicAudio';
    audio.preload = 'auto';
    // playsinline — чтобы iOS не открывал системный полноэкранный плеер
    // и звук продолжал идти в фоне при свёрнутом браузере.
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    // ВАЖНО: crossOrigin НЕ задаём. Хосты Яндекса, отдающие mp3-поток, не
    // присылают CORS-заголовки; с crossOrigin='anonymous' браузер БЛОКИРУЕТ
    // загрузку аудио, и трек не играет вообще.
    document.body.appendChild(audio);
  }

  /* ------------------------------------------------------------------ события */

  function stop(ev) { ev.preventDefault(); ev.stopPropagation(); }

  function bindEvents() {
    /* Нажатие на строку — раскрыть окно трека. Кнопки внутри строки
       гасят всплытие, чтобы лайк и пауза не открывали экран. */
    el.row.addEventListener('click', function () { expand(); });
    el.row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); expand(); }
    });

    el.play.addEventListener('click', function (ev) { stop(ev); toggle(); });
    el.like.addEventListener('click', function (ev) { stop(ev); toggleLike(); });

    el.msPlay.addEventListener('click', toggle);
    el.msNext.addEventListener('click', function () { next(true); });
    el.msPrev.addEventListener('click', prev);
    el.msLike.addEventListener('click', function () { toggleLike(); });
    el.msDislike.addEventListener('click', dislike);
    el.msShare.addEventListener('click', share);
    el.msCollapse.addEventListener('click', collapse);
    el.msMenu.addEventListener('click', toggleSheet);

    el.shShuffle.addEventListener('click', function () { toggleShuffle(); });
    el.shRepeat.addEventListener('click', function () { cycleRepeat(); });
    el.shClose.addEventListener('click', function () { close(); });
    el.shVol.addEventListener('input', function () {
      state.volume = Number(el.shVol.value) / 100;
      state.muted = state.volume === 0;
      audio.volume = state.volume;
      audio.muted = state.muted;
      save();
    });

    // Клик по фону-вуали закрывает шторку, но не сам экран.
    el.sheet.addEventListener('click', function (ev) {
      if (ev.target === el.sheet) toggleSheet();
    });

    bindSeek();
    bindSwipe();

    audio.addEventListener('timeupdate', renderProgress);
    audio.addEventListener('progress', renderBuffered);
    audio.addEventListener('play', emitChange);
    audio.addEventListener('pause', emitChange);
    audio.addEventListener('durationchange', renderProgress);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onAudioError);

    audio.addEventListener('play', function () {
      state.playing = true; renderPlayButton(); setMediaState('playing'); pushPositionState();
    });
    audio.addEventListener('pause', function () {
      state.playing = false; renderPlayButton(); setMediaState('paused'); save();
    });

    /* Уход со страницы или сворачивание вкладки — фиксируем позицию сразу,
       не дожидаясь throttle, иначе последние секунды прослушивания теряются. */
    global.addEventListener('pagehide', writeState);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') writeState();
    });

    document.addEventListener('keydown', function (ev) {
      if (!state.queue.length) return;
      var t = ev.target;
      var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;

      if (ev.code === 'Space') { ev.preventDefault(); toggle(); return; }
      if (ev.key === 'Escape' && state.expanded) { ev.preventDefault(); collapse(); }
    });
  }

  /** Перемотка: клик и перетаскивание пальцем/мышью. */
  function bindSeek() {
    var dragging = false;

    function ratioOf(ev) {
      var rect = el.seek.getBoundingClientRect();
      var x = (ev.clientX != null ? ev.clientX : 0) - rect.left;
      return Math.max(0, Math.min(1, rect.width ? x / rect.width : 0));
    }

    function preview(r) {
      var pct = r * 100;
      el.played.style.width = pct + '%';
      el.thumb.style.left = pct + '%';
      if (audio.duration) el.cur.textContent = fmtTime(r * audio.duration);
      el.seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    }

    el.seek.addEventListener('pointerdown', function (ev) {
      if (!audio.duration) return;
      dragging = true;
      state.seeking = true;
      el.seek.classList.add('is-dragging');
      try { el.seek.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      preview(ratioOf(ev));
    });

    el.seek.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      preview(ratioOf(ev));
    });

    function finish(ev) {
      if (!dragging) return;
      dragging = false;
      state.seeking = false;
      el.seek.classList.remove('is-dragging');
      if (audio.duration) audio.currentTime = ratioOf(ev) * audio.duration;
      pushPositionState();
    }
    el.seek.addEventListener('pointerup', finish);
    el.seek.addEventListener('pointercancel', function () {
      dragging = false; state.seeking = false;
      el.seek.classList.remove('is-dragging');
      renderProgress();
    });

    el.seek.addEventListener('keydown', function (ev) {
      if (!audio.duration) return;
      if (ev.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); ev.preventDefault(); }
      if (ev.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); ev.preventDefault(); }
    });
  }

  /** Свайп вниз по окну трека — закрыть. Привычный жест из мобильных плееров. */
  function bindSwipe() {
    var startY = 0, curY = 0, active = false;

    el.inner.addEventListener('touchstart', function (ev) {
      if (!ev.touches || ev.touches.length !== 1) return;
      // Не перехватываем жест, начатый на перемотке или на кнопке.
      if (ev.target.closest && ev.target.closest('.music-seek, button, input')) return;
      active = true;
      startY = curY = ev.touches[0].clientY;
    }, { passive: true });

    el.inner.addEventListener('touchmove', function (ev) {
      if (!active) return;
      curY = ev.touches[0].clientY;
      var dy = Math.max(0, curY - startY);
      el.inner.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
      el.screen.style.opacity = dy ? String(Math.max(0.35, 1 - dy / 420)) : '';
    }, { passive: true });

    el.inner.addEventListener('touchend', function () {
      if (!active) return;
      active = false;
      var dy = curY - startY;
      el.inner.style.transform = '';
      el.screen.style.opacity = '';
      if (dy > 90) collapse();
    });
  }

  /* -------------------------------------------------------------- MediaSession

     Именно это даёт фоновое воспроизведение: обложка и кнопки в шторке
     телефона, на локскрине и в панели мультимедиа десктопа. */

  function setMediaMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new global.MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || (state.collection && state.collection.title) || '',
        artwork: track.cover ? [
          { src: track.cover, sizes: '200x200', type: 'image/jpeg' },
          { src: track.cover, sizes: '400x400', type: 'image/jpeg' },
          { src: track.cover, sizes: '512x512', type: 'image/jpeg' }
        ] : []
      });

      var set = function (name, fn) {
        try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* не поддержано */ }
      };
      set('play', play);
      set('pause', pause);
      set('nexttrack', function () { next(true); });
      set('previoustrack', prev);
      set('seekto', function (d) {
        if (d && typeof d.seekTime === 'number' && audio.duration) {
          audio.currentTime = d.seekTime;
          pushPositionState();
        }
      });
      set('seekforward', function () { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
      set('seekbackward', function () { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    } catch (e) { /* noop */ }
  }

  function setMediaState(s) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = s; } catch (e) { /* noop */ }
  }

  /** Позиция для системного скраббера. Чаще раза в секунду не имеет смысла. */
  function pushPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    var now = Date.now();
    if (now - posTimer < 900) return;
    posTimer = now;
    try {
      if (!audio.duration || !isFinite(audio.duration)) return;
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, audio.duration)
      });
    } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------------ отрисовка */

  function renderPlayButton() {
    var icon = state.playing ? ICON.pause : ICON.play;
    var label = state.playing ? 'Пауза' : 'Воспроизвести';
    el.play.innerHTML = icon;
    el.play.title = label;
    el.play.setAttribute('aria-label', label);
    el.msPlay.innerHTML = icon;
    el.msPlay.title = label;
    el.msPlay.setAttribute('aria-label', label);
    el.bar.classList.toggle('is-playing', state.playing);
    el.screen.classList.toggle('is-playing', state.playing);
  }

  function renderProgress() {
    var d = audio.duration || 0;
    var c = audio.currentTime || 0;
    var pct = d ? (c / d) * 100 : 0;

    el.line.style.width = pct + '%';

    if (!state.seeking) {
      el.played.style.width = pct + '%';
      el.thumb.style.left = pct + '%';
      el.cur.textContent = fmtTime(c);
      el.seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    el.dur.textContent = fmtTime(d);

    // За 15 секунд до конца греем следующий трек.
    if (d && d - c < 15 && d - c > 13) prefetchNext();

    pushPositionState();
    save();
  }

  function renderBuffered() {
    try {
      if (!audio.buffered.length || !audio.duration) return;
      var end = audio.buffered.end(audio.buffered.length - 1);
      el.buf.style.width = ((end / audio.duration) * 100) + '%';
    } catch (e) { /* noop */ }
  }

  function renderVolume() {
    el.shVol.value = String(Math.round((state.muted ? 0 : state.volume) * 100));
  }

  function renderLike() {
    var t = current();
    var on = Boolean(t && state.liked && state.liked.has(String(t.trackId)));
    [el.like, el.msLike].forEach(function (b) {
      if (!b) return;
      b.innerHTML = on ? ICON.heartOn : ICON.heart;
      b.classList.toggle('is-on', on);
      var label = on ? 'Убрать из избранного' : 'Нравится';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /** Обложка задаёт цвет всему плееру — это и есть «жидкое стекло». */
  function renderArtwork(track) {
    var src = (track && track.cover) || '';
    if (src) {
      el.cover.src = src;
      el.cover.style.visibility = 'visible';
      el.msArt.src = src;
      el.msArt.style.visibility = 'visible';
      var bg = 'url("' + src.replace(/"/g, '%22') + '")';
      el.amb.style.backgroundImage = bg;
      el.msAmb.style.backgroundImage = bg;
      el.bar.classList.add('has-art');
      el.screen.classList.add('has-art');
    } else {
      el.cover.removeAttribute('src');
      el.cover.style.visibility = 'hidden';
      el.msArt.removeAttribute('src');
      el.msArt.style.visibility = 'hidden';
      el.amb.style.backgroundImage = '';
      el.msAmb.style.backgroundImage = '';
      el.bar.classList.remove('has-art');
      el.screen.classList.remove('has-art');
    }
  }

  function renderTrack() {
    var t = current();
    if (!t) return;

    el.title.textContent = t.title || '';
    el.artist.textContent = t.artist || '';
    el.msTitle.textContent = t.title || '';
    el.msArtist.textContent = t.artist || '';

    renderArtwork(t);
    renderLike();
    renderModes();
    setMediaMetadata(t);
    renderQueue();
    emitChange();
  }

  function renderModes() {
    el.shShuffle.classList.toggle('is-on', state.shuffle);
    el.shShuffleV.textContent = state.shuffle ? 'Вкл' : 'Выкл';
    el.shRepeat.classList.toggle('is-on', state.repeat !== 'off');
    el.shRepeat.innerHTML = (state.repeat === 'one' ? ICON.repeatOne : ICON.repeat) +
      '<span>Повтор</span><b id="shRepeatV">' +
      (state.repeat === 'off' ? 'Выкл' : (state.repeat === 'one' ? 'Один трек' : 'Очередь')) + '</b>';
    el.shRepeatV = el.shRepeat.querySelector('#shRepeatV');
  }

  function renderQueue() {
    if (!el.queue || el.sheet.hidden) return;
    el.queue.innerHTML = state.queue.map(function (t, i) {
      return '<button type="button" class="music-queue__row' + (i === state.index ? ' is-current' : '') +
        '" data-i="' + i + '">' +
        '<span class="music-queue__n">' + (i + 1) + '</span>' +
        '<span class="music-queue__t">' + esc(t.title) + '</span>' +
        '<span class="music-queue__a">' + esc(t.artist) + '</span>' +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(el.queue.querySelectorAll('.music-queue__row'), function (row) {
      row.addEventListener('click', function () {
        playAt(Number(row.getAttribute('data-i')));
      });
    });
  }

  function show() { ensureDom(); el.bar.classList.add('is-visible'); document.body.classList.add('has-music-bar'); }
  function hide() { if (el.bar) { el.bar.classList.remove('is-visible'); document.body.classList.remove('has-music-bar'); } }

  /* ------------------------------------------------------- окно трека */

  function expand() {
    if (!state.queue.length) return false;
    ensureDom();
    state.expanded = true;
    el.screen.hidden = false;
    /* Форсируем пересчёт стилей, чтобы браузер увидел начальное состояние
       и проиграл анимацию появления. Через requestAnimationFrame нельзя:
       в фоновой вкладке кадры не идут, и окно осталось бы прозрачным,
       заблокировав прокрутку страницы. */
    void el.screen.offsetWidth;
    el.screen.classList.add('is-open');
    document.body.classList.add('music-screen-open');
    renderTrack();
    renderProgress();
    renderBuffered();
    return true;
  }

  function collapse() {
    if (!el.screen) return false;
    state.expanded = false;
    el.screen.classList.remove('is-open');
    document.body.classList.remove('music-screen-open');
    if (!el.sheet.hidden) toggleSheet();
    var done = function () { if (!state.expanded) el.screen.hidden = true; };
    setTimeout(done, 280);
    return true;
  }

  function toggleSheet() {
    var open = el.sheet.hidden;
    el.sheet.hidden = !open;
    el.screen.classList.toggle('is-sheet-open', open);
    if (open) { renderModes(); renderVolume(); renderQueue(); }
  }

  /* ------------------------------------------------------------- лайки */

  /** Подтягиваем избранное один раз за сессию — чтобы сердечко не врало. */
  function syncLiked(force) {
    var c = client();
    if (!c || typeof c.likedIds !== 'function') return;
    if (state.likedLoaded && !force) return;
    state.likedLoaded = true;
    c.likedIds(force).then(function (ids) {
      state.liked = new Set((ids || []).map(String));
      renderLike();
      emitChange();
    }).catch(function () { /* избранное недоступно — сердечко просто пустое */ });
  }

  /**
   * Лайк уходит в аккаунт Яндекса пользователя: трек появляется
   * в «Мне нравится» прямо в приложении Яндекс.Музыки.
   * UI обновляем сразу, при ошибке — честно откатываем.
   */
  function toggleLike(force) {
    var t = current();
    var c = client();
    if (!t || !c) return false;

    if (!state.liked) state.liked = new Set();
    var id = String(t.trackId);
    var want = typeof force === 'boolean' ? force : !state.liked.has(id);

    if (want) state.liked.add(id); else state.liked.delete(id);
    renderLike();

    c.like(id, want).then(function () {
      if (typeof c.forgetLiked === 'function') c.forgetLiked();
      notify(want ? 'Добавлено в избранное Яндекс.Музыки' : 'Убрано из избранного');
    }).catch(function (e) {
      // Откат: сервер лайк не принял.
      if (want) state.liked.delete(id); else state.liked.add(id);
      renderLike();
      if (e && e.type === 'music_auth_required') {
        notify('Чтобы лайк попал в вашу Яндекс.Музыку, подключите аккаунт Яндекса в настройках.');
      } else {
        notify('Не удалось изменить избранное');
      }
    });
    return want;
  }

  /** «Не нравится»: убираем из избранного и сразу уходим на следующий трек. */
  function dislike() {
    var t = current();
    if (!t) return false;
    if (state.liked && state.liked.has(String(t.trackId))) toggleLike(false);
    next(true);
    return true;
  }

  function share() {
    var t = current();
    if (!t) return false;
    var url = 'https://music.yandex.ru/track/' + encodeURIComponent(t.trackId);
    var data = { title: t.title || '', text: (t.title || '') + ' — ' + (t.artist || ''), url: url };
    try {
      if (navigator.share) { navigator.share(data).catch(function () { /* отменили */ }); return true; }
    } catch (e) { /* идём в буфер обмена */ }
    try {
      navigator.clipboard.writeText(url).then(function () { notify('Ссылка на трек скопирована'); });
    } catch (e) { notify(url); }
    return true;
  }

  /* ------------------------------------------------------------- воспроизведение */

  /**
   * Загрузить очередь и сразу играть.
   * @param tracks   массив треков
   * @param startAt  индекс старта
   * @param playback ГОТОВАЯ ссылка для стартового трека (если есть) —
   *                 это и даёт мгновенный старт без второго запроса.
   */
  function setQueue(tracks, startAt, playback, collectionInfo) {
    ensureDom();
    state.queue = (tracks || []).filter(function (t) { return t && t.trackId; });
    state.collection = collectionInfo || null;
    if (!state.queue.length) return;
    show();
    syncLiked();
    playAt(typeof startAt === 'number' ? startAt : 0, playback);
  }

  function playAt(i, presetPlayback) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    renderTrack();
    show();

    var track = current();
    if (!track) { hide(); renderPlayButton(); return; }
    var c = client();
    if (!presetPlayback && !c) { notify('Музыкальный сервис недоступен'); return; }
    var p = presetPlayback
      ? Promise.resolve(presetPlayback)
      : c.playback(track.trackId, peekNextId());

    el.bar.classList.add('is-loading');
    el.screen.classList.add('is-loading');

    return p.then(function (info) {
      el.bar.classList.remove('is-loading');
      el.screen.classList.remove('is-loading');
      if (!info || !info.url) throw new Error('Нет ссылки на аудио');
      audio.src = info.url;
      audio.volume = state.volume;
      audio.muted = state.muted;
      return audio.play();
    }).then(function () {
      state.retrying = false;
      state.failStreak = 0;
      prefetchNext();
      save();
    }).catch(function (err) {
      el.bar.classList.remove('is-loading');
      el.screen.classList.remove('is-loading');
      // Автовоспроизведение заблокировано — не ошибка, ждём клика.
      if (err && err.name === 'NotAllowedError') {
        state.playing = false;
        renderPlayButton();
        return;
      }
      if (err && err.type === 'music_auth_required') {
        notify('Подключите Яндекс Музыку в настройках профиля');
      } else {
        notify(err && err.message ? err.message : 'Не удалось воспроизвести трек');
      }
    });
  }

  function peekNextId() {
    var save_ = state.index;
    var ni = nextIndex();
    state.index = save_;
    return ni >= 0 && state.queue[ni] ? state.queue[ni].trackId : null;
  }

  function prefetchNext() {
    var id = peekNextId();
    var c = client();
    if (id && c) c.prefetch([id]);
  }

  /**
   * Подписанная ссылка протухла или сеть моргнула.
   * Берём новую и продолжаем с той же секунды — без видимого сбоя.
   */
  function onAudioError() {
    var track = current();
    var c = client();
    if (!track || !c || state.retrying) return;
    state.retrying = true;

    var at = audio.currentTime || 0;

    c.call('play', { trackId: track.trackId })
      .then(function (info) {
        if (!info || !info.url) throw new Error('no url');
        audio.src = info.url;
        audio.currentTime = at;
        return audio.play();
      })
      .then(function () { state.retrying = false; })
      .catch(function () {
        state.retrying = false;
        // Раньше здесь вызывался next(): при системном сбое ссылок это
        // давало каскад — очередь пролистывалась насквозь за секунды.
        // Теперь останавливаемся на первой же неудаче.
        state.failStreak = (state.failStreak || 0) + 1;
        pause();
        notify(state.failStreak > 1
          ? 'Яндекс Музыка не отдаёт аудио. Проверьте подключение аккаунта в Настройках.'
          : 'Этот трек недоступен для воспроизведения');
      });
  }

  function onEnded() {
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play();
      return;
    }
    next(false);
  }

  /* ------------------------------------------------------------------ команды */

  function play() {
    if (!state.queue.length) return false;
    if (!audio.src) { playAt(state.index < 0 ? 0 : state.index); return true; }
    audio.play().catch(function () { /* noop */ });
    return true;
  }

  function pause() {
    if (!audio || audio.paused) return false;
    audio.pause();
    return true;
  }

  function toggle() {
    if (!state.queue.length) return false;
    return audio.paused ? play() : pause();
  }

  function next(manual) {
    var ni = nextIndex();
    if (ni < 0) {
      pause();
      audio.currentTime = 0;
      return false;
    }
    if (state.repeat === 'one' && manual) {
      ni = (state.index + 1) % state.queue.length;
    }
    playAt(ni);
    return true;
  }

  function prev() {
    if (!state.queue.length) return false;
    // Стандартное поведение плееров: после 3 секунд — в начало трека.
    if (audio.currentTime > 3) { audio.currentTime = 0; return true; }
    var pi = state.index - 1;
    if (pi < 0) pi = state.repeat === 'all' ? state.queue.length - 1 : 0;
    playAt(pi);
    return true;
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    renderModes();
    prefetchNext();
    save();
    return state.shuffle;
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : (state.repeat === 'all' ? 'one' : 'off');
    renderModes();
    save();
    return state.repeat;
  }

  function toggleMute() {
    state.muted = !state.muted;
    audio.muted = state.muted;
    renderVolume();
    save();
    return state.muted;
  }

  function setVolume(delta) {
    state.volume = Math.max(0, Math.min(1, state.volume + delta));
    state.muted = false;
    audio.volume = state.volume;
    audio.muted = false;
    renderVolume();
    save();
    return state.volume;
  }

  function close() {
    pause();
    collapse();
    hide();
    state.queue = [];
    state.index = -1;
    if (audio) audio.removeAttribute('src');
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------- сохранение сессии */

  function writeState() {
    lastSaveAt = Date.now();
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify({
        queue: state.queue.slice(0, 100),
        index: state.index,
        position: audio ? audio.currentTime : 0,
        shuffle: state.shuffle,
        repeat: state.repeat,
        volume: state.volume,
        muted: state.muted,
        collection: state.collection
      }));
    } catch (e) { /* приватный режим или переполнение — не критично */ }
  }

  /**
   * Throttle, а НЕ debounce.
   *
   * save() зовётся на каждый timeupdate (примерно 4 раза в секунду). При
   * debounce таймер каждый раз сбрасывался и запись не происходила вообще,
   * пока трек играет, — после F5 очередь терялась. Throttle пишет не чаще
   * раза в SAVE_DEBOUNCE_MS, но пишет гарантированно.
   */
  function save() {
    var now = Date.now();
    var waited = now - lastSaveAt;
    if (waited >= SAVE_DEBOUNCE_MS) { writeState(); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeState, SAVE_DEBOUNCE_MS - waited);
  }

  /** Восстанавливаем очередь, НО НЕ начинаем играть без действия пользователя. */
  function restore() {
    var raw;
    try { raw = global.localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;

    var s;
    try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || !s.queue || !s.queue.length) return;

    ensureDom();
    // Битые записи (без trackId) — из очереди вон: они убивали play()
    // молчным TypeError на track.trackId.
    state.queue = s.queue.filter(function (t) { return t && t.trackId != null; });
    if (!state.queue.length) return;
    state.index = typeof s.index === 'number' ? s.index : 0;
    // Индекс мог указывать за пределы очереди (старое сохранение) — выравниваем.
    if (state.index < 0 || state.index >= state.queue.length) state.index = 0;
    state.shuffle = Boolean(s.shuffle);
    state.repeat = s.repeat || 'off';
    state.volume = typeof s.volume === 'number' ? s.volume : 1;
    state.muted = Boolean(s.muted);
    state.collection = s.collection || null;

    audio.volume = state.volume;
    audio.muted = state.muted;
    renderVolume();
    renderTrack();
    renderPlayButton();
    show();
    syncLiked();

    // Ссылка берётся лениво — при первом нажатии Play. Позицию помним.
    var pos = Number(s.position) || 0;
    if (pos > 0) {
      var once = function () {
        audio.currentTime = pos;
        audio.removeEventListener('loadedmetadata', once);
      };
      audio.addEventListener('loadedmetadata', once);
    }
  }

  /* ------------------------------------------------- очередь извне

     Экран плейлиста живёт в другом модуле, но очередь и лайки должны
     оставаться общими — иначе сердечки и список разъедутся. */

  /** Любое изменение состояния — сигнал для внешних экранов. */
  function emitChange() {
    try {
      document.dispatchEvent(new CustomEvent('music:state'));
    } catch (e) { /* старый браузер — внешний экран просто не перерисуется сам */ }
  }

  function indexOfTrack(trackId) {
    var key = String(trackId);
    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i] && String(state.queue[i].trackId) === key) return i;
    }
    return -1;
  }

  function isInQueue(trackId) { return indexOfTrack(trackId) >= 0; }

  function queueIds() {
    return state.queue.map(function (t) { return String(t.trackId); });
  }

  function addToQueue(track) {
    if (!track || !track.trackId) return false;
    ensureDom();
    if (isInQueue(track.trackId)) return false;
    state.queue.push(track);

    // Очередь была пуста — значит «добавить» равно «начать слушать»:
    // показывать пустой плеер без звука было бы странно.
    if (state.queue.length === 1 || state.index < 0) {
      show();
      syncLiked();
      playAt(state.queue.length - 1);
    } else {
      renderQueue();
      save();
    }
    emitChange();
    return true;
  }

  function removeFromQueue(trackId) {
    var i = indexOfTrack(trackId);
    if (i < 0) return false;

    if (i !== state.index) {
      state.queue.splice(i, 1);
      if (i < state.index) state.index--;
      renderQueue();
      save();
      emitChange();
      return true;
    }

    // Убираем то, что играет: либо переходим к следующему, либо закрываемся.
    state.queue.splice(i, 1);
    if (!state.queue.length) { close(); emitChange(); return true; }
    if (state.index >= state.queue.length) state.index = 0;
    playAt(state.index);
    emitChange();
    return true;
  }

  function isTrackLiked(trackId) {
    return Boolean(state.liked && state.liked.has(String(trackId)));
  }

  /**
   * Лайк не только текущего трека: в плейлисте сердечко ставят строкам,
   * которые сейчас не играют. Логика та же, что у toggleLike: сначала UI,
   * потом сервер, при ошибке — честный откат.
   */
  function likeTrack(track, force) {
    var c = client();
    var id = String((track && track.trackId) ? track.trackId : (track || ''));
    if (!id || !c) return false;

    if (!state.liked) state.liked = new Set();
    var want = typeof force === 'boolean' ? force : !state.liked.has(id);

    if (want) state.liked.add(id); else state.liked.delete(id);
    renderLike();
    emitChange();

    c.like(id, want).then(function () {
      if (typeof c.forgetLiked === 'function') c.forgetLiked();
      notify(want ? 'Добавлено в избранное Яндекс.Музыки' : 'Убрано из избранного');
    }).catch(function (e) {
      if (want) state.liked.delete(id); else state.liked.add(id);
      renderLike();
      emitChange();
      if (e && e.type === 'music_auth_required') {
        notify('Чтобы лайк попал в вашу Яндекс.Музыку, подключите аккаунт Яндекса в настройках.');
      } else {
        notify('Не удалось изменить избранное');
      }
    });
    return want;
  }

  /* ------------------------------------------------------------------ экспорт */

  global.MusicPlayer = {
    setQueue: setQueue,
    playAt: playAt,
    play: play,
    pause: pause,
    toggle: toggle,
    next: next,
    prev: prev,
    toggleShuffle: toggleShuffle,
    cycleRepeat: cycleRepeat,
    toggleMute: toggleMute,
    setVolume: setVolume,
    close: close,
    restore: restore,
    expand: expand,
    collapse: collapse,
    like: toggleLike,
    likeTrack: likeTrack,
    isTrackLiked: isTrackLiked,
    addToQueue: addToQueue,
    removeFromQueue: removeFromQueue,
    isInQueue: isInQueue,
    queueIds: queueIds,
    syncLiked: syncLiked,
    isActive: function () { return state.queue.length > 0; },
    isPlaying: function () { return state.playing; },
    isExpanded: function () { return state.expanded; },
    currentTrack: current,
    isLiked: function () {
      var t = current();
      return Boolean(t && state.liked && state.liked.has(String(t.trackId)));
    },
    getState: function () { return JSON.parse(JSON.stringify({
      index: state.index, playing: state.playing, shuffle: state.shuffle,
      repeat: state.repeat, count: state.queue.length, expanded: state.expanded
    })); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }

})(typeof window !== 'undefined' ? window : globalThis);
