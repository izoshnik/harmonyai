/* ============================================================================
   HarmonyAI — «@ Плагины» в строке ввода (как в ChatGPT).

   Пользователь пишет «@» (или выбирает «Плагины» в меню «+») — над строкой
   ввода появляется список плагинов с логотипами. Выбор вставляет в поле
   «@Яндекс Музыка », «@YouTube » или «@Rutube », и сообщение уходит прямо в
   этот плагин. Без «@» ИИ по-прежнему сам решает по смыслу, какой плагин нужен.

   API: window.HmMentions = { open(), close(), parse(text) → {plugin, rest} | null }
   ============================================================================ */
(function (global) {
  'use strict';

  var LOGOS = {
    yandex: '<svg viewBox="0 0 36 36" aria-hidden="true"><g fill="#FFD400"><path d="M18 0l2.2 10.1L26.5 2l-2.9 10 9.1-5.1-7.5 7.1L36 14.7l-10.6 2.2L35 21.4l-10.8-1 7.4 7.9-9.2-5.7 3 10.4-6.4-8.7L18 36l-2.2-10.7L9.5 34l2.9-10.5-9.1 5.6 7.5-7.6L0 20.5l10.7-2.1L1 14l10.8.8-7.4-7.6 9.1 5.3L10.6 2l6.3 8.7L18 0z"/><circle cx="18" cy="18" r="5.2"/></g></svg>',
    youtube: '<svg viewBox="0 0 36 36" aria-hidden="true"><rect x="2" y="7" width="32" height="22" rx="7" fill="#FF0033"/><path d="M15 12.8v10.4c0 .6.7 1 1.2.7l8.2-5.2a.8.8 0 0 0 0-1.4l-8.2-5.2c-.5-.3-1.2.1-1.2.7z" fill="#fff"/></svg>',
    rutube: '<svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="9" fill="#100943"/><path d="M10 10h11.2c3.4 0 5.6 2 5.6 5s-2.2 5-5.6 5H20l5.4 6h-4.6l-5-6H14v6h-4V10zm4 3.6v3h7c1.1 0 1.8-.6 1.8-1.5s-.7-1.5-1.8-1.5h-7z" fill="#fff"/><circle cx="28" cy="9" r="3.4" fill="#ED143B"/></svg>'
  };

  var PLUGINS = [
    { id: 'yandex', name: 'Яндекс Музыка', desc: 'Поиск треков, загрузка в плейлист, подборки', keys: ['яндекс музыка', 'я музыка', 'yandex music', 'музыка'], alias: /^(яндекс\s*музык[а-яё]*|я\.?\s?музык[а-яё]*|yandex(\s*music)?|ym)(?![a-zа-яё0-9])/i },
    { id: 'youtube', name: 'YouTube', desc: 'Поиск видео', keys: ['youtube', 'ютуб'], alias: /^(youtube|ютуб[а-яё]*)(?![a-zа-яё0-9])/i },
    { id: 'rutube', name: 'Rutube', desc: 'Фильмы, сериалы и видео', keys: ['rutube', 'рутуб'], alias: /^(rutube|рутуб[а-яё]*)(?![a-zа-яё0-9])/i }
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ta() { return document.getElementById('msgTa'); }
  function available(p) {
    if (p.id === 'rutube' || p.id === 'youtube') return !global.HmVideo || global.HmVideo.pluginOn(p.id);
    return true;
  }

  /* «@YouTube котики» → {plugin:'youtube', rest:'котики'}; упоминание может стоять в начале фразы. */
  function parse(text) {
    var t = String(text || '');
    var m = t.match(/(^|\s)@(\S[^@\n]*)/);
    if (!m) return null;
    var after = m[2];
    for (var i = 0; i < PLUGINS.length; i++) {
      var p = PLUGINS[i];
      var a = after.match(p.alias);
      if (a) {
        var rest = (t.slice(0, m.index) + ' ' + after.slice(a[0].length)).replace(/\s+/g, ' ').replace(/^[\s,:—-]+/, '').trim();
        return { plugin: p.id, name: p.name, rest: rest };
      }
    }
    return null;
  }

  var box = null, items = [], active = 0, atPos = -1;

  function close() {
    if (box) { box.remove(); box = null; }
    atPos = -1;
  }

  /* Позиция «@», к которому относится список: последний «@» перед курсором,
     после которого пока нет пробела-разделителя слов от другого текста. */
  function currentQuery() {
    var el = ta();
    if (!el) return null;
    var pos = el.selectionStart == null ? el.value.length : el.selectionStart;
    var before = el.value.slice(0, pos);
    var i = before.lastIndexOf('@');
    if (i < 0) return null;
    if (i > 0 && !/\s/.test(before.charAt(i - 1))) return null;
    var q = before.slice(i + 1);
    if (/\n/.test(q) || q.length > 24) return null;
    return { at: i, q: q };
  }

  function render(q) {
    var el = ta();
    var host = el && (el.closest('.input-wrap') || el.parentNode);
    if (!host) return;
    var low = String(q || '').toLowerCase();
    items = PLUGINS.filter(function (p) { return available(p) && (!low || p.keys.some(function (k) { return k.indexOf(low) === 0 || k.split(' ').some(function (w) { return w.indexOf(low) === 0; }); })); });
    if (!items.length) { close(); return; }
    if (active >= items.length) active = 0;
    if (!box) {
      box = document.createElement('div');
      box.className = 'hm-mention';
      box.setAttribute('role', 'listbox');
      box.addEventListener('mousedown', function (e) { e.preventDefault(); }); // фокус остаётся в поле
      host.appendChild(box);
    }
    box.innerHTML = '<div class="hm-mention-h">Плагины</div>' + items.map(function (p, i) {
      return '<button type="button" class="hm-mention-row' + (i === active ? ' is-active' : '') + '" role="option" data-i="' + i + '">' +
        '<span class="hm-mention-logo">' + LOGOS[p.id] + '</span>' +
        '<span class="hm-mention-meta"><b>' + esc(p.name) + '</b><span>' + esc(p.desc) + '</span></span>' +
        '<span class="hm-mention-tag">Плагин</span></button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.hm-mention-row'), function (b) {
      b.addEventListener('click', function () { pick(Number(b.getAttribute('data-i'))); });
    });
  }

  function pick(i) {
    var p = items[i], el = ta();
    if (!p || !el) return;
    var cq = currentQuery();
    var start = cq ? cq.at : el.value.length;
    var end = el.selectionStart == null ? el.value.length : el.selectionStart;
    var ins = '@' + p.name + ' ';
    el.value = el.value.slice(0, start) + ins + el.value.slice(end).replace(/^\s+/, '');
    var caret = start + ins.length;
    try { el.setSelectionRange(caret, caret); } catch (e) { /* старый браузер */ }
    close();
    el.focus();
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* нет */ }
  }

  function refresh() {
    var cq = currentQuery();
    if (!cq) { close(); return; }
    // Плагин уже выбран и после него пишут текст — список не нужен.
    for (var i = 0; i < PLUGINS.length; i++) {
      if (cq.q.length > PLUGINS[i].name.length && cq.q.toLowerCase().indexOf(PLUGINS[i].name.toLowerCase()) === 0) { close(); return; }
    }
    atPos = cq.at;
    render(cq.q);
  }

  /* Пункт «Плагины» в меню «+»: ставим «@» в поле и показываем список. */
  function open() {
    var el = ta();
    if (!el) return;
    var v = el.value;
    if (!/(^|\s)@$/.test(v.slice(0, el.selectionStart == null ? v.length : el.selectionStart))) {
      var pos = el.selectionStart == null ? v.length : el.selectionStart;
      var lead = pos > 0 && !/\s/.test(v.charAt(pos - 1)) ? ' @' : '@';
      el.value = v.slice(0, pos) + lead + v.slice(pos);
      var caret = pos + lead.length;
      try { el.setSelectionRange(caret, caret); } catch (e) { /* нет */ }
    }
    el.focus();
    active = 0;
    refresh();
  }

  function bind() {
    var el = ta();
    if (!el || el.__hmMention) return;
    el.__hmMention = true;
    el.addEventListener('input', refresh);
    el.addEventListener('click', refresh);
    el.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== ta()) close(); }, 150); });
    // Перехватываем клавиши раньше обработчика отправки (Enter) — фаза захвата.
    el.addEventListener('keydown', function (e) {
      if (!box) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); active = (active + 1) % items.length; render(currentQuery() ? currentQuery().q : ''); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); active = (active - 1 + items.length) % items.length; render(currentQuery() ? currentQuery().q : ''); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
  document.addEventListener('pointerdown', function (e) { if (box && !box.contains(e.target) && e.target !== ta()) close(); }, true);

  global.HmMentions = { open: open, close: close, parse: parse, plugins: PLUGINS, logos: LOGOS };
})(window);
