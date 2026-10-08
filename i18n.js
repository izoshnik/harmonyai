/* ============================================================================
   HarmonyAI — система интернационализации (i18n)
   ----------------------------------------------------------------------------
   Подход: словарь с ключом по русской строке-эталону. Русский = исходный язык
   (значения не хранятся, возвращается сам ключ). После каждой перерисовки
   интерфейса вызывается applyI18n(root) — обходит DOM, переводит текстовые
   узлы и пользовательские атрибуты (placeholder/title/aria-label/data-ph).

   Словари: window.__I18N_DICT (приложение, i18_dict.js) и window.__I18N_SITE
   (страницы сайта, js/i18n/*.js — общий + по словарю на страницу).

   Язык: выбранный вручную (hai_lang) → определённый по IP при первом визите
   (hai_lang_auto, /api/detect-locale?lite=1) → язык браузера.

   ВАЖНО: системные промпты живут в JS-строках и НЕ попадают в DOM, поэтому
   DOM-обход их не трогает — ИИ продолжает отвечать на языке вопроса.

   Подключение: <script src="/i18n.js"></script> в <head> (синхронно — чтобы
   успеть спрятать русский текст до перевода), словари — с defer.
   ============================================================================ */
(function(){
  'use strict';

  var SUPPORTED = ['ru','en','fr','de','es','it','zh'];
  var LANG_NAMES = { ru:'Русский', en:'English', fr:'Français', de:'Deutsch', es:'Español', it:'Italiano', zh:'中文' };
  var HTML_LANG = { zh:'zh-CN' };
  var root = document.documentElement;

  function ls(k, v){
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch(e){}
    return null;
  }
  function ok(l){ return !!l && SUPPORTED.indexOf(l) >= 0; }

  // Язык браузера → поддерживаемый. Русскоязычные регионы СНГ — русский.
  function browserLang(){
    var list = [];
    try { list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language]; } catch(e){}
    for (var i=0;i<list.length;i++){
      var p = String(list[i]||'').toLowerCase().split('-')[0];
      if (ok(p)) return p;
      if (/^(uk|be|kk|ky|tg|uz|hy|az|ka)$/.test(p)) return 'ru';
    }
    return 'en';
  }

  var chosen = ls('hai_lang');
  var auto = ls('hai_lang_auto');
  var current = ok(chosen) ? chosen : ok(auto) ? auto : browserLang();
  var isAuto = !ok(chosen);
  // Первый визит: язык ещё не выбран и по IP не определялся — спросим сервер.
  var needDetect = !ok(chosen) && !ok(auto) && location.protocol !== 'file:';

  // Пока переводы не применены — прячем русский текст (без «мигания»).
  var waitTimer = null;
  function hold(ms){
    root.classList.add('i18n-wait');
    clearTimeout(waitTimer);
    waitTimer = setTimeout(release, ms);
  }
  function release(){ clearTimeout(waitTimer); root.classList.remove('i18n-wait'); }
  (function(){
    var st = document.createElement('style');
    st.textContent = 'html.i18n-wait body{visibility:hidden!important}';
    (document.head || root).appendChild(st);
  })();
  if (current !== 'ru' || needDetect) hold(needDetect ? 1200 : 2500);
  root.setAttribute('lang', HTML_LANG[current] || current);

  var DICT = {};

  function norm(s){ return String(s == null ? '' : s).replace(/\s+/g,' ').trim(); }

  function lookup(key){
    return DICT[key] || (window.__I18N_DICT && window.__I18N_DICT[key]) || (window.__I18N_SITE && window.__I18N_SITE[key]);
  }

  // Перевод одной строки. Сохраняет ведущие/замыкающие пробелы исходника.
  function translate(str){
    if (current === 'ru') return str;
    var raw = String(str == null ? '' : str);
    var key = norm(raw);
    if (!key) return str;
    var entry = lookup(key);
    if (!entry) return str;                 // нет перевода — оставляем русский
    var val = entry[current];
    if (!val) return str;
    var lead = raw.match(/^\s*/)[0];
    var trail = raw.match(/\s*$/)[0];
    return lead + val + trail;
  }

  var ATTRS = ['placeholder','title','aria-label','data-ph','alt'];
  // Узлы, содержимое которых нельзя переводить
  var SKIP_TAGS = { SCRIPT:1, STYLE:1, TEXTAREA:1, CODE:1, PRE:1 };

  function skipped(el){ return !!(el && el.closest && el.closest('[data-i18n-skip]')); }

  function translateEl(el){
    if (!el || el.nodeType !== 1) return;
    for (var i=0;i<ATTRS.length;i++){
      var a = ATTRS[i];
      if (el.hasAttribute && el.hasAttribute(a)){
        var orig = el.getAttribute('data-i18n-'+a);
        var cur = el.getAttribute(a);
        var last = el.__i18nAttr && el.__i18nAttr[a];
        // Атрибут переписан скриптом после перевода — это новый оригинал.
        if (orig == null || (last != null && cur !== last)){ orig = cur; el.setAttribute('data-i18n-'+a, orig); }
        var t = translate(orig);
        (el.__i18nAttr || (el.__i18nAttr = {}))[a] = t;
        if (cur !== t) el.setAttribute(a, t);
      }
    }
  }

  // <title> и мета-описания (поисковики и превью ссылок).
  var META_SEL = 'meta[name="description"],meta[property="og:title"],meta[property="og:description"],meta[name="twitter:title"],meta[name="twitter:description"]';
  var titleOrig = null;
  function translateHead(){
    if (titleOrig == null) titleOrig = document.title;
    var t = current === 'ru' ? titleOrig : translate(titleOrig);
    if (document.title !== t) document.title = t;
    var ms = document.querySelectorAll(META_SEL);
    for (var i=0;i<ms.length;i++){
      var m = ms[i], o = m.getAttribute('data-i18n-content');
      if (o == null){ o = m.getAttribute('content') || ''; m.setAttribute('data-i18n-content', o); }
      m.setAttribute('content', current === 'ru' ? o : translate(o));
    }
  }

  // Обход DOM: переводим текстовые узлы и атрибуты.
  function applyI18n(rootEl){
    rootEl = rootEl || document.body;
    if (!rootEl) return;
    if (current === 'ru'){ restoreRu(rootEl); return; }
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node){
        var p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (!norm(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (skipped(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var textNodes = [];
    var n; while ((n = walker.nextNode())) textNodes.push(n);
    for (var i=0;i<textNodes.length;i++){
      var tn = textNodes[i];
      // Текст поменяли скриптом после перевода — это новый оригинал.
      if (tn.__i18nOrig == null || (tn.__i18nVal != null && tn.nodeValue !== tn.__i18nVal)) tn.__i18nOrig = tn.nodeValue;
      var t = translate(tn.__i18nOrig);
      if (t !== tn.nodeValue) tn.nodeValue = t;
      tn.__i18nVal = t;
    }
    if (rootEl.nodeType === 1 && !skipped(rootEl)) translateEl(rootEl);
    if (rootEl.querySelectorAll){
      var els = rootEl.querySelectorAll('[placeholder],[title],[aria-label],[data-ph],[alt]');
      for (var j=0;j<els.length;j++) if (!skipped(els[j])) translateEl(els[j]);
    }
  }

  // Возврат к русскому: восстанавливаем сохранённые оригиналы.
  function restoreRu(rootEl){
    rootEl = rootEl || document.body;
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    var n; while ((n = walker.nextNode())){
      if (n.__i18nOrig != null){
        if (n.__i18nVal != null && n.nodeValue !== n.__i18nVal) n.__i18nOrig = n.nodeValue;
        if (n.nodeValue !== n.__i18nOrig) n.nodeValue = n.__i18nOrig;
        n.__i18nVal = n.__i18nOrig;
      }
    }
    if (!rootEl.querySelectorAll) return;
    var els = rootEl.querySelectorAll('*');
    for (var i=0;i<els.length;i++){
      var el = els[i];
      for (var k=0;k<ATTRS.length;k++){
        var a = ATTRS[k], keep = el.getAttribute && el.getAttribute('data-i18n-'+a);
        if (keep == null) continue;
        var last = el.__i18nAttr && el.__i18nAttr[a], cur = el.getAttribute(a);
        if (last != null && cur !== last) keep = cur;     // переписан скриптом
        if (cur !== keep && cur != null) el.setAttribute(a, keep);
        el.setAttribute('data-i18n-'+a, keep);
        (el.__i18nAttr || (el.__i18nAttr = {}))[a] = keep;
      }
    }
  }

  function applyAll(){
    if (!document.body) return;
    applyI18n(document.body);
    translateHead();
    legalNote();
    refreshSwitchers();
  }

  // Установка языка. opts.auto — определён автоматически (не сохраняем как выбор
  // пользователя и не пишем в профиль).
  function setLang(lang, opts){
    if (!ok(lang)) return;
    opts = opts || {};
    current = lang;
    if (opts.auto){ ls('hai_lang_auto', lang); }
    else { ls('hai_lang', lang); isAuto = false; }
    root.setAttribute('lang', HTML_LANG[lang] || lang);
    applyAll();
    if (!opts.auto){
      try { if (typeof window.persistLangToProfile === 'function') window.persistLangToProfile(lang); } catch(e){}
    }
    try { window.dispatchEvent(new CustomEvent('hai-lang-change',{detail:{lang:lang, auto:!!opts.auto}})); } catch(e){}
  }

  /* ---------- Юридические документы: пометка о переводе ---------- */
  function legalNote(){
    var host = document.querySelector('[data-i18n-legal-note]');
    if (!host) return;
    if (current === 'ru'){ host.hidden = true; return; }
    host.hidden = false;
    host.textContent = translate('Это перевод для удобства. Юридическую силу имеет русская версия документа.');
  }

  /* ---------- Кнопка выбора языка ---------- */
  var switchers = [];
  var GLOBE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/></svg>';
  var CSS = ''
    + '.hai-lang{position:relative;display:inline-flex;font:inherit;z-index:60}'
    + '.hai-lang-float{position:fixed;top:12px;right:12px;z-index:1000}'
    + '.hai-lang-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.28));background:var(--bg,#fff);color:var(--text,#111);font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;white-space:nowrap}'
    + '.hai-lang-btn:hover{background:var(--bg-sunk,rgba(127,127,127,.12))}'
    + '.hai-lang-btn:focus-visible{outline:2px solid var(--accent,#2f80d8);outline-offset:2px}'
    + '.hai-lang-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:176px;padding:6px;border-radius:14px;border:1px solid var(--border,rgba(127,127,127,.28));background:var(--bg,#fff);color:var(--text,#111);box-shadow:0 14px 40px rgba(0,0,0,.16);display:none}'
    + '.hai-lang.open .hai-lang-menu{display:block}'
    + '.hai-lang-menu button{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:0;border-radius:9px;background:none;color:inherit;font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:left;cursor:pointer}'
    + '.hai-lang-menu button:hover,.hai-lang-menu button:focus-visible{background:var(--bg-sunk,rgba(127,127,127,.12));outline:none}'
    + '.hai-lang-menu button[aria-checked="true"]{font-weight:700}'
    + '.hai-lang-menu button[aria-checked="true"]::after{content:"✓";color:var(--accent,#2f80d8)}'
    + '.hai-lang-note{padding:6px 10px 4px;font-size:12px;opacity:.6}'
    + 'html[data-theme="dark"] .hai-lang-btn,html[data-theme="dark"] .hai-lang-menu{background:var(--bg,#1c1c1e);color:var(--text,#f2f2f2)}'
    + '@media (max-width:640px){.hai-lang-btn{height:32px;padding:0 8px}.hai-lang-menu{right:0}}'
    + '@media print{.hai-lang{display:none}}';
  var cssDone = false;

  function buildSwitcher(host, floating){
    if (!cssDone){ var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; }
    var wrap = document.createElement('div');
    wrap.className = 'hai-lang' + (floating ? ' hai-lang-float' : '');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hai-lang-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Выбрать язык');
    btn.setAttribute('title', 'Язык');
    var menu = document.createElement('div');
    menu.className = 'hai-lang-menu';
    menu.setAttribute('role', 'menu');
    SUPPORTED.forEach(function(l){
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('data-lang', l);
      b.setAttribute('lang', HTML_LANG[l] || l);
      b.setAttribute('data-i18n-skip', '');
      b.textContent = LANG_NAMES[l];
      b.addEventListener('click', function(){ close(); setLang(l); btn.focus(); });
      menu.appendChild(b);
    });
    var note = document.createElement('div');
    note.className = 'hai-lang-note';
    note.textContent = 'Язык определён автоматически';
    menu.appendChild(note);
    function open(){ wrap.classList.add('open'); btn.setAttribute('aria-expanded','true'); var c = menu.querySelector('[aria-checked="true"]'); if (c) c.focus(); }
    function close(){ wrap.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }
    btn.addEventListener('click', function(e){ e.stopPropagation(); wrap.classList.contains('open') ? close() : open(); });
    document.addEventListener('click', function(e){ if (!wrap.contains(e.target)) close(); });
    wrap.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && wrap.classList.contains('open')){ close(); btn.focus(); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && wrap.classList.contains('open')){
        e.preventDefault();
        var items = [].slice.call(menu.querySelectorAll('button'));
        var i = items.indexOf(document.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    if (floating) document.body.appendChild(wrap); else host.insertBefore(wrap, host.firstChild);
    var sw = { btn:btn, menu:menu, note:note };
    switchers.push(sw);
    refreshSwitcher(sw);
    if (current !== 'ru') applyI18n(wrap);
  }

  function refreshSwitcher(sw){
    var label = current === 'zh' ? '中文' : current.toUpperCase();
    sw.btn.innerHTML = GLOBE + '<span data-i18n-skip>' + label + '</span>';
    var bs = sw.menu.querySelectorAll('button');
    for (var i=0;i<bs.length;i++) bs[i].setAttribute('aria-checked', bs[i].getAttribute('data-lang') === current ? 'true' : 'false');
    sw.note.hidden = !isAuto;
  }
  function refreshSwitchers(){ for (var i=0;i<switchers.length;i++) refreshSwitcher(switchers[i]); }

  // Куда ставить кнопку: явное место [data-i18n-switcher] → шапка сайта →
  // плавающая кнопка в правом верхнем углу.
  function mountSwitcher(){
    if (switchers.length) return;
    var host = document.querySelector('[data-i18n-switcher]');
    if (host){ buildSwitcher(host, false); return; }
    host = document.querySelector('.site-header .header-actions');
    if (host){ buildSwitcher(host, false); return; }
    buildSwitcher(null, true);
  }

  /* ---------- Автоперевод после динамических перерисовок ---------- */
  var moScheduled = false, moPending = [];
  function scheduleTranslate(node){
    if (current === 'ru') return;
    moPending.push(node);
    if (moScheduled) return;
    moScheduled = true;
    requestAnimationFrame(function(){
      moScheduled = false;
      var nodes = moPending; moPending = [];
      for (var i=0;i<nodes.length;i++){ try { applyI18n(nodes[i]); } catch(e){} }
    });
  }
  function startObserver(){
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function(muts){
      for (var i=0;i<muts.length;i++){
        var m = muts[i];
        if (m.type === 'childList'){
          for (var j=0;j<m.addedNodes.length;j++){
            var an = m.addedNodes[j];
            if (an.nodeType === 1) scheduleTranslate(an);
            else if (an.nodeType === 3 && an.parentNode) scheduleTranslate(an.parentNode);
          }
        } else if (m.type === 'attributes'){
          var el = m.target, lv = el.__i18nAttr && el.__i18nAttr[m.attributeName];
          if (lv == null || el.getAttribute(m.attributeName) !== lv) scheduleTranslate(el);
        } else if (m.type === 'characterData'){
          var tn = m.target;
          if (tn.parentNode && tn.__i18nVal != null && tn.nodeValue !== tn.__i18nVal) scheduleTranslate(tn.parentNode);
        }
      }
    });
    obs.observe(document.body, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:ATTRS });
  }

  /* ---------- Определение языка по IP (один раз на браузер) ---------- */
  function detect(){
    var done = false;
    var timer = setTimeout(function(){ done = true; release(); }, 1200);
    fetch('/api/detect-locale?lite=1', { credentials:'omit' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        var l = d && ok(d.lang) ? d.lang : null;
        if (!l){ if (!done){ clearTimeout(timer); release(); } return; }
        if (ok(ls('hai_lang'))) { release(); return; }   // успел выбрать вручную
        ls('hai_lang_auto', l);
        if (l !== current) setLang(l, { auto:true });
        clearTimeout(timer);
        release();
      })
      .catch(function(){ clearTimeout(timer); release(); });
  }

  // Публичный API
  window.i18n = {
    supported: SUPPORTED,
    names: LANG_NAMES,
    get: function(){ return current; },
    isAuto: function(){ return isAuto; },
    set: setLang,
    t: translate,
    apply: applyI18n,
    mountSwitcher: mountSwitcher,
    _setDict: function(d){
      DICT = d || {};
      if (current !== 'ru' && document.readyState !== 'loading') {
        try { applyAll(); } catch(e){}
      }
    }
  };
  // Короткий алиас
  window.t = translate;

  function boot(){
    // На страницах сайта (подключён словарь сайта) — кнопка языка.
    if (window.__I18N_SITE && !document.body.hasAttribute('data-i18n-noswitch')) mountSwitcher();
    if (current !== 'ru') applyAll(); else { translateHead(); legalNote(); }
    startObserver();
    if (needDetect) detect(); else release();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
