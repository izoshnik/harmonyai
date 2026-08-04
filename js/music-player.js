/* ============================================================================
   HarmonyAI — глобальный плеер.

   Принципы:
     • Один <audio> на весь сайт. Переход между чатами не рвёт звук.
     • Подписанная ссылка протухает — при ошибке молча берём новую и продолжаем
       С ТОГО ЖЕ МЕСТА. Пользователь ничего не замечает.
     • Следующий трек всегда прогрет заранее → «далее» без паузы.
     • MediaSession: обложка и кнопки в шторке телефона и на локскрине.
     • Состояние в localStorage — после F5 очередь на месте.
   ========================================================================== */

(function (global) {
  'use strict';

  var STORE_KEY = 'hm_music_player_v1';
  var SAVE_DEBOUNCE_MS = 1200;

  var el = {};
  var audio = null;
  var saveTimer = null;

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
    failStreak: 0
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

  /* ------------------------------------------------------------------ разметка */

  function ensureDom() {
    if (el.bar) return;

    var bar = document.getElementById('musicPlayerBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'musicPlayerBar';
      // Плеер живёт ВНУТРИ колонки чата: вставляем его в #main перед .chat-area,
      // т.е. сразу под топбаром с кнопкой выбора модели. Он не fixed-панель
      // на весь экран, не выходит за рамки чата и не перекрывает поле ввода.
      var main = document.getElementById('main');
      var chatArea = document.getElementById('chatArea');
      if (main && chatArea) main.insertBefore(bar, chatArea);
      else if (main) main.appendChild(bar);
      else document.body.appendChild(bar);
    }

    bar.className = 'music-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Музыкальный плеер');
    bar.innerHTML = [
      '<div class="music-bar__progress" id="mbProgress" role="slider" tabindex="0"',
      '     aria-label="Перемотка" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">',
      '  <div class="music-bar__buffered" id="mbBuffered"></div>',
      '  <div class="music-bar__played" id="mbPlayed"></div>',
      '  <div class="music-bar__thumb" id="mbThumb"></div>',
      '</div>',
      '<div class="music-bar__body">',
      '  <img class="music-bar__cover" id="mbCover" alt="" />',
      '  <div class="music-bar__meta">',
      '    <div class="music-bar__title" id="mbTitle"></div>',
      '    <div class="music-bar__artist" id="mbArtist"></div>',
      '  </div>',
      '  <div class="music-bar__controls">',
      '    <button class="music-btn" id="mbShuffle" title="Вперемешку" aria-label="Вперемешку">⇄</button>',
      '    <button class="music-btn" id="mbPrev" title="Предыдущий" aria-label="Предыдущий">⏮</button>',
      '    <button class="music-btn music-btn--main" id="mbPlay" title="Воспроизвести" aria-label="Воспроизвести">▶</button>',
      '    <button class="music-btn" id="mbNext" title="Следующий" aria-label="Следующий">⏭</button>',
      '    <button class="music-btn" id="mbRepeat" title="Повтор" aria-label="Повтор">↻</button>',
      '  </div>',
      '  <div class="music-bar__time"><span id="mbCur">0:00</span> / <span id="mbDur">0:00</span></div>',
      '  <div class="music-bar__right">',
      '    <button class="music-btn" id="mbMute" title="Звук" aria-label="Звук">♫</button>',
      '    <input class="music-vol" id="mbVol" type="range" min="0" max="100" value="100" aria-label="Громкость" />',
      '    <button class="music-btn" id="mbQueueBtn" title="Очередь" aria-label="Очередь">☰</button>',
      '    <button class="music-btn" id="mbClose" title="Закрыть" aria-label="Закрыть">✕</button>',
      '  </div>',
      '</div>',
      '<div class="music-queue" id="mbQueue" hidden></div>'
    ].join('');

    el.bar = bar;
    el.cover = bar.querySelector('#mbCover');
    el.title = bar.querySelector('#mbTitle');
    el.artist = bar.querySelector('#mbArtist');
    el.play = bar.querySelector('#mbPlay');
    el.prev = bar.querySelector('#mbPrev');
    el.next = bar.querySelector('#mbNext');
    el.shuffle = bar.querySelector('#mbShuffle');
    el.repeat = bar.querySelector('#mbRepeat');
    el.progress = bar.querySelector('#mbProgress');
    el.played = bar.querySelector('#mbPlayed');
    el.buffered = bar.querySelector('#mbBuffered');
    el.thumb = bar.querySelector('#mbThumb');
    el.cur = bar.querySelector('#mbCur');
    el.dur = bar.querySelector('#mbDur');
    el.vol = bar.querySelector('#mbVol');
    el.mute = bar.querySelector('#mbMute');
    el.queueBtn = bar.querySelector('#mbQueueBtn');
    el.queue = bar.querySelector('#mbQueue');
    el.close = bar.querySelector('#mbClose');

    audio = document.createElement('audio');
    audio.id = 'musicAudio';
    audio.preload = 'auto';
    // ВАЖНО: crossOrigin НЕ задаём. Хосты Яндекса, отдающие mp3-поток, не
    // присылают CORS-заголовки; с crossOrigin='anonymous' браузер БЛОКИРУЕТ
    // загрузку аудио, и трек не играет вообще (в этом и была причина сбоя).
    // Без атрибута файл грузится как обычный медиа-ресурс (no-cors).
    document.body.appendChild(audio);

    bindEvents();
  }

  /* ------------------------------------------------------------------ события */

  function bindEvents() {
    el.play.addEventListener('click', toggle);
    el.next.addEventListener('click', function () { next(true); });
    el.prev.addEventListener('click', prev);
    el.shuffle.addEventListener('click', toggleShuffle);
    el.repeat.addEventListener('click', cycleRepeat);
    el.close.addEventListener('click', close);
    el.mute.addEventListener('click', toggleMute);
    el.queueBtn.addEventListener('click', toggleQueue);

    el.vol.addEventListener('input', function () {
      state.volume = Number(el.vol.value) / 100;
      state.muted = state.volume === 0;
      audio.volume = state.volume;
      audio.muted = state.muted;
      renderVolume();
      save();
    });

    el.progress.addEventListener('click', function (ev) {
      if (!audio.duration) return;
      var rect = el.progress.getBoundingClientRect();
      var ratio = (ev.clientX - rect.left) / rect.width;
      audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
    });

    el.progress.addEventListener('keydown', function (ev) {
      if (!audio.duration) return;
      if (ev.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); ev.preventDefault(); }
      if (ev.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); ev.preventDefault(); }
    });

    audio.addEventListener('timeupdate', renderProgress);
    audio.addEventListener('progress', renderBuffered);
    audio.addEventListener('durationchange', renderProgress);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onAudioError);

    audio.addEventListener('play', function () {
      state.playing = true; renderPlayButton(); setMediaState('playing');
    });
    audio.addEventListener('pause', function () {
      state.playing = false; renderPlayButton(); setMediaState('paused'); save();
    });

    // Пробел — пауза, но только вне полей ввода.
    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space' || !state.queue.length) return;
      var t = ev.target;
      var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
      ev.preventDefault();
      toggle();
    });
  }

  /* -------------------------------------------------------------- MediaSession */

  function setMediaMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new global.MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: track.cover ? [
          { src: track.cover, sizes: '400x400', type: 'image/jpeg' }
        ] : []
      });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('nexttrack', function () { next(true); });
      navigator.mediaSession.setActionHandler('previoustrack', prev);
    } catch (e) { /* noop */ }
  }

  function setMediaState(s) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = s; } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------------ отрисовка */

  function renderPlayButton() {
    el.play.textContent = state.playing ? '⏸' : '▶';
    el.play.title = state.playing ? 'Пауза' : 'Воспроизвести';
    el.play.setAttribute('aria-label', el.play.title);
    el.bar.classList.toggle('is-playing', state.playing);
  }

  function renderProgress() {
    var d = audio.duration || 0;
    var c = audio.currentTime || 0;
    var pct = d ? (c / d) * 100 : 0;
    el.played.style.width = pct + '%';
    el.thumb.style.left = pct + '%';
    el.cur.textContent = fmtTime(c);
    el.dur.textContent = fmtTime(d);
    el.progress.setAttribute('aria-valuenow', String(Math.round(pct)));

    // За 15 секунд до конца греем следующий трек.
    if (d && d - c < 15 && d - c > 13) prefetchNext();

    save();
  }

  function renderBuffered() {
    try {
      if (!audio.buffered.length || !audio.duration) return;
      var end = audio.buffered.end(audio.buffered.length - 1);
      el.buffered.style.width = ((end / audio.duration) * 100) + '%';
    } catch (e) { /* noop */ }
  }

  function renderVolume() {
    el.vol.value = String(Math.round((state.muted ? 0 : state.volume) * 100));
    el.mute.textContent = (state.muted || state.volume === 0) ? '✕' : '♫';
  }

  function renderTrack() {
    var t = current();
    if (!t) return;
    el.title.textContent = t.title || '';
    el.artist.textContent = t.artist || '';
    if (t.cover) { el.cover.src = t.cover; el.cover.style.visibility = 'visible'; }
    else { el.cover.removeAttribute('src'); el.cover.style.visibility = 'hidden'; }
    el.shuffle.classList.toggle('is-active', state.shuffle);
    el.repeat.classList.toggle('is-active', state.repeat !== 'off');
    el.repeat.textContent = state.repeat === 'one' ? '↺' : '↻';
    setMediaMetadata(t);
    renderQueue();
  }

  function renderQueue() {
    if (el.queue.hidden) return;
    el.queue.innerHTML = state.queue.map(function (t, i) {
      return '<button class="music-queue__row' + (i === state.index ? ' is-current' : '') +
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
    playAt(typeof startAt === 'number' ? startAt : 0, playback);
  }

  function playAt(i, presetPlayback) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    renderTrack();
    show();

    var track = current();
    var p = presetPlayback
      ? Promise.resolve(presetPlayback)
      : global.MusicClient.playback(track.trackId, peekNextId());

    el.bar.classList.add('is-loading');

    return p.then(function (info) {
      el.bar.classList.remove('is-loading');
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
      // Автовоспроизведение заблокировано — не ошибка, ждём клика.
      if (err && err.name === 'NotAllowedError') {
        state.playing = false;
        renderPlayButton();
        return;
      }
      notify(err && err.message ? err.message : 'Не удалось воспроизвести трек');
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
    if (id) global.MusicClient.prefetch([id]);
  }

  /**
   * Подписанная ссылка протухла или сеть моргнула.
   * Берём новую и продолжаем с той же секунды — без видимого сбоя.
   */
  function onAudioError() {
    var track = current();
    if (!track || state.retrying) return;
    state.retrying = true;

    var at = audio.currentTime || 0;

    global.MusicClient.call('play', { trackId: track.trackId })
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
    el.shuffle.classList.toggle('is-active', state.shuffle);
    prefetchNext();
    save();
    return state.shuffle;
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : (state.repeat === 'all' ? 'one' : 'off');
    el.repeat.classList.toggle('is-active', state.repeat !== 'off');
    el.repeat.textContent = state.repeat === 'one' ? '↺' : '↻';
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

  function toggleQueue() {
    el.queue.hidden = !el.queue.hidden;
    el.bar.classList.toggle('is-queue-open', !el.queue.hidden);
    renderQueue();
  }

  function close() {
    pause();
    hide();
    state.queue = [];
    state.index = -1;
    audio.removeAttribute('src');
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) { /* noop */ }
  }

  function notify(msg) {
    if (typeof global.showToast === 'function') { global.showToast(msg); return; }
    console.warn('[music]', msg);
  }

  /* ---------------------------------------------------------- сохранение сессии */

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
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
      } catch (e) { /* noop */ }
    }, SAVE_DEBOUNCE_MS);
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
    state.queue = s.queue;
    state.index = typeof s.index === 'number' ? s.index : 0;
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
    isActive: function () { return state.queue.length > 0; },
    isPlaying: function () { return state.playing; },
    currentTrack: current,
    getState: function () { return JSON.parse(JSON.stringify({
      index: state.index, playing: state.playing, shuffle: state.shuffle,
      repeat: state.repeat, count: state.queue.length
    })); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }

})(typeof window !== 'undefined' ? window : globalThis);
