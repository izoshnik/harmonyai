
(() => {
  const plugins = {
    github: { title: 'GitHub', description: 'Поиск репозиториев, просмотр issues и PR, редактор файлов и создание pull request.' },
    youtube: { title: 'YouTube', description: 'Поиск и просмотр видео прямо в чате.' },
    gmail: { title: 'Gmail', description: 'Чтение и отправка писем, просмотр спама.' },
    telegram: { title: 'Telegram', description: 'Чтение, отправка и редактирование сообщений с личного аккаунта.' },
    yandex: { title: 'Яндекс Музыка', description: 'Поиск треков, плейлисты, Моя волна и загрузка MP3.' },
    rutube: { title: 'RuTube', description: 'Поиск фильмов, сериалов и видео прямо в чате.' },
    funpay: { title: 'FunPay', description: 'Лоты, автовыдача, автоответы и команды. Golden Key можно скопировать через EditThisCookie.' },
    api: { title: 'API', description: 'Ключи, баланс и настройки API HarmonyAI.', link: '/api/dashboard' },
    management: { title: 'Управление', description: 'Состояние сервиса и статистика.', link: '/management' }
  };
  const icons = {
    funpay: '<img class="hm-funpay-icon" src="/icons/plugin-funpay.ico" alt="" width="24" height="24">',
    github: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .8a11.3 11.3 0 0 0-3.57 22c.57.1.78-.24.78-.54l-.02-2.1c-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.95.1-.75.4-1.25.73-1.54-2.55-.3-5.24-1.28-5.24-5.69 0-1.25.45-2.28 1.18-3.08-.12-.3-.5-1.47.12-3.05 0 0 .97-.31 3.16 1.18a11 11 0 0 1 5.75 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.05.74.8 1.18 1.83 1.18 3.08 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.15l-.01 3.11c0 .3.2.65.79.54A11.3 11.3 0 0 0 12 .8Z"/></svg>',
    gmail: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="4.5"><path stroke="#4285f4" d="M3 20V6"/><path stroke="#34a853" d="M21 20V6"/><path stroke="#ea4335" stroke-linejoin="round" d="m2.5 5 9.5 7 9.5-7"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#229ed9"/><path fill="#fff" d="m5 11.5 13.5-5.2-2.4 12.1-4.4-3.5-2.3 2.2.4-3.8 6.4-5-7.8 4.5z"/></svg>',
    api: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18"/></svg>',
    management: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V10m5 10V4m6 16v-7m5 7V7"/></svg>'
  };
  let owner = null, connections = {}, telegramLibrary, activeLogin, googleScript, funpayLibrary;
  const knownModules = {};

  function icon(id) { return icons[id] || HM_PLUGIN_LOGOS[id] || ''; }
  function node(tag, classes, copy) {
    const element = document.createElement(tag);
    if (classes) element.className = classes;
    if (copy) element.textContent = copy;
    return element;
  }
  function button(copy, execute, emphatic = false) {
    const el = node('button', emphatic ? 'stp-btn stp-btn-white' : 'stp-btn', copy);
    el.type = 'button';
    el.onclick = execute;
    return el;
  }
  function buttonLink(copy, href) {
    const el = node('a', 'stp-btn stp-btn-white', copy);
    el.href = href;
    return el;
  }
  function checkOwner() {
    const next = curUser?.id || null;
    if (owner !== next) { reset(); owner = next; }
    return next;
  }
  function reset() {
    activeLogin?.abort();
    activeLogin = undefined;
    if (owner && telegramLibrary) knownModules.telegram?.lock(owner).catch(() => {});
    owner = null;
    connections = {};
  }
  function loadTelegram() {
    if (telegramLibrary) return telegramLibrary;
    telegramLibrary = import('/js/hm-telegram.js').then(module => { knownModules.telegram = module; return module; })
      .catch(error => { telegramLibrary = undefined; throw error; });
    return telegramLibrary;
  }
  function funpayStore() {
    if (!funpayLibrary) funpayLibrary = import('/js/hm-funpay-connection.js').catch(error => {
      funpayLibrary = undefined;
      throw error;
    });
    return funpayLibrary;
  }
  async function restoreFunPay(user) {
    const saved = await (await funpayStore()).load(user);
    if (curUser?.id === user && owner === user) connections.funpay = saved ? { account: saved.account, connected: true } : null;
    return saved;
  }
  async function telegramStored(user) {
    // A lightweight check avoids downloading the MTProto client just to display the catalogue.
    if (!user || !window.indexedDB) return false;
    if (knownModules.telegram) return knownModules.telegram.isSaved(user);
    const databases = await indexedDB.databases?.();
    if (databases && !databases.some(db => db.name === 'harmonyai-telegram')) return false;
    if (!databases) return window.localStorage.getItem('hm-tg-linked:' + user) === '1';
    return new Promise(resolve => {
      const request = indexedDB.open('harmonyai-telegram');
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('sessions')) { db.close(); resolve(false); return; }
        const transaction = db.transaction('sessions', 'readonly');
        const matched = transaction.objectStore('sessions').getKey(user);
        transaction.oncomplete = () => { db.close(); resolve(matched.result !== undefined); };
        transaction.onabort = () => { db.close(); resolve(false); };
      };
    });
  }
  function loadGoogle() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!googleScript) googleScript = new Promise((resolve, reject) => {
      const script = node('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = resolve;
      script.onerror = () => { script.remove(); googleScript = undefined; reject(Error('Google не загрузился.')); };
      document.head.append(script);
    });
    return googleScript;
  }
  async function call(action, args = {}, token) {
    const user = checkOwner();
    if (!user) throw Error('Войди в HarmonyAI.');
    const result = await hmUtil('plugins', { body: { ...args, action, ...(token ? { token } : {}) } });
    if (curUser?.id !== user) throw Error('Сессия HarmonyAI изменилась.');
    return result;
  }
  function field(host, title, opts = {}) {
    const label = node('label', 'hm-plugin-field');
    label.append(node('span', 'stp-row-desc', title));
    const input = node(opts.multiline ? 'textarea' : 'input', 'stp-input');
    if (!opts.multiline) input.type = opts.type || 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (opts.limit) input.maxLength = opts.limit;
    if (opts.rows) input.rows = opts.rows;
    if (opts.example) input.placeholder = opts.example;
    label.append(input);
    host.append(label);
    return input;
  }
  function feedback(host) {
    const line = node('p', 'stp-row-desc hm-plugin-feedback');
    line.setAttribute('role', 'status');
    host.append(line);
    return line;
  }
  function section(host, title) {
    const el = node('section', 'hm-plugin-section');
    el.append(node('h3', 'stp-sec-label', title));
    host.append(el);
    return el;
  }
  function toolbar(host) {
    const el = node('div', 'hm-plugin-actions');
    host.append(el);
    return el;
  }
  function runner(line) {
    let busy = false;
    return async work => {
      if (busy) return;
      busy = true;
      line.textContent = 'Выполняю…';
      try { line.textContent = await work() || ''; }
      catch (error) { line.textContent = error.message || 'Действие не выполнено.'; }
      finally { busy = false; }
    };
  }
  function connected(id) {
    if (id === 'youtube' || id === 'rutube') return Boolean(window.HmVideo?.pluginOn(id)) && connections[id]?.available !== false;
    if (id === 'gmail') return Boolean(connections.gmail?.expires > Date.now());
    return Boolean(connections[id]?.connected || connections[id]?.token);
  }
  function render() {
    const user = checkOwner();
    if (!user) return;
    window.__setScreen = 'plugins';
    const body = stpEnsure('plugins', 'Плагины', stpBackMain(), '<div class="hm-plugin-grid"></div>');
    if (!body) return;
    const grid = body.firstElementChild;
    const ids = Object.keys(plugins).filter(id => id !== 'management' || hasModeratorAccess());
    const draw = () => {
      if (!grid.isConnected || curUser?.id !== user) return;
      grid.replaceChildren();
      for (const id of ids) {
        const pl = plugins[id], on = connected(id);
        const card = node('article', 'stp-conn hm-plugin-entry');
        const title = button('', () => detail(id));
        title.className = 'hm-plugin-title';
        const logo = node('span', 'hm-plugin-logo');
        logo.innerHTML = icon(id);
        title.append(logo, node('strong', '', pl.title));
        const badge = pl.link ? buttonLink('Открыть', pl.link) : button(on ? 'Подключено' : 'Подключить', () => detail(id));
        if (!pl.link) {
          badge.classList.add(on ? 'hm-plugin-badge--on' : 'hm-plugin-badge--off');
          badge.setAttribute('aria-label', pl.title + ': ' + (on ? 'подключено, настройки' : 'не подключено, подключить'));
        }
        card.append(title, badge, node('p', 'stp-row-desc', pl.description));
        grid.append(card);
      }
    };
    draw();
    Promise.allSettled([
      window.MusicClient?.status().then(status => { if (curUser?.id === user) connections.yandex = { connected: status.connected }; }),
      telegramStored(user).then(saved => { if (curUser?.id === user) connections.telegram = { connected: saved }; }),
      restoreFunPay(user),
      hmVideoCall({ action: 'status' }, 8000).then(status => {
        if (curUser?.id === user && status.ok) for (const id of ['youtube', 'rutube']) connections[id] = { available: Boolean(status[id]) };
      })
    ]).then(draw);
  }

  function detail(id) {
    const user = checkOwner();
    if (!user || !Object.hasOwn(plugins, id) || (id === 'management' && !hasModeratorAccess())) return;
    activeLogin?.abort();
    window.__setScreen = 'plugins';
    const pl = plugins[id];
    const view = stpEnsure('plugins', pl.title, 'renderSettingsConnections()', '<div class="hm-plugin-detail"></div>')?.firstElementChild;
    if (!view) return;
    const back = view.closest('.set-main').querySelector('.stp-back');
    if (back) {
      back.setAttribute('aria-label', 'К списку плагинов');
      back.querySelector('span').textContent = 'Плагины';
    }
    const intro = node('div', 'hm-plugin-intro');
    const logo = node('span', 'hm-plugin-logo');
    logo.innerHTML = icon(id);
    intro.append(logo, node('p', 'stp-row-desc', pl.description));
    view.append(intro);
    if (pl.link) { toolbar(view).append(buttonLink('Открыть ' + pl.title, pl.link)); return; }
    if (id === 'yandex') {
      const connection = section(view, 'Подключение');
      connection.insertAdjacentHTML('beforeend', '<div class="stp-card stp-conn" id="connYm"><div class="stp-conn-row"><div class="stp-conn-meta"><div class="stp-conn-state">Проверяю подключение…</div></div></div></div>');
      refreshYandexConn();
      return;
    }
    if (id === 'youtube' || id === 'rutube') {
      const connection = section(view, 'Плагин в чате');
      connection.insertAdjacentHTML('beforeend', hmVideoPluginCard(id, pl.title, icon(id)));
      refreshVideoPlugins();
      return;
    }
    if (id === 'github') githubDetail(view, user);
    if (id === 'gmail') gmailDetail(view, user);
    if (id === 'telegram') telegramDetail(view, user);
    if (id === 'funpay') funpayDetail(view, user);
    const action = button('Перейти в чат', () => {
      closeSettings();
      window.HmMentions?.setChip(id);
      document.getElementById('msgTa')?.focus();
    });
    toolbar(view).append(action);
  }

  function writePreference(host, id, title) {
    const key = 'hmPluginWrite_' + id;
    const enabled = getSettings()[key] !== false;
    const row = node('div', 'stp-row');
    const label = node('div', 'stp-row-label');
    label.append(node('div', 'stp-row-title', title));
    const toggle = button('', () => {
      saveSetting(key, getSettings()[key] === false).catch(() => {});
      detail(id);
    });
    toggle.className = 'stp-toggle' + (enabled ? ' on' : '');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', title);
    toggle.setAttribute('aria-checked', String(enabled));
    row.append(label, toggle);
    host.append(row);
    return enabled;
  }
  function funpayDetail(view, user) {
    const account = section(view, 'Подключение');
    const automation = section(view, 'Серверная автоматизация');
    const serverLine = feedback(automation);
    const runServer = runner(serverLine);
    const serverControls = toolbar(automation);
    serverLine.textContent = 'Проверяю сервер…';
    Promise.all([call('funpay.automation.status'), restoreFunPay(user).catch(() => null)]).then(([state, saved]) => {
      if (!view.isConnected || curUser?.id !== user) return;
      serverLine.textContent = !state.available ? 'Администратор ещё не настроил фоновый сервер.' :
        state.issue || (state.ready ? 'Фоновая проверка FunPay работает.' : state.enabled ? 'Ожидается первая фоновая проверка.' : 'Серверное подключение выключено.');
      if (!state.available) return;
      if (saved) serverControls.append(button(state.enabled ? 'Обновить серверное подключение' : 'Включить серверную автоматизацию', () => runServer(async () => {
        const current = await restoreFunPay(user);
        if (!current || curUser?.id !== user) throw Error('Сначала подключи FunPay.');
        const status = await call('funpay.automation.enable', {}, current.token);
        if (view.isConnected) detail('funpay');
        return status.ready ? 'Подключено.' : 'Сохранено. Ожидается фоновая проверка.';
      }), !state.enabled));
      if (state.enabled) serverControls.append(button('Отключить серверную автоматизацию', () => runServer(async () => {
        if (!window.confirm('Автоматизация остановится, а серверный ключ и правила будут удалены. Опубликованные лоты останутся в FunPay.')) return '';
        await call('funpay.automation.disable');
        if (view.isConnected) detail('funpay');
        return 'Серверная автоматизация отключена.';
      })));
      automation.append(node('p', 'stp-row-desc', 'При включении сервер хранит зашифрованный Golden Key, чтобы обрабатывать заказы и сообщения при закрытом сайте. Правила настраиваются в чате через @FunPay.'));
    }).catch(() => {
      if (view.isConnected) serverLine.textContent = 'Не удалось проверить состояние фонового сервера.';
    });
    writePreference(account, 'funpay', 'Разрешить изменения предложений из чата');
    const line = feedback(account);
    const run = runner(line);
    const removeKey = () => run(async () => {
      await (await funpayStore()).remove(user);
      if (curUser?.id === user && owner === user) {
        delete connections.funpay;
        if (view.isConnected) detail('funpay');
      }
      return 'Ключ удалён.';
    });
    line.textContent = 'Проверяю сохранённое подключение…';
    restoreFunPay(user).then(saved => {
      if (!view.isConnected || curUser?.id !== user) return;
      if (saved) {
        line.textContent = 'Подключено · профиль №' + saved.account;
        toolbar(account).append(button('Удалить Golden Key', removeKey));
        return;
      }
      line.textContent = '';
      const instructions = node('p', 'stp-row-desc', 'Войди в свой аккаунт на funpay.com и скопируй значение cookie golden_key через ');
      const extension = node('a', 'stp-link', 'EditThisCookie (V3)');
      extension.href = 'https://chromewebstore.google.com/detail/editthiscookie-v3/ojfebgpkimhlhcblbalbfjblapadhbol';
      extension.target = '_blank';
      extension.rel = 'noopener noreferrer';
      instructions.append(extension, ' или через инструменты разработчика (Application → Cookies). Ключ сохранится в этом браузере, пока ты его не удалишь.');
      account.append(instructions);
      const key = field(account, 'Golden Key', { type: 'password', limit: 512 });
      toolbar(account).append(button('Проверить и подключить', () => run(async () => {
        const token = key.value.trim();
        if (!token) return 'Введи Golden Key.';
        const data = await call('funpay.connect', {}, token);
        if (!data.account || curUser?.id !== user) throw Error('FunPay не подтвердил подключение.');
        await (await funpayStore()).save(user, { token, account: data.account });
        if (curUser?.id !== user) return '';
        key.value = '';
        if (view.isConnected) detail('funpay');
        return 'Подключено.';
      }), true));
    }).catch(error => {
      if (view.isConnected && curUser?.id === user) {
        line.textContent = error.message || 'Не удалось открыть сохранённое подключение.';
        toolbar(account).append(button('Удалить Golden Key', removeKey));
      }
    });
  }
  function githubDetail(view, user) {
    const account = section(view, 'Подключение');
    const existing = connections.github;
    writePreference(account, 'github', 'Разрешить изменения из чата');
    const line = feedback(account);
    const run = runner(line);
    if (existing?.token) {
      line.textContent = 'Подключено · ' + existing.login;
      toolbar(account).append(button('Отключить', () => {
        delete connections.github;
        detail('github');
      }));
    } else {
      account.append(node('p', 'stp-row-desc', 'Публичные репозитории доступны сразу. Для редактора и PR нужен токен с доступом к репозиторию и правами Contents и Pull requests на чтение и запись.'));
      const token = field(account, 'Токен GitHub', { type: 'password', limit: 2048 });
      toolbar(account).append(button('Подключить', () => run(async () => {
        const credential = token.value.trim();
        const profile = await call('github.connect', {}, credential);
        if (!view.isConnected || curUser?.id !== user) return;
        connections.github = { token: credential, login: profile.login };
        token.value = '';
        detail('github');
      }), true));
    }
  }

  function gmailDetail(view, user) {
    const account = section(view, 'Подключение Google');
    const status = feedback(account);
    const credentials = connected('gmail') ? connections.gmail : null;
    writePreference(account, 'gmail', 'Разрешить отправку писем и перенос в корзину из чата');
    let oauth;
    const connect = button(credentials ? 'Переподключить' : 'Подключить', () => oauth?.requestAccessToken(), true);
    connect.disabled = true;
    toolbar(account).append(connect);
    if (credentials) {
      status.textContent = 'Подключено · ' + credentials.email;
      account.querySelector('.hm-plugin-actions').append(button('Отключить', () => {
        delete connections.gmail;
        window.google?.accounts?.oauth2?.revoke(credentials.token, () => {});
        detail('gmail');
      }));
    }
    (async () => {
      try {
        const config = await call('config');
        if (!config.gmailClientId) throw Error('Подключение Gmail ожидает настройки OAuth.');
        await loadGoogle();
        if (!view.isConnected || curUser?.id !== user) return;
        oauth = window.google.accounts.oauth2.initTokenClient({
          client_id: config.gmailClientId,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
          include_granted_scopes: false,
          callback: async response => {
            if (!view.isConnected || curUser?.id !== user) return;
            if (!response.access_token) { status.textContent = 'Gmail не подключён.'; return; }
            try {
              const data = await call('gmail.profile', {}, response.access_token);
              if (!view.isConnected || curUser?.id !== user) return;
              connections.gmail = { token: response.access_token, email: data.email, expires: Date.now() + 1000 * (Number(response.expires_in) || 3600) };
              detail('gmail');
            } catch (error) { status.textContent = error.message; }
          },
          error_callback: () => { status.textContent = 'Окно подключения Gmail закрыто.'; }
        });
        connect.disabled = false;
      } catch (error) { status.textContent = error.message; }
    })();
  }

  function telegramDetail(view, user) {
    const account = section(view, 'Личный аккаунт Telegram');
    writePreference(account, 'telegram', 'Разрешить отправку и редактирование из чата');
    const status = feedback(account);
    const run = runner(status);

    async function prepare() {
      const saved = await telegramStored(user).catch(() => false);
      if (!view.isConnected || curUser?.id !== user) return;
      if (saved) {
        status.textContent = 'Подключено в этом браузере.';
        toolbar(account).append(button('Отключить', () => run(async () => {
          if (!(await hmConfirm('Отключить личный аккаунт Telegram от HarmonyAI?'))) return;
          const revoked = await (await loadTelegram()).disconnect(user);
          try { localStorage.removeItem('hm-tg-linked:' + user); } catch {}
          delete connections.telegram;
          if (!revoked) toast('Сессия удалена из браузера. Проверь активные сеансы в Telegram.');
          detail('telegram');
        })));
        return;
      }
      const about = node('p', 'stp-row-desc', 'Создай приложение Telegram и возьми API ID и API Hash. Вход подтверждается в Telegram. Сессия сохраняется в этом браузере.');
      const link = node('a', 'stp-link', 'Открыть my.telegram.org');
      link.href = 'https://my.telegram.org/apps';
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      const form = node('div', 'hm-plugin-fields');
      account.append(about, link, form);
      const apiId = field(form, 'API ID', { limit: 10 });
      apiId.inputMode = 'numeric';
      const apiHash = field(form, 'API Hash', { type: 'password', limit: 32 });
      const phone = field(form, 'Номер телефона', { type: 'tel', example: '+79991234567', limit: 25 });
      const start = toolbar(form);
      const verification = node('div', 'hm-plugin-fields');
      account.append(verification);
      const login = button('Подключить', () => run(async () => {
        const values = { apiId: apiId.value, apiHash: apiHash.value, phone: phone.value };
        const controller = new AbortController();
        activeLogin = controller;
        login.disabled = true;
        const ask = (caption, type) => new Promise((resolve, reject) => {
          if (controller.signal.aborted || !view.isConnected || curUser?.id !== user) { reject(Error('AUTH_USER_CANCEL')); return; }
          verification.replaceChildren();
          status.textContent = caption;
          const input = field(verification, caption, { type: 'password', limit: 120 });
          if (type === 'code') { input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; }
          const row = toolbar(verification);
          const clean = () => { controller.signal.removeEventListener('abort', abort); verification.replaceChildren(); };
          const abort = () => { clean(); reject(Error('AUTH_USER_CANCEL')); };
          controller.signal.addEventListener('abort', abort, { once: true });
          function next() {
            const value = type === 'code' ? input.value.trim() : input.value;
            if (!value) { input.focus(); return; }
            input.value = ''; clean(); resolve(value);
          }
          row.append(button('Продолжить', next, true), button('Отмена', () => controller.abort()));
          input.addEventListener('keydown', event => { if (event.key === 'Enter') next(); });
          input.focus();
        });
        try {
          const module = await loadTelegram();
          if (controller.signal.aborted || !view.isConnected) return;
          await module.connect(user, values, ask, controller.signal);
          if (controller.signal.aborted || !view.isConnected || curUser?.id !== user) return;
          try { localStorage.setItem('hm-tg-linked:' + user, '1'); } catch {}
          connections.telegram = { connected: true };
          detail('telegram');
        } catch (error) {
          if (controller.signal.aborted || /AUTH_USER_CANCEL/.test(error.message)) return 'Подключение отменено.';
          if (/PHONE_CODE_INVALID/.test(error.message)) return 'Код не подошёл. Начни подключение заново.';
          if (/PASSWORD_HASH_INVALID/.test(error.message)) return 'Пароль Telegram неверный. Начни подключение заново.';
          if (/API_ID_INVALID/.test(error.message)) return 'Telegram отклонил API ID или API Hash.';
          throw Error('Telegram не подтвердил вход. Проверь данные, код и доступность Telegram в браузере.');
        } finally {
          if (activeLogin === controller) activeLogin = undefined;
          login.disabled = false;
          verification.replaceChildren();
          apiHash.value = '';
        }
      }), true);
      start.append(login);
    }
    prepare().catch(() => { status.textContent = 'Не удалось проверить подключение Telegram.'; });
  }

  window.HmPlugins = {
    render,
    detail,
    icon,
    reset,
    async containsFunPayKey(text) {
      const user = checkOwner();
      if (!user || String(text || '').length < 8) return false;
      const key = (await restoreFunPay(user).catch(() => null))?.token;
      return Boolean(key && String(text || '').includes(key));
    },
    async chatAccess(id, write = false) {
      const user = checkOwner();
      if (!user) throw Error('Войди в HarmonyAI.');
      if (write && getSettings()['hmPluginWrite_' + id] === false) throw Error('Изменения отключены в настройках ' + plugins[id].title + '.');
      const disconnected = () => Object.assign(Error('Подключи ' + plugins[id].title + ' в настройках плагинов.'), { pluginId: id });
      if (id === 'funpay') {
        return { invoke: async (action, args) => {
          if (action.startsWith('funpay.automation.')) {
            if (curUser?.id !== user) throw Error('Сессия HarmonyAI изменилась.');
            return call(action, args);
          }
          const saved = await restoreFunPay(user);
          if (curUser?.id !== user) throw Error('Сессия HarmonyAI изменилась.');
          if (!saved) throw disconnected();
          if (getSettings().hmPluginWrite_funpay === false) throw Error('Изменения отключены в настройках FunPay.');
          return call(action, args, saved.token);
        } };
      }
      const needsConnection = (id === 'gmail' && !connected(id)) || (id === 'github' && write && !connected(id)) ||
        (id === 'telegram' && !await telegramStored(user));
      if (needsConnection) throw disconnected();
      if (curUser?.id !== user) throw Error('Сессия HarmonyAI изменилась.');
      if (id === 'telegram') return { telegram: await loadTelegram() };
      return { invoke: (action, args) => {
        if (curUser?.id !== user) throw Error('Сессия HarmonyAI изменилась.');
        return call(action, args, connections[id]?.token);
      } };
    },
    cancel: () => activeLogin?.abort()
  };
})();
