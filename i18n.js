/* ============================================================================
   HarmonyAI — система интернационализации (i18n)
   ----------------------------------------------------------------------------
   Подход: словарь с ключом по русской строке-эталону. Русский = исходный язык
   (значения не хранятся, возвращается сам ключ). После каждой перерисовки
   интерфейса вызывается applyI18n(root) — обходит DOM, переводит текстовые
   узлы и пользовательские атрибуты (placeholder/title/aria-label/data-ph).

   ВАЖНО: системные промпты живут в JS-строках и НЕ попадают в DOM, поэтому
   DOM-обход их не трогает — ИИ продолжает отвечать на языке вопроса.
   ============================================================================ */
(function(){
  'use strict';

  var SUPPORTED = ['ru','en','fr','de','es'];
  var LANG_NAMES = { ru:'Русский', en:'English', fr:'Français', de:'Deutsch', es:'Español' };

  // Текущий язык
  var current = 'ru';
  try {
    var saved = localStorage.getItem('hai_lang');
    if (saved && SUPPORTED.indexOf(saved) >= 0) current = saved;
  } catch(e){}

  // Словарь переводов заполняется ниже (window.__I18N_DICT). Ключ — русская строка.
  // Значение — { en, fr, de, es }. Русский возвращается как сам ключ.
  var DICT = {};

  function norm(s){ return String(s == null ? '' : s).replace(/\s+/g,' ').trim(); }

  // Перевод одной строки. Сохраняет ведущие/замыкающие пробелы исходника.
  function translate(str){
    if (current === 'ru') return str;
    var raw = String(str == null ? '' : str);
    var key = norm(raw);
    if (!key) return str;
    var entry = DICT[key];
    if (!entry) return str;                 // нет перевода — оставляем русский
    var val = entry[current];
    if (!val) return str;
    // восстановить окружающие пробелы
    var lead = raw.match(/^\s*/)[0];
    var trail = raw.match(/\s*$/)[0];
    return lead + val + trail;
  }

  var ATTRS = ['placeholder','title','aria-label','data-ph','alt'];
  // Узлы, содержимое которых нельзя переводить
  var SKIP_TAGS = { SCRIPT:1, STYLE:1, TEXTAREA:1, CODE:1, PRE:1 };

  function translateEl(el){
    if (!el || el.nodeType !== 1) return;
    // атрибуты
    for (var i=0;i<ATTRS.length;i++){
      var a = ATTRS[i];
      if (el.hasAttribute && el.hasAttribute(a)){
        var orig = el.getAttribute('data-i18n-'+a);
        if (orig == null){ orig = el.getAttribute(a); el.setAttribute('data-i18n-'+a, orig); }
        el.setAttribute(a, translate(orig));
      }
    }
  }

  // Обход DOM: переводим текстовые узлы и атрибуты.
  function applyI18n(root){
    root = root || document.body;
    if (!root) return;
    if (current === 'ru'){ restoreRu(root); return; }
    // текстовые узлы
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node){
        var p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (!norm(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var textNodes = [];
    var n; while ((n = walker.nextNode())) textNodes.push(n);
    for (var i=0;i<textNodes.length;i++){
      var tn = textNodes[i];
      if (tn.__i18nOrig == null) tn.__i18nOrig = tn.nodeValue;
      var t = translate(tn.__i18nOrig);
      if (t !== tn.nodeValue) tn.nodeValue = t;
    }
    // атрибуты
    if (root.nodeType === 1) translateEl(root);
    var els = root.querySelectorAll('[placeholder],[title],[aria-label],[data-ph],[alt]');
    for (var j=0;j<els.length;j++) translateEl(els[j]);
  }

  // Возврат к русскому: восстанавливаем сохранённые оригиналы.
  function restoreRu(root){
    root = root || document.body;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n; while ((n = walker.nextNode())){ if (n.__i18nOrig != null && n.nodeValue !== n.__i18nOrig) n.nodeValue = n.__i18nOrig; }
    var els = root.querySelectorAll('*');
    for (var i=0;i<els.length;i++){
      var el = els[i];
      for (var k=0;k<ATTRS.length;k++){
        var a = ATTRS[k], keep = el.getAttribute && el.getAttribute('data-i18n-'+a);
        if (keep != null) el.setAttribute(a, keep);
      }
    }
  }

  // Установка языка
  function setLang(lang){
    if (SUPPORTED.indexOf(lang) < 0) return;
    current = lang;
    try { localStorage.setItem('hai_lang', lang); } catch(e){}
    document.documentElement.setAttribute('lang', lang);
    applyI18n(document.body);
    // сохранение в профиль (если доступно)
    try { if (typeof window.persistLangToProfile === 'function') window.persistLangToProfile(lang); } catch(e){}
    // уведомить подписчиков
    try { window.dispatchEvent(new CustomEvent('hai-lang-change',{detail:{lang:lang}})); } catch(e){}
  }

  // Автоперевод после динамических перерисовок через MutationObserver.
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
        }
      }
    });
    obs.observe(document.body, { childList:true, subtree:true });
  }

  // Публичный API
  window.i18n = {
    supported: SUPPORTED,
    names: LANG_NAMES,
    get: function(){ return current; },
    set: setLang,
    t: translate,
    apply: applyI18n,
    _setDict: function(d){
      DICT = d || {};
      // Re-apply translations if DOM is already available (dict loaded after DOMContentLoaded)
      if (current !== 'ru' && document.readyState !== 'loading') {
        try { applyI18n(document.body); } catch(e){}
      }
    }
  };
  // Короткий алиас
  window.t = translate;

  document.addEventListener('DOMContentLoaded', function(){
    document.documentElement.setAttribute('lang', current);
    if (current !== 'ru') applyI18n(document.body);
    startObserver();
  });
})();
