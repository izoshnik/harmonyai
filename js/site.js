/* ============================================================================
   HARMONYAI — ОБЩИЙ СКРИПТ СТАТИЧЕСКИХ СТРАНИЦ

   Подключается к landing / about / contacts / api-docs / api-dashboard.
   Собственных зависимостей нет (в проекте ноль npm-пакетов), это обычный IIFE.

   Что здесь:
     hm.nav        — гамбургер-меню шапки
     hm.accordion  — FAQ и раскрывающиеся инструкции
     hm.tabs       — вкладки «список слева, подробности справа»
     hm.copy       — кнопки «Скопировать» в блоках кода
     hm.modal      — открытие/закрытие модальных окон
     hm.pop        — всплывающие меню

   Все анимации сделаны в css/site.css. Скрипт только переключает класс .open —
   так поведение и оформление не расходятся, и prefers-reduced-motion
   отключает движение сразу везде.

   ДОСТУПНОСТЬ. Каждый переключатель обновляет aria-expanded, модальное окно
   закрывается по Escape и возвращает фокус на кнопку, которая его открыла,
   а фокус внутри окна не выпрыгивает наружу по Tab.
   ============================================================================ */
(function () {
  'use strict';

  const hm = {};

  /* ===== ГАМБУРГЕР-МЕНЮ ==================================================== */
  hm.nav = function () {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.site-nav');
    if (!toggle || !nav) return;

    const setOpen = open => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    // Клик по ссылке или вне меню закрывает его.
    nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', e => {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    // При переходе на широкий экран меню обязано вернуться в строку.
    window.addEventListener('resize', () => { if (window.innerWidth > 820) setOpen(false); });
  };

  /* ===== АККОРДЕОНЫ ========================================================
     Один обработчик на оба вида: FAQ (.faq-item) и инструкции (.disc).
     Работают независимо — закрывать соседей не нужно, люди часто сравнивают
     два ответа рядом. */
  hm.accordion = function (root) {
    const scope = root || document;
    scope.querySelectorAll('.faq-q, .disc-head').forEach(btn => {
      if (btn.dataset.hmBound) return;
      btn.dataset.hmBound = '1';
      const item = btn.closest('.faq-item, .disc');
      if (!item) return;
      const open = item.classList.contains('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.addEventListener('click', () => {
        const next = !item.classList.contains('open');
        item.classList.toggle('open', next);
        btn.setAttribute('aria-expanded', next ? 'true' : 'false');
      });
    });
  };

  /* ===== ВКЛАДКИ (список слева, подробности справа) ========================
     Разметка: контейнер с data-tabs="<префикс>", внутри кнопки role="tab" с
     data-tab="<id>" и aria-controls на свою панель role="tabpanel".

     Переключение — только атрибутом hidden: панели остаются в DOM, поэтому
     кнопки «Скопировать» уже навешаны, а поиск по странице (Ctrl+F) находит
     текст всех инструкций… точнее, находит только открытую — зато ничего не
     нужно перерисовывать.

     Адрес обновляем через replaceState: ссылку на конкретную инструкцию можно
     переслать, но кнопка «назад» в браузере не превращается в перебор вкладок.
     ========================================================================= */
  hm.tabs = function (root) {
    const scope = root || document;
    scope.querySelectorAll('[data-tabs]').forEach(group => {
      if (group.dataset.hmBound) return;
      group.dataset.hmBound = '1';

      const prefix = group.getAttribute('data-tabs') || 'tab';
      const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
      if (!tabs.length) return;
      const panelOf = tab => document.getElementById(tab.getAttribute('aria-controls') || '');

      const select = (tab, opts) => {
        const o = opts || {};
        tabs.forEach(t => {
          const on = t === tab;
          t.setAttribute('aria-selected', on ? 'true' : 'false');
          t.tabIndex = on ? 0 : -1;
          const panel = panelOf(t);
          if (panel) panel.hidden = !on;
        });
        if (o.focus) tab.focus();
        if (o.hash !== false && tab.dataset.tab) {
          try { history.replaceState(null, '', '#' + prefix + '-' + tab.dataset.tab); } catch (e) { /* не критично */ }
        }
      };

      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => select(tab));
        tab.addEventListener('keydown', e => {
          // Список вертикальный на широком экране и горизонтальный на узком —
          // поэтому обе пары стрелок делают одно и то же.
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
          let next = null;
          if (step) next = tabs[(i + step + tabs.length) % tabs.length];
          else if (e.key === 'Home') next = tabs[0];
          else if (e.key === 'End') next = tabs[tabs.length - 1];
          if (!next) return;
          e.preventDefault();
          select(next, { focus: true });
        });
      });

      // Ссылка вида /api#connect-cursor открывает нужную инструкцию сразу.
      // Тот же разбор нужен и на hashchange: переход по ссылке внутри страницы
      // меняет только хеш, документ не перезагружается и этот код сам не сработает.
      const fromHash = () => {
        const wanted = (location.hash || '').slice(1);
        if (wanted.indexOf(prefix + '-') !== 0) return null;
        return tabs.find(t => t.dataset.tab === wanted.slice(prefix.length + 1)) || null;
      };

      const initial = fromHash();
      select(initial || tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0], { hash: false });
      if (initial) {
        // Браузер по такому хешу ничего не найдёт и оставит человека наверху
        // страницы — доводим до раздела сами.
        setTimeout(() => { try { group.scrollIntoView({ block: 'start' }); } catch (e) { group.scrollIntoView(); } }, 0);
      }

      window.addEventListener('hashchange', () => {
        const tab = fromHash();
        if (tab) select(tab, { hash: false });
      });
    });
  };

  /* ===== КОПИРОВАНИЕ КОДА ==================================================
     navigator.clipboard требует https или localhost; на всякий случай есть
     запасной путь через скрытое textarea, иначе на некоторых webview кнопка
     молча ничего не делает. */
  hm.copyText = async function (text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* пробуем запасной путь */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  };

  hm.copy = function (root) {
    const scope = root || document;
    scope.querySelectorAll('.code-block').forEach(block => {
      if (block.dataset.hmBound) return;
      block.dataset.hmBound = '1';
      const pre = block.querySelector('pre');
      if (!pre) return;
      let btn = block.querySelector('.copy');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy';
        btn.textContent = 'Скопировать';
        btn.setAttribute('aria-label', 'Скопировать код');
        block.appendChild(btn);
      }
      btn.addEventListener('click', async () => {
        const ok = await hm.copyText(pre.innerText);
        btn.textContent = ok ? 'Скопировано' : 'Не удалось';
        btn.classList.toggle('done', ok);
        setTimeout(() => {
          btn.textContent = 'Скопировать';
          btn.classList.remove('done');
        }, 1600);
      });
    });
  };

  /* ===== МОДАЛЬНЫЕ ОКНА ====================================================
     Открывающая кнопка запоминается, чтобы вернуть на неё фокус при закрытии:
     иначе после Escape фокус улетает в начало страницы и навигация с клавиатуры
     ломается. */
  const modalStack = [];

  function focusable(el) {
    return Array.from(
      el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')
    ).filter(n => n.offsetParent !== null || n === document.activeElement);
  }

  hm.openModal = function (idOrEl, opener) {
    const modal = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!modal) return null;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modalStack.push({ modal, opener: opener || document.activeElement });
    const first = focusable(modal)[0];
    if (first) setTimeout(() => first.focus(), 40);
    return modal;
  };

  hm.closeModal = function (idOrEl) {
    const modal = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    const idx = modalStack.findIndex(r => r.modal === modal);
    const rec = idx >= 0 ? modalStack.splice(idx, 1)[0] : null;
    if (!modalStack.length) document.body.style.overflow = '';
    if (rec?.opener && typeof rec.opener.focus === 'function') rec.opener.focus();
  };

  hm.modal = function (root) {
    const scope = root || document;

    // data-modal-open="id" / data-modal-close (внутри окна)
    scope.querySelectorAll('[data-modal-open]').forEach(btn => {
      if (btn.dataset.hmBound) return;
      btn.dataset.hmBound = '1';
      btn.addEventListener('click', () => hm.openModal(btn.getAttribute('data-modal-open'), btn));
    });

    scope.querySelectorAll('.modal').forEach(modal => {
      if (modal.dataset.hmBound) return;
      modal.dataset.hmBound = '1';
      modal.setAttribute('aria-hidden', modal.classList.contains('open') ? 'false' : 'true');
      modal.querySelectorAll('[data-modal-close]').forEach(btn => {
        btn.addEventListener('click', () => hm.closeModal(modal));
      });
      const backdrop = modal.querySelector('.modal-backdrop');
      // Клик по фону закрывает — если окно не помечено как обязательное
      // (например, окно с новым API-ключом: его закрывают осознанно).
      if (backdrop && modal.dataset.persistent !== '1') {
        backdrop.addEventListener('click', () => hm.closeModal(modal));
      }
    });
  };

  /* Escape и Tab обслуживаем на документе один раз — так порядок вложенных
     окон соблюдается сам собой (закрывается верхнее). */
  document.addEventListener('keydown', e => {
    if (!modalStack.length) return;
    const top = modalStack[modalStack.length - 1].modal;

    if (e.key === 'Escape') {
      if (top.dataset.persistent === '1') return;   // окно закрывается только кнопкой
      e.preventDefault();
      hm.closeModal(top);
      return;
    }

    if (e.key === 'Tab') {
      const items = focusable(top);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ===== ВСПЛЫВАЮЩИЕ МЕНЮ ================================================ */
  hm.closeAllPops = function () {
    document.querySelectorAll('.pop.open').forEach(p => {
      p.classList.remove('open');
      const btn = document.querySelector(`[data-pop="${p.id}"]`);
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  };

  hm.pop = function (root) {
    const scope = root || document;
    scope.querySelectorAll('[data-pop]').forEach(btn => {
      if (btn.dataset.hmBound) return;
      btn.dataset.hmBound = '1';
      const pop = document.getElementById(btn.getAttribute('data-pop'));
      if (!pop) return;
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-haspopup', 'true');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const willOpen = !pop.classList.contains('open');
        hm.closeAllPops();
        pop.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
      pop.addEventListener('click', e => {
        // Действие выбрано — меню закрываем, но клик по самому меню наружу не пускаем.
        e.stopPropagation();
        if (e.target.closest('.pop-item')) hm.closeAllPops();
      });
    });
  };

  document.addEventListener('click', () => hm.closeAllPops());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hm.closeAllPops(); });

  /* ===== МЕЛОЧИ ============================================================ */
  hm.year = function () {
    const now = new Date().getFullYear();
    document.querySelectorAll('[data-year]').forEach(el => { el.textContent = now; });
  };

  /* ===== ЦЕНЫ ИЗ СЕРВЕРНОЙ КОНФИГУРАЦИИ ====================================
     Цифры цен живут в одном месте — lib/pricing.js. В вёрстке они дублируются
     только как запасной вариант: элемент с data-price сразу показывает
     последнее известное значение, а после ответа сервера обновляется на
     актуальное. Так страница остаётся читаемой без JS и не расходится с
     биллингом, если поменяют PRO_PRICE_RUB или USD_RUB_RATE.

     Ключи data-price:
       pro                 — цена подписки, рублей
       usd-rate            — курс ₽ за $1
       in:<модель>         — цена входа, $ за 1M
       out:<модель>        — цена выхода, $ за 1M
       in-rub:<модель>     — цена входа, ₽ за 1M
       out-rub:<модель>    — цена выхода, ₽ за 1M
     ========================================================================= */
  hm.prices = function (root) {
    const nodes = (root || document).querySelectorAll('[data-price]');
    if (!nodes.length) return;
    /* Сервер отдаёт суммы строками ("299.00", "95.00") — они посчитаны в целых
       копейках. Здесь только оформление: запятая вместо точки, без ",00". */
    const rub = v => String(v == null ? '' : v).replace('.', ',').replace(/,00$/, '');

    const apply = p => {
      if (!p) return;
      const byId = {};
      (p.models || []).forEach(m => { byId[m.id] = m; });
      nodes.forEach(el => {
        const key = el.getAttribute('data-price') || '';
        const [what, id] = key.split(':');
        const m = id ? byId[id] : null;
        let value = '';
        if (what === 'pro') value = rub(p.proPriceRub);
        else if (what === 'usd-rate') value = rub(p.usdRubRate);
        else if (m && what === 'in') value = '$' + m.inputUsdPerMillion;
        else if (m && what === 'out') value = '$' + m.outputUsdPerMillion;
        else if (m && what === 'in-rub') value = m.inputRubPerMillion;
        else if (m && what === 'out-rub') value = m.outputRubPerMillion;
        if (value) el.textContent = value;
      });
    };

    /* Тарифы меняются раз в полгода, а лендинг открывают часто: держим ответ
       в sessionStorage, чтобы не дёргать функцию Vercel на каждой странице. */
    const CACHE_KEY = 'hm_pricing_v1', TTL = 30 * 60 * 1000;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const box = JSON.parse(raw);
        if (box && box.pricing && Date.now() - Number(box.t || 0) < TTL) {
          apply(box.pricing);
          return;
        }
      }
    } catch (e) { /* приватный режим — просто идём в сеть */ }

    fetch('/api/account?action=pricing', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const p = data && data.pricing;
        if (!p) return;
        apply(p);
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), pricing: p })); } catch (e) { /* не критично */ }
      })
      .catch(() => { /* тарифы недоступны — остаётся значение из вёрстки */ });
  };

  /* Отмечаем текущий пункт навигации — чтобы не дублировать разметку на каждой
     странице и не забыть обновить её при переименовании раздела. */
  hm.markCurrent = function () {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.site-nav a, .footer-col a').forEach(a => {
      const href = (a.getAttribute('href') || '').split('?')[0].replace(/\/+$/, '') || '/';
      if (href === path) a.setAttribute('aria-current', 'page');
    });
  };

  hm.initAll = function (root) {
    hm.nav();
    hm.accordion(root);
    hm.tabs(root);
    hm.copy(root);
    hm.modal(root);
    hm.pop(root);
    hm.year();
    hm.markCurrent();
    hm.prices(root);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hm.initAll());
  } else {
    hm.initAll();
  }

  window.hm = hm;
})();
