/* ============================================================================
   HarmonyAI — ИИ-поддержка: отдельный мини-чат (меню профиля → «Поддержка»,
   страница /contacts). Большинство ответов — заготовки по кнопкам, без сети.
   «Другой вопрос» открывает строку ввода (с фото, если вошли в аккаунт):
   отвечает модель по жёстким правилам (lib/util-support.js). «Сообщить об
   ошибке» отправляет описание в панель управления и выдаёт номер обращения.
   Каналы поддержки — только этот чат и почта.
   ============================================================================ */
(function (global) {
  'use strict';
  var EMAIL = 'harmonyaisent@gmail.com';
  var API = '/api/util?op=support';
  var el = null, state = { mode: 'menu', history: [], busy: false, image: null };

  /* ---------------------------------------------------------------- тексты */
  var A = {
    hello: 'Здравствуйте! Я ИИ-поддержка HarmonyAI. Выберите тему или задайте свой вопрос.',
    bug: 'Опишите, что случилось: что вы делали, что ожидали и что увидели. Если была надпись «Ошибка сервиса № …» — добавьте этот код. Можно приложить скриншот.',
    sub: 'Что именно интересует по подписке?',
    proHow: 'Pro оформляется в **Настройки → Подписка** или на странице harmonyai.ru/subscribe: **299 ₽ за 30 дней** или **129 ₽ за 7 дней**, оплата картой через ЮKassa. Автоматических списаний нет — подписка не продлевается сама. Если оплатить раньше срока, дни добавятся к оставшимся.',
    proWhat: 'В Pro: модель **Dynatos** для сложных задач, лимиты сообщений **в 25 раз больше**, распознавание музыки и нотный диктант, больше картинок и видео, просмотр видео по ссылке до 2 часов.',
    cancel: 'Отменять ничего не нужно: автоматических списаний нет, и подписка не продлевается сама. Pro просто закончится в конце оплаченного срока — до этого момента всё работает.',
    paidNoPro: 'Обновите страницу или выйдите и снова войдите в аккаунт — обычно Pro появляется в течение пары минут. Если через 5 минут его нет, напишите на **' + EMAIL + '**: почта аккаунта, дата и сумма платежа. Обращение рассмотрят в течение 10 рабочих дней.',
    refund: 'По пункту 7.1 оферты оплата за текущий оплаченный период **не возвращается**: услуги оказываются весь период.\n\nИсключения (п. 7.2): ошибочное двойное списание, техническая ошибка или оплата без предоставления доступа. В этих случаях напишите на **' + EMAIL + '** — дата платежа и описание проблемы. Заявку рассмотрят в течение **10 рабочих дней**, возврат — тем же способом оплаты.',
    access: 'Вход в HarmonyAI — по **коду на почту** или через **Google, GitHub, Discord**. Если код не приходит — проверьте «Спам» и «Промоакции», подождите минуту и запросите снова.\n\nЕсли доступа к почте или аккаунту нет — напишите на **' + EMAIL + '** с указанием почты аккаунта. Обращение рассмотрят в течение 10 дней. В этом чате доступ не восстанавливается, и мы никогда не просим коды из писем — не сообщайте их никому.',
    limits: 'Лимиты Free считаются окнами: **5 часов, неделя и месяц**. Сколько осталось и когда обновится — меню профиля → **Лимиты** (или Настройки → Использование). В Pro лимиты в 25 раз больше.',
    other: 'Напишите вопрос — отвечу сразу.',
    otherAnon: 'Напишите вопрос — отвечу сразу. Чтобы приложить скриншот, войдите в аккаунт.',
    fail: 'Не получилось ответить прямо сейчас. Напишите, пожалуйста, на **' + EMAIL + '** — обращение рассмотрят в течение 10 дней.'
  };
  var ROOT = [['bug', 'Сообщить об ошибке'], ['sub', 'Вопрос по подписке'], ['refund', 'Возврат'], ['access', 'Вход в аккаунт'], ['limits', 'Лимиты'], ['other', 'Другой вопрос']];
  var SUB = [['proHow', 'Как оформить Pro'], ['proWhat', 'Что даёт Pro'], ['cancel', 'Отменить подписку'], ['paidNoPro', 'Оплатил, а Pro нет'], ['refund', 'Возврат'], ['root', 'Назад']];
  var AFTER = [['other', 'Другой вопрос'], ['root', 'В начало']];
  /* Для вошедших эти кнопки отвечают по данным аккаунта (сервер передаёт
     боту тариф, срок Pro, платежи, недавние ошибки) — не заготовкой. */
  var LIVE = {
    paidNoPro: 'Я оплатил подписку, а Pro не появился. Проверь мой аккаунт и платежи.',
    limits: 'Какой у меня тариф и сколько сообщений я уже потратил?',
    account: 'Расскажи, что с моим аккаунтом: тариф, срок Pro, последние платежи и недавние ошибки.'
  };

  /* ---------------------------------------------------------------- токен */
  async function token() {
    try { if (typeof global.hmSupportToken === 'function') { var t = await global.hmSupportToken(); if (t) return t; } } catch (e) {}
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k)) continue;
        var s = JSON.parse(localStorage.getItem(k) || 'null');
        if (s && s.access_token && (!s.expires_at || s.expires_at * 1000 > Date.now() + 30000)) return s.access_token;
      }
    } catch (e) {}
    return '';
  }

  /* ---------------------------------------------------------------- вёрстка */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(text) {
    var h = esc(text);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<a href="mailto:$1">$1</a>');
    h = h.replace(/(^|[\s(])(harmonyai\.ru(\/[A-Za-z0-9/_-]*)?)/g, function (m, p, url) { return p + '<a href="https://' + url + '" target="_blank" rel="noopener">' + url + '</a>'; });
    return h.replace(/\n/g, '<br>');
  }
  var ICON = {
    bot: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12a8 8 0 1 1 3.2 6.4L4 19.5l1.1-3.2A7.96 7.96 0 0 1 4 12z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 10.5h6M9 13.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M5 17l4.5-4.5 3.5 3.5 2.5-2.5L20 17" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function injectCSS() {
    if (document.getElementById('hmSupCss')) return;
    var st = document.createElement('style');
    st.id = 'hmSupCss';
    st.textContent = ''
      + '.hm-sup{--s-bg:#141416;--s-line:rgba(255,255,255,.08);--s-bot:#1f1f23;--s-user:#2a2a2e;--s-text:#f2f2f4;--s-text2:#a1a1aa;--s-chip:#f2f2f2;--s-chip-t:#111;'
      + 'position:fixed;right:20px;bottom:20px;z-index:2147483000;width:380px;height:min(600px,calc(100vh - 40px));height:min(600px,calc(100dvh - 40px));display:flex;flex-direction:column;'
      + 'background:var(--s-bg);color:var(--s-text);border:1px solid var(--s-line);border-radius:24px;box-shadow:0 24px 64px rgba(0,0,0,.55);overflow:hidden;'
      + 'font:14.5px/1.5 "Inter","Segoe UI",system-ui,-apple-system,sans-serif;opacity:0;transform:translateY(14px) scale(.98);visibility:hidden;pointer-events:none;transition:opacity .2s ease,transform .22s cubic-bezier(.2,.8,.2,1),visibility .22s;}'
      + '.hm-sup.open{opacity:1;transform:none;visibility:visible;pointer-events:auto;}'
      + 'html[data-theme="light"] .hm-sup{--s-bg:#fbfaf8;--s-line:rgba(20,18,12,.10);--s-bot:#efede8;--s-user:#e4e2dc;--s-text:#1b1a16;--s-text2:#6b675e;--s-chip:#1b1a16;--s-chip-t:#fff;box-shadow:0 24px 64px rgba(20,18,12,.18);}'
      + '.hm-sup-head{display:flex;align-items:center;gap:11px;padding:14px 14px 12px 16px;border-bottom:1px solid var(--s-line);}'
      + '.hm-sup-ava{width:36px;height:36px;border-radius:50%;background:var(--s-user);display:flex;align-items:center;justify-content:center;flex:0 0 auto;}'
      + '.hm-sup-ava svg{width:19px;height:19px;}'
      + '.hm-sup-ttl{flex:1;min-width:0;}.hm-sup-ttl b{display:block;font-size:15.5px;font-weight:700;}'
      + '.hm-sup-ttl span{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--s-text2);}'
      + '.hm-sup-ttl span i{width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;}'
      + '.hm-sup-x{width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:var(--s-text2);cursor:pointer;display:flex;align-items:center;justify-content:center;}'
      + '.hm-sup-x:hover{background:var(--s-user);color:var(--s-text);}.hm-sup-x svg{width:15px;height:15px;}'
      + '.hm-sup-body{flex:1;overflow-y:auto;padding:16px 14px 8px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;}'
      + '.hm-sup-msg{max-width:88%;padding:10px 13px;border-radius:18px;white-space:normal;overflow-wrap:anywhere;font-size:14px;line-height:1.5;}'
      + '.hm-sup-msg a{color:inherit;text-decoration:underline;text-underline-offset:2px;}'
      + '.hm-sup-msg.bot{align-self:flex-start;background:var(--s-bot);border-bottom-left-radius:6px;}'
      + '.hm-sup-msg.user{align-self:flex-end;background:var(--s-user);border-bottom-right-radius:6px;}'
      + '.hm-sup-msg img{display:block;max-width:100%;max-height:180px;border-radius:12px;margin-top:6px;}'
      + '.hm-sup-typing{align-self:flex-start;font-size:13px;color:var(--s-text2);padding:4px 4px;background:linear-gradient(90deg,var(--s-text2) 0%,var(--s-text2) 35%,var(--s-text) 50%,var(--s-text2) 65%,var(--s-text2) 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:hmSupSh 1.4s linear infinite;}'
      + '@keyframes hmSupSh{from{background-position:110% 0}to{background-position:-110% 0}}'
      + '.hm-sup-chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px;margin-top:2px;}'
      + '.hm-sup-chip{border:0;border-radius:999px;padding:8px 14px;background:var(--s-chip);color:var(--s-chip-t);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;transition:transform .1s ease,opacity .15s;}'
      + '.hm-sup-chip:hover{opacity:.88;}.hm-sup-chip:active{transform:scale(.96);}'
      + '.hm-sup-chip.ghost{background:transparent;color:var(--s-text2);box-shadow:inset 0 0 0 1px var(--s-line);}'
      + '.hm-sup-foot{border-top:1px solid var(--s-line);padding:10px 12px 12px;}'
      + '.hm-sup-in{display:flex;align-items:flex-end;gap:8px;background:var(--s-bot);border-radius:18px;padding:6px 6px 6px 8px;}'
      + '.hm-sup-in[hidden]{display:none;}'
      + '.hm-sup-in textarea{flex:1;min-height:36px;max-height:120px;resize:none;border:0;outline:none;background:transparent;color:var(--s-text);font:inherit;font-size:14px;padding:8px 2px;}'
      + '.hm-sup-in textarea::placeholder{color:var(--s-text2);}'
      + '.hm-sup-ib{width:36px;height:36px;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;background:transparent;color:var(--s-text2);}'
      + '.hm-sup-ib:hover{color:var(--s-text);}.hm-sup-ib svg{width:19px;height:19px;}'
      + '.hm-sup-ib[hidden]{display:none;}'
      + '.hm-sup-ib.send{background:var(--s-chip);color:var(--s-chip-t);}.hm-sup-ib.send:disabled{opacity:.4;cursor:default;}'
      + '.hm-sup-prev{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:12.5px;color:var(--s-text2);}'
      + '.hm-sup-prev img{width:44px;height:44px;object-fit:cover;border-radius:10px;}'
      + '.hm-sup-prev button{border:0;background:none;color:var(--s-text2);cursor:pointer;text-decoration:underline;font:inherit;font-size:12.5px;}'
      + '.hm-sup-note{margin-top:8px;font-size:11.5px;color:var(--s-text2);text-align:center;}.hm-sup-note a{color:inherit;}'
      + '.hm-sup-back{position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;display:none;}.hm-sup-back.open{pointer-events:auto;}'
      + '@media(max-width:640px){.hm-sup{left:0;right:0;bottom:0;width:auto;height:92vh;height:92dvh;border-radius:24px 24px 0 0;border-bottom:0;transform:translateY(40px);padding-bottom:env(safe-area-inset-bottom,0px);}'
      + '.hm-sup.open{transform:none;}.hm-sup-back{display:block;}.hm-sup-back.open{opacity:1;}.hm-sup-msg{max-width:92%;}.hm-sup-in textarea{font-size:16px;}}'
      + '@media(prefers-reduced-motion:reduce){.hm-sup,.hm-sup-back{transition:none;}.hm-sup-typing{animation:none;color:var(--s-text2);background:none;}}';
    document.head.appendChild(st);
  }

  function build() {
    injectCSS();
    var back = document.createElement('div');
    back.className = 'hm-sup-back';
    back.addEventListener('click', close);
    var box = document.createElement('section');
    box.className = 'hm-sup';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Поддержка HarmonyAI');
    box.innerHTML = ''
      + '<div class="hm-sup-head"><div class="hm-sup-ava">' + ICON.bot + '</div>'
      + '<div class="hm-sup-ttl"><b>Поддержка</b><span><i></i>ИИ-помощник · отвечает сразу</span></div>'
      + '<button type="button" class="hm-sup-x" aria-label="Закрыть">' + ICON.x + '</button></div>'
      + '<div class="hm-sup-body" aria-live="polite"></div>'
      + '<div class="hm-sup-foot"><div class="hm-sup-prev" hidden></div>'
      + '<div class="hm-sup-in" hidden><button type="button" class="hm-sup-ib attach" aria-label="Прикрепить фото">' + ICON.clip + '</button>'
      + '<input type="file" accept="image/png,image/jpeg,image/webp" hidden>'
      + '<textarea rows="1" maxlength="2000" placeholder="Напишите сообщение…"></textarea>'
      + '<button type="button" class="hm-sup-ib send" aria-label="Отправить" disabled>' + ICON.send + '</button></div>'
      + '<div class="hm-sup-note">Почта поддержки: <a href="mailto:' + EMAIL + '">' + EMAIL + '</a></div></div>';
    document.body.appendChild(back);
    document.body.appendChild(box);
    el = { box: box, back: back, body: box.querySelector('.hm-sup-body'), input: box.querySelector('.hm-sup-in'), ta: box.querySelector('textarea'),
      send: box.querySelector('.send'), attach: box.querySelector('.attach'), file: box.querySelector('input[type=file]'), prev: box.querySelector('.hm-sup-prev') };
    box.querySelector('.hm-sup-x').addEventListener('click', close);
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    el.ta.addEventListener('input', function () {
      el.ta.style.height = 'auto'; el.ta.style.height = Math.min(120, el.ta.scrollHeight) + 'px';
      el.send.disabled = !el.ta.value.trim() && !state.image;
    });
    el.ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    el.send.addEventListener('click', submit);
    el.attach.addEventListener('click', function () { el.file.click(); });
    el.file.addEventListener('change', function () { var f = el.file.files && el.file.files[0]; el.file.value = ''; if (f) pickImage(f); });
  }

  function scroll() { requestAnimationFrame(function () { el.body.scrollTop = el.body.scrollHeight; }); }
  function clearChips() { el.body.querySelectorAll('.hm-sup-chips').forEach(function (c) { c.remove(); }); }
  function say(role, text, img) {
    var m = document.createElement('div');
    m.className = 'hm-sup-msg ' + role;
    m.innerHTML = fmt(text);
    if (img) { var i = document.createElement('img'); i.src = img; i.alt = 'Скриншот'; m.appendChild(i); }
    el.body.appendChild(m);
    state.history.push({ role: role === 'user' ? 'user' : 'assistant', text: String(text || '').slice(0, 800) });
    if (state.history.length > 16) state.history.shift();
    scroll();
  }
  function chips(list) {
    clearChips();
    var w = document.createElement('div');
    w.className = 'hm-sup-chips';
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hm-sup-chip' + (c[0] === 'root' ? ' ghost' : '');
      b.textContent = c[1];
      b.addEventListener('click', function () { pick(c[0], c[1]); });
      w.appendChild(b);
    });
    el.body.appendChild(w);
    scroll();
  }
  function showInput(on, placeholder) {
    el.input.hidden = !on;
    if (on) { el.ta.placeholder = placeholder || 'Напишите сообщение…'; setTimeout(function () { try { el.ta.focus(); } catch (e) {} }, 60); }
  }

  async function pick(id, label) {
    if (state.busy) return;
    clearChips();
    if (id === 'root') { say('bot', A.hello); chips(await rootChips()); showInput(false); state.mode = 'menu'; return; }
    if (label) say('user', label);
    if (id === 'sub') { say('bot', A.sub); chips(SUB); return; }
    if (id === 'bug') {
      state.mode = 'bug'; say('bot', A.bug);
      el.attach.hidden = !(await token());
      showInput(true, 'Опишите ошибку…'); chips([['root', 'В начало']]); return;
    }
    if (id === 'other') {
      state.mode = 'ask';
      var signed = Boolean(await token());
      el.attach.hidden = !signed;
      say('bot', signed ? A.other : A.otherAnon);
      showInput(true, 'Ваш вопрос…'); chips([['root', 'В начало']]); return;
    }
    if (LIVE[id] && await token()) { state.mode = 'ask'; await send(LIVE[id], null, { silentUser: true }); return; }
    if (A[id]) { say('bot', A[id]); chips(AFTER); }
  }
  async function rootChips() {
    return (await token()) ? [['account', 'Мой аккаунт']].concat(ROOT) : ROOT;
  }

  /* Сжатие скриншота: до 1280 px по большей стороне, JPEG 0.72. */
  function pickImage(file) {
    if (!/^image\//.test(file.type) || file.size > 15 * 1024 * 1024) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1280 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var url = c.toDataURL('image/jpeg', 0.72);
        if (url.length > 690000) url = c.toDataURL('image/jpeg', 0.5);
        state.image = url;
        el.prev.hidden = false;
        el.prev.innerHTML = '<img alt=""><span>Скриншот прикреплён</span><button type="button">убрать</button>';
        el.prev.querySelector('img').src = url;
        el.prev.querySelector('button').onclick = function () { state.image = null; el.prev.hidden = true; el.prev.innerHTML = ''; el.send.disabled = !el.ta.value.trim(); };
        el.send.disabled = false;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    var text = el.ta.value.trim();
    if ((!text && !state.image) || state.busy) return;
    var image = state.image;
    el.ta.value = ''; el.ta.style.height = 'auto';
    state.image = null; el.prev.hidden = true; el.prev.innerHTML = '';
    await send(text, image);
  }
  async function send(text, image, o) {
    o = o || {};
    state.busy = true; el.send.disabled = true;
    clearChips();
    if (!o.silentUser) say('user', text || 'Скриншот', image);
    else state.history.push({ role: 'user', text: text });
    var typing = document.createElement('div');
    typing.className = 'hm-sup-typing'; typing.textContent = state.mode === 'bug' ? 'Передаю команде…' : 'Печатаю ответ…';
    el.body.appendChild(typing); scroll();
    var reply = A.fail, done = false;
    try {
      var t = await token();
      var headers = { 'Content-Type': 'application/json' };
      if (t) headers.Authorization = 'Bearer ' + t;
      var payload = state.mode === 'bug'
        ? { action: 'bug', text: text, image: image, code: (text.match(/№\s*([A-Za-z0-9]{8,24})/) || [])[1] || '', page: location.pathname }
        : { action: 'ask', text: text, image: image, history: state.history.slice(-9, -1) };
      var r = await fetch(API, { method: 'POST', headers: headers, body: JSON.stringify(payload), cache: 'no-store' });
      var d = await r.json().catch(function () { return null; });
      if (d && d.reply) { reply = d.reply; done = true; }
      else if (d && d.error && d.error.message) reply = d.error.message;
    } catch (e) { /* остаётся A.fail */ }
    typing.remove();
    say('bot', reply);
    state.busy = false;
    el.send.disabled = !el.ta.value.trim();
    if (state.mode === 'bug' && done) { state.mode = 'menu'; showInput(false); chips(AFTER); }
    else chips([['root', 'В начало']]);
  }

  function open(opts) {
    opts = opts || {};
    if (!el) build();
    el.back.classList.add('open');
    requestAnimationFrame(function () { el.box.classList.add('open'); });
    if (!el.body.children.length) { say('bot', A.hello); rootChips().then(chips); }
    if (opts.topic) pick(opts.topic, null);
    setTimeout(function () { try { el.box.querySelector('.hm-sup-x').focus({ preventScroll: true }); } catch (e) {} }, 80);
  }
  function close() {
    if (!el) return;
    el.box.classList.remove('open');
    el.back.classList.remove('open');
  }
  function toggle(opts) { if (el && el.box.classList.contains('open')) close(); else open(opts); }

  global.HmSupport = { open: open, close: close, toggle: toggle };
})(typeof window !== 'undefined' ? window : globalThis);
