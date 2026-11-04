/* ============================================================================
   LIQUID GLASS — анимации в духе iOS 27 (только телефон).

   • html.hm-glass — включает стеклянные стили (css/hm-glass.css) в мобильной
     раскладке; на ПК ничего не меняется.
   • Кнопки при нажатии «набухают» и светлеют, при отпускании пружинят.
   • Меню «вытекает» из кнопки, которой его открыли, стеклянной каплей:
     сжатая размытая форма кнопки растягивается в панель с лёгким перелётом,
     содержимое проявляется из размытия. При закрытии — обратно в кнопку
     (рисует «призрак» панели, поэтому функции закрытия менять не нужно).
   • Палец можно вести по пунктам меню, не отпуская: пункт под пальцем
     подсвечивается, отпустил — пункт срабатывает.
   Панели и кнопки определяются по существующим классам; меню находятся
   наблюдателем DOM (MutationObserver), без правок в коде каждого меню.
   ========================================================================== */
(function () {
  'use strict';
  var MQ = '(max-width:768px), (hover:none) and (pointer:coarse)';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia(MQ) : null;
  function sync() { root.classList.toggle('hm-glass', Boolean(mq && mq.matches)); }
  sync();
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', sync); else if (mq.addListener) mq.addListener(sync); }
  function on() { return root.classList.contains('hm-glass'); }
  function still() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  var PANEL = '.chat-menu-pop,.chat-ctx-menu,.hm-pm,.hm-plus,.more-menu';
  var ITEM = '.cmp-item,.chat-ctx-item,.hm-pm button,.hm-plus button,.more-menu .more-item';
  var SWELL = '.topbar-btn,.m-model-btn,.bar-icon,.send-btn,.msg-actions button';

  /* ------------------------------------------------------------ нажатие */
  var pressed = null, lastAnchor = null, lastAnchorAt = 0;
  document.addEventListener('pointerdown', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('button,.msg-user,.msg-user-wrap,.sb-chat-item,[role="button"]');
    if (a && !a.closest(PANEL)) { lastAnchor = a; lastAnchorAt = Date.now(); }
    if (!on()) return;
    var b = t.closest(SWELL);
    if (!b || b.disabled) return;
    pressed = b;
    b.classList.add('hm-g-swell', 'hm-g-down');
  }, { capture: true, passive: true });
  function release() {
    if (!pressed) return;
    var b = pressed; pressed = null;
    b.classList.remove('hm-g-down');
  }
  ['pointerup', 'pointercancel', 'blur'].forEach(function (n) { (n === 'blur' ? window : document).addEventListener(n, release, { capture: true, passive: true }); });

  /* ------------------------------------------------------------ капля */
  function anchorFor(p) {
    if (p.id === 'chatMenuPop') return document.getElementById('chatMenuBtn');
    if (p.id === 'hmPlusMenu') return document.querySelector('.plus-btn-wrap .bar-icon');
    if (p.classList.contains('more-menu') && p.previousElementSibling) return p.previousElementSibling;
    if (lastAnchor && lastAnchor.isConnected && Date.now() - lastAnchorAt < 1500) return lastAnchor;
    return null;
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
  /* Кадры «из кнопки в панель»: позиция и размер кнопки, круглые углы и
     размытие → панель. Неравномерный масштаб даёт эффект капли. */
  function blob(r, a, radius) {
    if (!r.width || !r.height) return null;
    var from;
    if (a && a.width && a.height) {
      var sx = Math.max(0.06, a.width / r.width), sy = Math.max(0.06, a.height / r.height);
      var dx = (a.left + a.width / 2) - (r.left + r.width / 2), dy = (a.top + a.height / 2) - (r.top + r.height / 2);
      from = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    } else {
      from = 'scale(.55)';
    }
    return [
      { transformOrigin: '50% 50%', transform: from, borderRadius: '999px', filter: 'blur(9px)', opacity: 0.55 },
      { transformOrigin: '50% 50%', offset: 0.55, filter: 'blur(1.5px)', opacity: 1 },
      { transformOrigin: '50% 50%', transform: 'translate(0,0) scale(1,1)', borderRadius: radius, filter: 'blur(0px)', opacity: 1 }
    ];
  }
  function openPanel(p) {
    if (p.__hmOpen) return;
    p.__hmOpen = true;
    p.__hmAnchor = anchorFor(p);
    var cs = getComputedStyle(p);
    p.__hmRadius = cs.borderRadius || '24px';
    p.__hmDisplay = cs.display === 'none' ? 'block' : cs.display;
    p.__hmRect = rectOf(p);
    if (!on() || still() || !p.animate) return;
    var a = p.__hmAnchor && p.__hmAnchor.isConnected ? rectOf(p.__hmAnchor) : null;
    var frames = blob(p.__hmRect, a, p.__hmRadius);
    if (!frames) return;
    try {
      // Пока капля летит от кнопки, панель может оказаться под пальцем —
      // не даём случайному «клику» (после долгого нажатия) попасть в пункт.
      p.classList.add('hm-g-opening');
      setTimeout(function () { p.classList.remove('hm-g-opening'); }, 300);
      p.animate(frames, { duration: 520, easing: 'cubic-bezier(.2,1.2,.32,1)' });
      Array.prototype.forEach.call(p.children, function (c) {
        c.animate([{ opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)' }], { duration: 340, delay: 110, easing: 'ease-out', fill: 'backwards' });
      });
    } catch (e) { /* без анимации */ }
  }
  function closePanel(p) {
    if (!p.__hmOpen) return;
    p.__hmOpen = false;
    var r = p.__hmRect;
    if (!on() || still() || !r || !document.body.animate) return;
    var a = p.__hmAnchor && p.__hmAnchor.isConnected ? rectOf(p.__hmAnchor) : null;
    var frames = blob(r, a, p.__hmRadius);
    if (!frames) return;
    var g = p.cloneNode(true);
    g.removeAttribute('id');
    Array.prototype.forEach.call(g.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
    g.classList.remove('hm-g-opening', 'hm-g-hot');
    g.classList.add('open', 'hm-g-ghost');
    g.setAttribute('aria-hidden', 'true');
    var st = g.style;
    st.left = r.left + 'px'; st.top = r.top + 'px'; st.width = r.width + 'px'; st.height = r.height + 'px';
    st.right = 'auto'; st.bottom = 'auto'; st.transform = 'none'; st.opacity = '1'; st.visibility = 'visible';
    st.display = p.__hmDisplay || 'block'; st.maxHeight = 'none';
    document.body.appendChild(g);
    var out = frames.slice().reverse().map(function (f, i) { var o = Object.assign({}, f); delete o.offset; if (i === 1) o.offset = 0.45; return o; });
    out[out.length - 1].opacity = 0;
    var done = function () { if (g.parentNode) g.parentNode.removeChild(g); };
    try { g.animate(out, { duration: 340, easing: 'cubic-bezier(.45,0,.7,.4)', fill: 'forwards' }).onfinish = done; } catch (e) { done(); }
    setTimeout(done, 900);
  }

  var mo = new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'attributes') {
        var el = m.target;
        if (!el.matches || !el.matches(PANEL) || el.classList.contains('hm-g-ghost')) continue;
        var was = /(?:^|\s)open(?:\s|$)/.test(m.oldValue || ''), now = el.classList.contains('open');
        if (now && !was) openPanel(el); else if (!now && was) closePanel(el);
      } else {
        for (var j = 0; j < m.removedNodes.length; j++) {
          var n = m.removedNodes[j];
          if (n.nodeType === 1 && n.__hmOpen && n.matches && n.matches(PANEL)) closePanel(n);
        }
      }
    }
  });
  function startObserver() { mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] }); }
  if (document.body) startObserver(); else document.addEventListener('DOMContentLoaded', startObserver);

  /* ------------------------------------------------------------ палец по меню */
  var drag = null;
  function hot(it) {
    if (!drag || drag.hot === it) return;
    if (drag.hot) drag.hot.classList.remove('hm-g-hot');
    drag.hot = it;
    if (it) it.classList.add('hm-g-hot');
  }
  document.addEventListener('pointerdown', function (e) {
    if (!on() || e.pointerType !== 'touch' || !e.target.closest) return;
    var panel = e.target.closest(PANEL);
    if (!panel) return;
    drag = { panel: panel, start: e.target.closest(ITEM), hot: null };
    hot(drag.start);
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var it = el && el.closest ? el.closest(ITEM) : null;
    hot(it && drag.panel.contains(it) ? it : null);
  }, { passive: true });
  function endDrag(e) {
    if (!drag) return;
    var h = drag.hot, s = drag.start;
    hot(null);
    drag = null;
    // Палец съехал на другой пункт и отпущен на нём — нажимаем этот пункт.
    if (e && e.type === 'pointerup' && h && h !== s && !h.disabled && h.isConnected) setTimeout(function () { h.click(); }, 0);
  }
  document.addEventListener('pointerup', endDrag, { capture: true, passive: true });
  document.addEventListener('pointercancel', function () { if (drag) { hot(null); drag = null; } }, { capture: true, passive: true });

  window.HmGlass = { enabled: on, open: openPanel, close: closePanel };
})();
