/* ===== АНИМАЦИЯ ОЖИДАНИЯ: ОБЛАКО ЧАСТИЦ ==================================
   Частицы собираются в фигуры и рассыпаются обратно, полный цикл — 18 секунд:

     шары(долго) → круг → шары(долго) → 3D-сфера → шары(долго) → нота → повтор

   «Шары» (бесформенное облако) держатся дольше остальных — это фаза «нет
   фигуры». Каждая именованная фигура появляется, недолго держится и плавно
   рассыпается обратно в облако. Математика фигур и тайминги — как в исходном
   наброске, менять их на глаз не нужно: числа подобраны друг под друга.

   Модуль сам ничего не запускает. Чат вызывает hmThinkLoader.mount(элемент)
   в showTyping() и handle.stop() в hideTyping(); если #typEl удалили в обход
   hideTyping (стоп, ошибка, обрыв потока), цикл кадров замечает, что холст
   больше не в документе, и останавливается сам — брошенного
   requestAnimationFrame после себя не оставляем.

   Цвет берём из переменной --text текущей темы, поэтому облако одинаково
   читается и на тёмном, и на светлом фоне (см. inkOf).
   ========================================================================= */
(function () {
  'use strict';

  /* ===== НАСТРОЙКИ ===== */
  var N = 90;              // количество частиц
  var BASE_DESIGN = 260;   // система координат, в которой описаны фигуры

  // Распределение частиц по частям ноты: головка, штиль, остальное — флажок.
  var NOTE_HEAD_N = Math.round(N * 0.30);
  var NOTE_STEM_N = Math.round(N * 0.20);

  // У каждой частицы свой «характер»: размер, яркость, фаза дрожания.
  function makeParticles() {
    var arr = [];
    for (var i = 0; i < N; i++) {
      arr.push({
        a1: Math.random(),
        a2: Math.random(),
        size: 1.8 + Math.pow(Math.random(), 2) * 3,
        alpha: 0.5 + Math.random() * 0.5,
        jphase: Math.random() * Math.PI * 2
      });
    }
    return arr;
  }

  /* ===== ФУНКЦИИ ФОРМ =====
     Каждая принимает частицу p, её индекс i и время t (сек) и возвращает
     { x, y, r, alpha } в локальных координатах (центр — 0,0). */

  // «Шары» — рыхлое рассеянное облако (состояние «нет фигуры»).
  function scatterPos(p, i, t) {
    var angle = p.a1 * Math.PI * 2;
    var wobble = 1 + 0.22 * Math.sin(3 * angle + p.jphase) + 0.13 * Math.sin(5 * angle - p.jphase * 1.7);
    var rad = Math.sqrt(p.a2) * 78 * wobble;
    var x = Math.cos(angle) * rad;
    var y = Math.sin(angle) * rad;
    x += Math.sin(t * 1.4 + p.jphase) * 2.5;
    y += Math.cos(t * 1.1 + p.jphase * 1.3) * 2.5;
    return { x: x, y: y, r: p.size, alpha: p.alpha };
  }

  // «Круг» — кольцо из частиц, медленно вращается.
  function circlePos(p, i, t) {
    var angle = (i / N) * Math.PI * 2 + t * 0.25 + (p.a1 - 0.5) * 0.15;
    var rad = 90 + (p.a2 - 0.5) * 10;
    return {
      x: Math.cos(angle) * rad,
      y: Math.sin(angle) * rad,
      r: p.size,
      alpha: p.alpha
    };
  }

  // «3D-сфера» — точки по сфере Фибоначчи, вращение + затенение по глубине.
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  function spherePos(p, i, t) {
    var yN = 1 - (i / (N - 1)) * 2;
    var radAtY = Math.sqrt(Math.max(0, 1 - yN * yN));
    var theta = GOLDEN_ANGLE * i + t * 0.6;
    var xs = Math.cos(theta) * radAtY;
    var zs = Math.sin(theta) * radAtY;
    var R = 82;
    var depth = (zs + 1) / 2; // 0 = дальняя сторона, 1 = ближняя
    return {
      x: xs * R,
      y: yN * R,
      r: p.size * (0.55 + 0.85 * depth),
      alpha: p.alpha * (0.3 + 0.7 * depth)
    };
  }

  /* ---- кривая Безье: из неё сделан флажок ноты ---- */
  function bezierPoint(t, x0, y0, x1, y1, x2, y2, x3, y3) {
    var mt = 1 - t;
    var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
  }
  function bezierTangent(t, x0, y0, x1, y1, x2, y2, x3, y3) {
    var mt = 1 - t;
    var dx = 3 * mt * mt * (x1 - x0) + 6 * mt * t * (x2 - x1) + 3 * t * t * (x3 - x2);
    var dy = 3 * mt * mt * (y1 - y0) + 6 * mt * t * (y2 - y1) + 3 * t * t * (y3 - y2);
    return { dx: dx, dy: dy };
  }
  // Толщина флажка: нарастает от штиля к «брюшку», затем сужается в кончик.
  function flagThickness(t) {
    var rise = Math.min(t / 0.35, 1);
    var fall = Math.max(0, (t - 0.35) / 0.65);
    var bulge = 10 + 20 * Math.sin(rise * Math.PI / 2);
    return Math.max(2, bulge * (1 - Math.pow(fall, 1.4)));
  }

  // «Нота» (восьмая ♪) — крупная головка + толстый штиль + изогнутый флажок.
  var HEAD_CX = -6, HEAD_CY = 52, HEAD_RX = 22, HEAD_RY = 16, HEAD_TILT = -0.32;
  var STEM_X = 15, STEM_TOP_Y = -66, STEM_BOT_Y = 40, STEM_HALF_W = 5.5;
  // Контрольные точки флажка (кубическая кривая Безье), крючком назад.
  var F0X = STEM_X, F0Y = STEM_TOP_Y;
  var F1X = STEM_X + 42, F1Y = STEM_TOP_Y - 2;
  var F2X = STEM_X + 68, F2Y = STEM_TOP_Y + 39;
  var F3X = STEM_X + 36, F3Y = STEM_TOP_Y + 78;

  function notePos(p, i, t) {
    if (i < NOTE_HEAD_N) {
      var ang = p.a1 * Math.PI * 2;
      var rad = Math.sqrt(p.a2);
      var lx = Math.cos(ang) * rad * HEAD_RX;
      var ly = Math.sin(ang) * rad * HEAD_RY;
      var rx = lx * Math.cos(HEAD_TILT) - ly * Math.sin(HEAD_TILT);
      var ry = lx * Math.sin(HEAD_TILT) + ly * Math.cos(HEAD_TILT);
      return { x: HEAD_CX + rx, y: HEAD_CY + ry, r: p.size, alpha: p.alpha };
    }

    if (i < NOTE_HEAD_N + NOTE_STEM_N) {
      return {
        x: STEM_X + (p.a2 - 0.5) * STEM_HALF_W * 2,
        y: STEM_BOT_Y + (STEM_TOP_Y - STEM_BOT_Y) * p.a1,
        r: p.size * 0.85,
        alpha: p.alpha
      };
    }

    var tt = p.a1;
    var pt = bezierPoint(tt, F0X, F0Y, F1X, F1Y, F2X, F2Y, F3X, F3Y);
    var tan = bezierTangent(tt, F0X, F0Y, F1X, F1Y, F2X, F2Y, F3X, F3Y);
    var len = Math.hypot(tan.dx, tan.dy) || 1;
    var nx = -tan.dy / len, ny = tan.dx / len;
    var offset = (p.a2 - 0.5) * flagThickness(tt);
    return { x: pt.x + nx * offset, y: pt.y + ny * offset, r: p.size * 0.85, alpha: p.alpha };
  }

  /* ===== ТАЙМЛАЙН =====
     «Шары» держатся дольше остальных фигур, полный цикл — 18 секунд. */
  var keyframes = [
    { shape: scatterPos, hold: 2.2 },
    { shape: circlePos,  hold: 1.4 },
    { shape: scatterPos, hold: 2.2 },
    { shape: spherePos,  hold: 1.4 },
    { shape: scatterPos, hold: 2.2 },
    { shape: notePos,    hold: 1.4 }
  ];
  var TRANSITION = 1.2; // длительность перехода между формами

  var segments = [];
  for (var k = 0; k < keyframes.length; k++) {
    segments.push({ type: 'hold', shape: keyframes[k].shape, dur: keyframes[k].hold });
    var nextShape = keyframes[(k + 1) % keyframes.length].shape;
    segments.push({ type: 'trans', from: keyframes[k].shape, to: nextShape, dur: TRANSITION });
  }
  var _acc = 0;
  for (var s0 = 0; s0 < segments.length; s0++) { segments[s0].start = _acc; _acc += segments[s0].dur; }
  var LOOP_DURATION = _acc; // 18 секунд

  // Кадр, который показываем, когда человек попросил меньше движения:
  // середина удержания «круга» — узнаваемая фигура без анимации.
  var STILL_T = 4.1;

  function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  /* ===== ЦВЕТ ПОД ТЕМУ =====
     Берём --text активной темы: в тёмной это белый и складывается в свечение
     (режим lighter), в светлых темах — почти чёрный, и там additive-режим не
     годится (он умеет только осветлять), поэтому рисуем обычным source-over. */
  var inkCache = { theme: null, rgb: '255,255,255', mode: 'lighter' };
  function inkOf() {
    var theme = document.documentElement.getAttribute('data-theme') || 'dark';
    if (inkCache.theme === theme) return inkCache;
    var rgb = '255,255,255';
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
      var m = /^#([0-9a-f]{6})$/i.exec(raw);
      if (m) {
        var v = parseInt(m[1], 16);
        rgb = ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255);
      } else {
        var m2 = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(raw);
        if (m2) rgb = m2[1] + ',' + m2[2] + ',' + m2[3];
      }
    } catch (e) {}
    inkCache = { theme: theme, rgb: rgb, mode: theme === 'dark' ? 'lighter' : 'source-over' };
    return inkCache;
  }

  // Размер холста: облако — не иконка, но и не полстраницы. На узких экранах
  // меньше, чтобы строка «Думаю» не улетала под край.
  function orbSize() {
    var w = window.innerWidth || 1024;
    return w <= 600 ? 86 : 108;
  }

  /* ===== ЗАПУСК =====
     mount(host) добавляет холст внутрь host и возвращает { stop }.
     Повторный stop() безопасен. */
  function mount(host, opts) {
    if (!host || !host.appendChild) return null;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    canvas.className = 'hmThinkOrb';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);

    var particles = makeParticles();
    var fixed = opts && opts.size;
    var SIZE = fixed || orbSize();
    var raf = 0, stopped = false, t0 = 0;

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      SIZE = fixed || orbSize();
      canvas.width = Math.round(SIZE * dpr);
      canvas.height = Math.round(SIZE * dpr);
      canvas.style.width = SIZE + 'px';
      canvas.style.height = SIZE + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(t) {
      var loopT = t % LOOP_DURATION;

      var seg = segments[segments.length - 1];
      for (var s = 0; s < segments.length; s++) {
        if (loopT >= segments[s].start && loopT < segments[s].start + segments[s].dur) {
          seg = segments[s];
          break;
        }
      }

      var fnA, fnB, eased;
      if (seg.type === 'hold') {
        fnA = fnB = seg.shape;
        eased = 0;
      } else {
        fnA = seg.from;
        fnB = seg.to;
        eased = easeInOutCubic((loopT - seg.start) / seg.dur);
      }

      var scale = SIZE / BASE_DESIGN;
      var cx = SIZE / 2, cy = SIZE / 2;
      var ink = inkOf();

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = ink.mode;

      for (var i = 0; i < N; i++) {
        var p = particles[i];
        var a = fnA(p, i, t);
        var b = fnB(p, i, t);

        var x = (a.x + (b.x - a.x) * eased) * scale + cx;
        var y = (a.y + (b.y - a.y) * eased) * scale + cy;
        var r = (a.r + (b.r - a.r) * eased) * scale;
        var alpha = a.alpha + (b.alpha - a.alpha) * eased;
        if (r <= 0) continue;

        var grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
        grad.addColorStop(0, 'rgba(' + ink.rgb + ',' + alpha + ')');
        grad.addColorStop(0.45, 'rgba(' + ink.rgb + ',' + (alpha * 0.45) + ')');
        grad.addColorStop(1, 'rgba(' + ink.rgb + ',0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('resize', resize);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    function frame(now) {
      if (stopped) return;
      // Холст убрали вместе с #typEl — дальше крутить кадры незачем.
      if (!canvas.isConnected) { stop(); return; }
      if (!t0) t0 = now;
      draw((now - t0) / 1000);
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);

    var still = false;
    try {
      still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {}

    if (still) {
      draw(STILL_T);
      return { stop: stop, canvas: canvas, still: true };
    }

    raf = requestAnimationFrame(frame);
    return { stop: stop, canvas: canvas, still: false };
  }

  window.hmThinkLoader = { mount: mount, LOOP_DURATION: LOOP_DURATION };
})();
