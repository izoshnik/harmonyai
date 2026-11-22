
(() => {
  const plugins = {
    github: { title: 'GitHub', description: 'Поиск репозиториев, просмотр issues и PR, редактор файлов и создание pull request.' },
    youtube: { title: 'YouTube', description: 'Поиск и просмотр видео прямо в чате.' },
    gmail: { title: 'Gmail', description: 'Чтение и отправка писем, просмотр спама.' },
    telegram: { title: 'Telegram', description: 'Чтение, отправка и редактирование сообщений с личного аккаунта.' },
    yandex: { title: 'Яндекс Музыка', description: 'Поиск треков, плейлисты, Моя волна и загрузка MP3.' },
    rutube: { title: 'RuTube', description: 'Поиск фильмов, сериалов и видео прямо в чате.' },
    api: { title: 'API', description: 'Ключи, баланс и настройки API HarmonyAI.', link: '/api/dashboard' },
    management: { title: 'Управление', description: 'Состояние сервиса и статистика.', link: '/management' }
  };
  const icons = {
    github: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .8a11.3 11.3 0 0 0-3.57 22c.57.1.78-.24.78-.54l-.02-2.1c-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.95.1-.75.4-1.25.73-1.54-2.55-.3-5.24-1.28-5.24-5.69 0-1.25.45-2.28 1.18-3.08-.12-.3-.5-1.47.12-3.05 0 0 .97-.31 3.16 1.18a11 11 0 0 1 5.75 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.05.74.8 1.18 1.83 1.18 3.08 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.15l-.01 3.11c0 .3.2.65.79.54A11.3 11.3 0 0 0 12 .8Z"/></svg>',
    gmail: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="4.5"><path stroke="#4285f4" d="M3 20V6"/><path stroke="#34a853" d="M21 20V6"/><path stroke="#ea4335" stroke-linejoin="round" d="m2.5 5 9.5 7 9.5-7"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#229ed9"/><path fill="#fff" d="m5 11.5 13.5-5.2-2.4 12.1-4.4-3.5-2.3 2.2.4-3.8 6.4-5-7.8 4.5z"/></svg>',
    api: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18"/></svg>',
    management: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V10m5 10V4m6 16v-7m5 7V7"/></svg>'
  };
  let owner = null, connections = {}, onlyConnected = false, telegramLibrary, activeLogin, googleScript;
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
    onlyConnected = false;
  }
  function loadTelegram() {
    if (telegramLibrary) return telegramLibrary;
    telegramLibrary = import('/js/hm-telegram.js').then(module => { knownModules.telegram = module; return module; })
      .catch(error => { telegramLibrary = undefined; throw error; });
    return telegramLibrary;
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
    const head = body.parentElement.querySelector('.stp-head');
    const menu = node('details', 'hm-plugin-menu');
    const more = node('summary', 'stp-close hm-plugin-more', '···');
    more.setAttribute('aria-label', 'Меню плагинов');
    more.title = 'Меню плагинов';
    const options = node('div', 'stp-dd-menu hm-plugin-menu-options');
    const filter = button(onlyConnected ? 'Показать все плагины' : 'Только подключённые', () => { onlyConnected = !onlyConnected; render(); });
    const refresh = button('Обновить статусы', () => render());
    options.append(filter, refresh);
    menu.append(more, options);
    head.append(menu);
    menu.onkeydown = event => { if (event.key === 'Escape') { menu.open = false; more.focus(); event.stopPropagation(); } };
    menu.onfocusout = event => { if (!menu.contains(event.relatedTarget)) menu.open = false; };

    const ids = Object.keys(plugins).filter(id => id !== 'management' || hasModeratorAccess());
    const draw = () => {
      if (!grid.isConnected || curUser?.id !== user) return;
      grid.replaceChildren();
      for (const id of ids) {
        const pl = plugins[id], on = connected(id);
        if (onlyConnected && !pl.link && !on) continue;
        const card = node('article', 'stp-conn hm-plugin-entry');
        const title = button('', () => detail(id));
        title.className = 'hm-plugin-title';
        const logo = node('span', 'hm-plugin-logo');
        logo.innerHTML = icon(id);
        title.append(logo, node('strong', '', pl.title));
        const badge = pl.link ? buttonLink('Открыть', pl.link) : button(on ? 'Подключено' : 'Подключить', () => detail(id), true);
        card.append(title, badge, node('p', 'stp-row-desc', pl.description));
        grid.append(card);
      }
    };
    draw();
    Promise.allSettled([
      window.MusicClient?.status().then(status => { if (curUser?.id === user) connections.yandex = { connected: status.connected }; }),
      telegramStored(user).then(saved => { if (curUser?.id === user) connections.telegram = { connected: saved }; }),
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
  function githubDetail(view, user) {
    const account = section(view, 'Подключение');
    const existing = connections.github;
    const canWrite = writePreference(account, 'github', 'Изменения в репозиториях');
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
    const browser = section(view, 'Репозитории');
    const query = field(browser, 'Поиск репозитория', { limit: 100 });
    const find = toolbar(browser);
    const matches = node('div', 'hm-plugin-results');
    browser.append(matches);
    const repo = field(browser, 'Репозиторий', { limit: 200, example: 'владелец/имя' });
    const repoActions = toolbar(browser);
    const report = node('div', 'hm-plugin-results');
    browser.append(report);
    const token = existing?.token;
    const api = (action, body = {}) => {
      if (!view.isConnected || curUser?.id !== user) throw Error('Открой плагин GitHub снова.');
      return call('github.' + action, { repo: repo.value.trim(), ...body }, token);
    };
    const repoStatus = feedback(browser);
    const browse = runner(repoStatus);
    find.append(button('Найти', () => browse(async () => {
      const result = await api('search', { query: query.value });
      matches.replaceChildren();
      for (const item of result.repos || []) matches.append(button(item.name, () => { repo.value = item.name; repo.dispatchEvent(new Event('input')); repo.focus(); }));
      return result.repos?.length ? '' : 'Репозитории не найдены.';
    })));
    const editor = section(view, 'Редактор кода');
    const base = field(editor, 'Базовая ветка', { example: 'main', limit: 120 });
    const branch = field(editor, 'Рабочая ветка', { example: 'fix/название', limit: 120 });
    const path = field(editor, 'Путь к файлу', { example: 'src/index.js', limit: 300 });
    const fileActions = toolbar(editor);
    const source = field(editor, 'Код файла', { multiline: true, rows: 11 });
    source.classList.add('hm-plugin-source');
    source.disabled = true;
    const editorRun = runner(feedback(editor));
    const commit = field(editor, 'Сообщение коммита', { limit: 150 });
    const commitActions = toolbar(editor);
    let loaded = null;
    const target = () => ({ repo: repo.value.trim(), branch: branch.value.trim(), path: path.value.trim() });
    const clear = () => { source.value = ''; source.disabled = true; loaded = null; };
    for (const input of [repo, branch, path]) input.addEventListener('input', clear);
    repo.addEventListener('input', () => { base.value = ''; report.replaceChildren(); });
    source.readOnly = !canWrite;
    repoActions.append(button('Открыть репозиторий', () => browse(async () => {
      const requestedRepo = repo.value.trim();
      const data = await api('repo');
      if (repo.value.trim() !== requestedRepo) return;
      if (!base.value) base.value = data.branch || '';
      report.replaceChildren(node('strong', '', data.name), node('p', '', data.description || ''));
      for (const item of data.issues || []) {
        const link = node('a', 'stp-link', (item.pullRequest ? 'PR' : 'Issue') + ' #' + item.number + ' · ' + item.title);
        link.href = 'https://github.com/' + data.name + (item.pullRequest ? '/pull/' : '/issues/') + item.number;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        report.append(link);
      }
    }), true));
    if (canWrite) fileActions.append(button('Создать ветку', () => editorRun(async () => {
      const { branch: name } = await api('branch', { branch: branch.value.trim(), base: base.value.trim() });
      return 'Создана ветка ' + name + '.';
    })));
    fileActions.append(button('Открыть файл', () => editorRun(async () => {
      const selected = target();
      const file = await api('file', selected);
      if (JSON.stringify(selected) !== JSON.stringify(target())) return 'Путь или ветка изменились. Открой файл заново.';
      source.value = file.content;
      loaded = { ...selected, sha: file.sha, content: source.value, crlf: /\r\n/.test(file.content) && !/(?<!\r)\n/.test(file.content) };
      source.disabled = false;
    }), true));
    if (!canWrite) { commit.closest('label').hidden = true; return; }
    commitActions.append(button('Сохранить коммит', () => editorRun(async () => {
      const current = target();
      if (!loaded || ['repo', 'branch', 'path'].some(key => loaded[key] !== current[key])) throw Error('Открой файл в выбранной ветке.');
      const snapshot = loaded;
      const content = source.value;
      const message = commit.value;
      if (content === snapshot.content) throw Error('Файл не изменился.');
      if (!(await hmConfirm('Сохранить изменения файла ' + loaded.path + ' в ветку ' + loaded.branch + '?'))) return;
      const result = await api('commit', { ...current, sha: snapshot.sha, message, content: snapshot.crlf ? content.replace(/\n/g, '\r\n') : content });
      if (JSON.stringify(current) === JSON.stringify(target())) loaded = { ...snapshot, sha: result.sha, content };
      return 'Коммит ' + result.commit.slice(0, 7) + ' сохранён.';
    }), true));
    const pull = section(view, 'Pull request');
    const title = field(pull, 'Заголовок', { limit: 150 });
    const description = field(pull, 'Описание', { multiline: true, rows: 4, limit: 8000 });
    const pullActions = toolbar(pull);
    const pullStatus = feedback(pull);
    const pullRun = runner(pullStatus);
    const pullLink = node('a', 'stp-link');
    pull.append(pullLink);
    pullActions.append(button('Создать PR', () => pullRun(async () => {
      const request = { repo: repo.value.trim(), head: branch.value.trim(), base: base.value.trim(), title: title.value, description: description.value };
      if (!request.title.trim() || !request.head || !request.base) throw Error('Заполни заголовок и выбери ветки.');
      if (!(await hmConfirm('Создать pull request из ' + request.head + ' в ' + request.base + '?'))) return;
      const result = await api('pull', request);
      const slug = request.repo.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
      pullLink.href = 'https://github.com/' + slug + '/pull/' + result.number;
      pullLink.target = '_blank'; pullLink.rel = 'noopener noreferrer';
      pullLink.textContent = 'Открыть PR #' + result.number;
      return 'Pull request создан.';
    }), true));
  }

  function gmailDetail(view, user) {
    const account = section(view, 'Подключение Google');
    const status = feedback(account);
    const credentials = connected('gmail') ? connections.gmail : null;
    const canSend = writePreference(account, 'gmail', 'Отправка и перемещение писем в корзину');
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
    if (!credentials) return;

    const mailbox = section(view, 'Почта');
    const list = node('div', 'hm-plugin-results');
    const query = field(mailbox, 'Поиск писем', { example: 'is:unread', limit: 180 });
    const mailActions = toolbar(mailbox);
    mailbox.append(list);
    const run = runner(feedback(mailbox));
    const api = (action, args) => {
      if (!view.isConnected || curUser?.id !== user || credentials.expires <= Date.now()) throw Error('Срок подключения Gmail истёк. Подключи аккаунт снова.');
      return call('gmail.' + action, args, credentials.token);
    };
    const load = spam => run(async () => {
      const data = await api('list', { query: query.value, spam });
      list.replaceChildren();
      for (const item of data.messages || []) {
        const row = node('article', 'hm-plugin-result');
        row.append(node('strong', '', item.subject || 'Без темы'), node('p', 'stp-row-desc', item.from), node('p', '', item.snippet));
        const actions = toolbar(row);
        const content = node('pre', 'hm-plugin-text');
        row.append(content);
        actions.append(button('Читать', () => run(async () => { content.textContent = (await api('read', { id: item.id })).text; })));
        if (spam && canSend) actions.append(button('В корзину', () => run(async () => {
          if (!(await hmConfirm('Переместить письмо «' + (item.subject || 'Без темы') + '» в корзину Gmail?'))) return;
          await api('trash', { id: item.id }); row.remove();
        })));
        list.append(row);
      }
      return data.messages?.length ? '' : 'Письма не найдены.';
    });
    mailActions.append(button('Входящие', () => load(false), true), button('Спам', () => load(true)));
    if (!canSend) return;
    const compose = section(view, 'Отправить письмо');
    const to = field(compose, 'Получатель', { type: 'email', limit: 254 });
    const subject = field(compose, 'Тема', { limit: 120 });
    const message = field(compose, 'Письмо', { multiline: true, rows: 5, limit: 20000 });
    const send = toolbar(compose);
    const sendRun = runner(feedback(compose));
    send.append(button('Отправить', () => sendRun(async () => {
      const mail = { to: to.value.trim(), subject: subject.value.trim(), message: message.value };
      if (!mail.to || !to.validity.valid || !mail.subject || !mail.message.trim()) throw Error('Заполни получателя, тему и текст.');
      if (!(await hmConfirm('Отправить письмо на ' + mail.to + '?'))) return;
      await api('send', mail);
      message.value = '';
      return 'Письмо отправлено.';
    }), true));
  }


  function telegramDetail(view, user) {
    const account = section(view, 'Личный аккаунт Telegram');
    const canSend = writePreference(account, 'telegram', 'Отправка и редактирование сообщений');
    const status = feedback(account);
    const run = runner(status);

    function mountMessages() {
      if (!view.isConnected || curUser?.id !== user) return;
      const explorer = section(view, 'Чаты и сообщения');
      const chat = node('select', 'stp-input');
      chat.setAttribute('aria-label', 'Чат Telegram');
      chat.append(new Option('Избранное', 'me'));
      const list = node('div', 'hm-plugin-results');
      const actions = toolbar(explorer);
      explorer.append(chat, list);
      const compose = field(explorer, 'Сообщение', { multiline: true, rows: 4, limit: 4096 });
      const sendActions = toolbar(explorer);
      compose.closest('label').hidden = !canSend;
      sendActions.hidden = !canSend;
      const progress = feedback(explorer);
      const execute = runner(progress);
      let editing = null;
      const write = button('Отправить', () => execute(async () => {
        const target = chat.value;
        const text = compose.value.trim();
        const messageId = editing;
        if (!text) throw Error('Введи текст сообщения.');
        const caption = chat.selectedOptions[0]?.textContent || 'Telegram';
        if (!(await hmConfirm((messageId ? 'Сохранить изменения в «' : 'Отправить сообщение в «') + caption + '»?'))) return;
        if (!view.isConnected || curUser?.id !== user || chat.value !== target) throw Error('Открой нужный чат снова.');
        await (await loadTelegram()).send(user, target, text, messageId);
        resetEditor();
        await loadMessages();
        return messageId ? 'Сообщение изменено.' : 'Сообщение отправлено.';
      }), true);
      const cancelEdit = button('Отменить редактирование', () => resetEditor());
      cancelEdit.hidden = true;
      sendActions.append(write, cancelEdit);
      function resetEditor() {
        compose.value = '';
        editing = null;
        write.textContent = 'Отправить';
        cancelEdit.hidden = true;
      }
      async function loadMessages() {
        const target = chat.value;
        const items = await (await loadTelegram()).messages(user, target);
        if (!view.isConnected || curUser?.id !== user || chat.value !== target) return;
        list.replaceChildren();
        for (const item of items) {
          const card = node('article', 'hm-plugin-result');
          card.append(node('p', 'hm-plugin-text', item.text));
          if (item.outgoing && canSend) toolbar(card).append(button('Редактировать', () => {
            editing = item.id;
            compose.value = item.text;
            write.textContent = 'Сохранить изменения';
            cancelEdit.hidden = false;
            compose.focus();
          }));
          list.append(card);
        }
        return items.length ? '' : 'Нет текстовых сообщений.';
      }
      actions.append(button('Загрузить чаты', () => execute(async () => {
        const current = chat.value;
        const items = await (await loadTelegram()).dialogs(user);
        if (!view.isConnected || curUser?.id !== user) return;
        chat.replaceChildren(...items.map(item => new Option(item.name, item.id)));
        if (items.some(item => item.id === current)) chat.value = current;
        return 'Чаты загружены.';
      })), button('Показать сообщения', () => execute(loadMessages), true));
      chat.addEventListener('change', () => { list.replaceChildren(); resetEditor(); });
    }

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
        mountMessages();
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
    reset,
    cancel: () => activeLogin?.abort()
  };
})();
