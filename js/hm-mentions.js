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
    // Официальные значки сервисов (favicon с music.yandex.ru, rutube.ru, youtube.com).
    yandex: '<svg viewBox="0 0 144 144" aria-hidden="true"><rect width="144" height="144" rx="41" fill="#110503"/><path fill="#FFEE00" d="m130.863 57.739-.468-2.327-19.788-3.457 11.498-15.557-1.337-1.462-16.913 8.11 2.139-21.54-1.738-.997-10.295 17.418L82.395 12H80.39l2.74 25.064-29.08-23.269-2.474.732 22.396 28.122-44.323-14.76-2.006 2.261L67.22 52.686l-54.618 4.521-.602 3.39 56.757 6.184-47.33 39.157 2.005 2.726 56.356-30.648-11.164 53.983h3.41l21.592-50.792 13.17 39.756 2.34-1.795-5.415-40.42 20.524 23.268 1.337-2.128-15.711-28.853 21.928 8.111.201-2.46-19.655-14.493 18.518-4.454Z"/></svg>',
    youtube: '<svg viewBox="0 -4.3 28.57 28.57" aria-hidden="true"><path fill="#FF0000" d="M27.973 3.123A3.58 3.58 0 0 0 25.447.597C23.22 0 14.285 0 14.285 0S5.35 0 3.123.597A3.58 3.58 0 0 0 .597 3.123C0 5.35 0 10 0 10s0 4.65.597 6.877a3.58 3.58 0 0 0 2.526 2.526C5.35 20 14.285 20 14.285 20s8.935 0 11.162-.597a3.58 3.58 0 0 0 2.526-2.526C28.57 14.65 28.57 10 28.57 10s-.002-4.65-.597-6.877Z"/><path fill="#fff" d="M11.425 14.285 18.848 10l-7.423-4.285v8.57Z"/></svg>',
    rutube: '<svg viewBox="0 0 132 132" aria-hidden="true" style="border-radius:24%"><path fill="#100943" d="M0 0h132v132H0z"/><path fill="#ED143B" d="M132 66c36.451 0 66-29.55 66-66s-29.549-66-66-66S66-36.45 66 0s29.55 66 66 66"/><path fill="#fff" d="M81.536 62.987H42.54V47.555h38.997c2.278 0 3.862.397 4.657 1.09s1.287 1.98 1.287 3.858v5.541c0 1.98-.492 3.265-1.287 3.959-.795.693-2.379.99-4.657.99zm2.675-29.981H26V99h16.539V77.53h30.479L87.48 99H106L90.055 77.429c5.878-.871 8.518-2.673 10.695-5.642s3.269-7.716 3.269-14.051v-4.948c0-3.758-.398-6.727-1.092-9.002s-1.88-4.255-3.565-6.033c-1.78-1.683-3.76-2.868-6.14-3.663-2.378-.693-5.35-1.09-9.01-1.09z"/></svg>'
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
