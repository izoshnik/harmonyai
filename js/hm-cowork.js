
(() => {
  const plugins = {
    gmail: { name: 'Gmail', mark: 'M', description: 'Письма и поиск по почте', example: 'Покажи непрочитанные письма за сегодня' },
    github: { name: 'GitHub', mark: 'GH', description: 'Репозитории, issues и PR', example: 'Что открыто в izoshnik/harmonyai?' },
    telegram: { name: 'Telegram', mark: '↗', description: 'Сообщения через бота', example: 'Покажи последние сообщения бота' }
  };
  const labels = {
    'github.repo': 'Проверяю GitHub',
    'gmail.list': 'Ищу письма в Gmail',
    'gmail.read': 'Читаю письмо',
    'gmail.send': 'Отправляю письмо',
    'gmail.trash': 'Перемещаю письмо в корзину',
    'telegram.inbox': 'Читаю обновления Telegram',
    'telegram.send': 'Отправляю сообщение в Telegram'
  };
  const writeActions = new Set(['gmail.send', 'gmail.trash', 'telegram.send']);
  const mentionPattern = /(^|\s)@(gmail|джимейл|почта|github|гитхаб|telegram|телеграм|тг)(?=$|[\s,.;:!?])/giu;
  const aliases = { 'джимейл': 'gmail', 'почта': 'gmail', 'гитхаб': 'github', 'телеграм': 'telegram', 'тг': 'telegram' };
  const secretPattern = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|ya29\.[\w.-]{12,}|\d{6,16}:[\w-]{25,100})\b/;
  const safeText = (value, limit = 1200) => String(value ?? '').replace(new RegExp(secretPattern.source, 'g'), '[скрыто]').slice(0, limit);

  let current, view, composer, timeline, welcome, chips, picker, pluginButton, sendButton, sidebarButton, connections;
  let googleScript;
  const selected = new Set();

  function node(tag, classes = '', text = '') {
    const el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text) el.textContent = text;
    return el;
  }

  function button(text, classes, handler) {
    const el = node('button', classes, text);
    el.type = 'button';
    el.addEventListener('click', handler);
    return el;
  }

  function iconButton(symbol, label, handler) {
    const el = button(symbol, 'hm-task-icon', handler);
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  function mark(id) {
    const el = node('span', 'hm-task-mark hm-task-mark--' + id, plugins[id].mark);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function providerRow(id, description) {
    const row = node('span', 'hm-task-provider');
    const meta = node('span', 'hm-task-provider-text');
    meta.append(node('strong', '', plugins[id].name), node('small', '', description || plugins[id].description));
    row.append(mark(id), meta);
    return row;
  }

  function isCurrent(session) {
    return session === current && curUser?.id === session?.id;
  }

  async function request(session, action, args = {}) {
    if (!isCurrent(session)) throw Error('Сессия изменилась.');
    const result = await hmUtil('cowork', { body: { ...args, action } });
    if (!isCurrent(session)) throw Error('Сессия изменилась.');
    return result;
  }

  function refreshChips() {
    chips.replaceChildren();
    for (const id of selected) {
      const chip = button('', 'hm-task-chip', () => { selected.delete(id); refreshChips(); composer.focus(); });
      chip.append(mark(id), document.createTextNode(plugins[id].name), node('span', 'hm-task-chip-remove', '×'));
      chip.setAttribute('aria-label', 'Убрать ' + plugins[id].name);
      chips.append(chip);
    }
  }

  function select(id, focus = true) {
    selected.add(id);
    refreshChips();
    if (focus) composer.focus();
  }

  function closePicker() {
    picker.hidden = true;
    pluginButton.setAttribute('aria-expanded', 'false');
  }

  function mentionAtCursor() {
    const before = composer.value.slice(0, composer.selectionStart);
    const match = /(?:^|\s)@([\p{L}]*)$/u.exec(before);
    return match && { query: match[1].toLowerCase(), start: before.length - match[1].length - 1, end: before.length };
  }

  function showPicker(mention = null) {
    picker.replaceChildren(node('strong', 'hm-task-picker-title', 'Плагины'));
    const entries = Object.keys(plugins).filter(id => !mention || [id, ...Object.keys(aliases).filter(key => aliases[key] === id)]
      .some(name => name.startsWith(mention.query)));
    if (!entries.length) { closePicker(); return; }
    for (const id of entries) {
      const item = button('', 'hm-task-option', () => {
        if (mention) composer.setRangeText('', mention.start, mention.end, 'end');
        closePicker();
        select(id);
      });
      item.append(providerRow(id), node('span', '', selected.has(id) ? '✓' : '+'));
      picker.append(item);
    }
    picker.hidden = false;
    pluginButton.setAttribute('aria-expanded', 'true');
  }

  function scroll() {
    timeline.scrollTop = timeline.scrollHeight;
  }

  function turn(role, text) {
    welcome.hidden = true;
    const bubble = node('article', 'hm-task-turn hm-task-turn--' + role);
    bubble.append(node('p', 'hm-task-text', text));
    timeline.append(bubble);
    scroll();
    return bubble;
  }

  function replyIdle(bubble) { bubble.classList.remove('hm-task-running'); }

  function updateTurn(bubble, text) {
    bubble.querySelector('.hm-task-text').textContent = text;
    scroll();
  }

  function showResultDetails(bubble, entries) {
    if (!entries.length || (entries.length === 1 && bubble.querySelector('.hm-task-text').textContent === entries[0].text)) return;
    const detail = node('details', 'hm-task-results');
    detail.append(node('summary', '', 'Результаты плагинов · ' + entries.length));
    for (const entry of entries) {
      const row = node('section', 'hm-task-result');
      row.append(node('strong', '', entry.label), node('p', '', entry.text));
      detail.append(row);
    }
    bubble.append(detail);
  }

  function resultText(action, data) {
    switch (action) {
      case 'github.repo':
        return [data.name, data.description, 'Основная ветка: ' + data.branch,
          ...(data.issues || []).map(item => (item.pullRequest ? 'PR' : 'Issue') + ' #' + item.number + ' · ' + safeText(item.title))]
          .filter(Boolean).map(value => safeText(value)).join('\n');
      case 'gmail.list':
        return (data.messages || []).map((mail, index) => (index + 1) + '. ' + safeText(mail.subject || 'Без темы', 200) +
          '\n' + safeText(mail.from, 160) + (mail.snippet ? '\n' + safeText(mail.snippet, 250) : '')).join('\n\n') || 'Письма не найдены.';
      case 'gmail.read': return safeText(data.text, 8000) || 'Письмо без текста.';
      case 'telegram.inbox':
        return (data.messages || []).slice(-12).map(msg => safeText(msg.title || msg.chat, 100) + ' [' + safeText(msg.chat, 80) + ']\n' +
          safeText(msg.text)).join('\n\n') || 'У бота нет новых сообщений по этому запросу.';
      case 'gmail.send': return 'Письмо отправлено.';
      case 'gmail.trash': return 'Письмо перемещено в корзину.';
      case 'telegram.send': return 'Сообщение отправлено.';
      default: throw Error('Неизвестное действие плагина.');
    }
  }

  function askConfirmation(session, bubble, detail) {
    return new Promise(resolve => {
      const card = node('section', 'hm-task-confirm');
      const controls = node('div', 'hm-task-actions');
      const finish = confirmed => {
        session.cancel = null;
        card.remove();
        resolve(confirmed && isCurrent(session));
      };
      const approve = button('Подтвердить', 'hm-task-primary', () => finish(true));
      const cancel = button('Отменить', 'hm-task-secondary', () => finish(false));
      controls.append(approve, cancel);
      card.append(node('strong', '', 'Подтверди действие'), node('p', '', detail), controls);
      bubble.append(card);
      session.cancel = () => finish(false);
      scroll();
    });
  }

  function checkPlugins(session, steps, active) {
    for (const step of steps) {
      if (!Object.hasOwn(labels, step.action)) throw Error('План содержит неизвестное действие.');
      const id = step.action.split('.')[0];
      if (!active.includes(id)) throw Error('План использует плагин, который не был выбран.');
      if (id !== 'github' && !session.tokens[id]) {
        const error = Error('Подключи ' + plugins[id].name + ', чтобы продолжить.');
        error.plugin = id;
        throw error;
      }
    }
  }

  async function runTask(session, task, active, bubble) {
    const entries = [];
    try {
      const plan = await request(session, 'task.plan', { task, plugins: active, previous: session.previous, hasMailList: !!session.mail.length });
      if (!Array.isArray(plan.steps) || plan.steps.length > 6) throw Error('Не удалось прочитать план задачи.');
      if (plan.question || !plan.steps.length) {
        updateTurn(bubble, plan.question || 'Уточни, что нужно сделать.');
        return;
      }
      checkPlugins(session, plan.steps, active);
      for (const step of plan.steps) {
        const args = { ...step.args };
        const action = step.action;
        const id = action.split('.')[0];
        const mail = action === 'gmail.read' || action === 'gmail.trash' ? session.mail[args.position - 1] : null;
        if (action === 'gmail.read' || action === 'gmail.trash') {
          if (!mail) throw Error('Письмо с таким номером не найдено. Попроси показать письма, затем укажи номер.');
          args.id = mail.id;
        }
        if (writeActions.has(action)) {
          if (args.fromResults) {
            if (!entries.length) throw Error('Нет результатов, из которых можно составить сообщение.');
            updateTurn(bubble, 'Готовлю черновик по результатам');
            const draft = await request(session, 'task.summarize', {
              task,
              draft: true,
              evidence: entries.map(entry => entry.text).join('\n\n')
            });
            if (!draft.text) throw Error('Не удалось подготовить черновик. Попробуй указать текст сообщения.');
            args.message = draft.text;
          }
          const detail = action === 'gmail.trash' ? 'В корзину Gmail: ' + safeText(mail.subject || 'Без темы') + '\n' + safeText(mail.from) :
            action === 'gmail.send' ? 'Кому: ' + args.to + '\nТема: ' + args.subject + '\n\n' + args.message :
              'Чат Telegram: ' + args.chat + '\n\n' + args.message;
          if (secretPattern.test(detail)) throw Error('Сообщение содержит похожий на токен текст. Удали его и попробуй снова.');
          updateTurn(bubble, 'Жду подтверждения');
          if (!(await askConfirmation(session, bubble, detail))) {
            updateTurn(bubble, 'Действие отменено.');
            return;
          }
        }
        updateTurn(bubble, labels[action] + '…');
        const data = await request(session, action, { ...args, token: session.tokens[id] || '' });
        if (action === 'gmail.list') session.mail = data.messages || [];
        entries.push({ label: labels[action], text: resultText(action, data) });
      }
      const last = plan.steps.at(-1);
      if (writeActions.has(last.action) || last.action === 'gmail.list') {
        updateTurn(bubble, entries.at(-1).text);
      } else {
        const evidence = entries.map(entry => entry.text).join('\n\n');
        const summary = await request(session, 'task.summarize', { task, evidence }).catch(() => null);
        updateTurn(bubble, summary?.text || evidence);
      }
    } catch (error) {
      if (!isCurrent(session)) return;
      updateTurn(bubble, safeText(error.message || 'Не удалось выполнить задачу.'));
      if (error.plugin) bubble.append(button('Подключить ' + plugins[error.plugin].name, 'hm-task-secondary',
        () => connect(error.plugin, { task, active })));
    } finally {
      if (isCurrent(session)) {
        showResultDetails(bubble, entries);
        session.previous.push(task);
        session.previous = session.previous.slice(-3);
        replyIdle(bubble);
        session.busy = false;
        sendButton.disabled = false;
        scroll();
      }
    }
  }

  function submit(task, active) {
    if (!current || current.busy || !isCurrent(current)) return;
    if (secretPattern.test(task)) {
      turn('assistant', 'Похоже, в сообщении есть токен. Добавь его через «Подключения».');
      return;
    }
    if (!task.trim()) return;
    for (const id of active) select(id, false);
    if (!active.length) {
      turn('assistant', 'Выбери Gmail, GitHub или Telegram через «+» или @.');
      showPicker();
      return;
    }
    const human = turn('user', task);
    const services = node('div', 'hm-task-turn-plugins');
    for (const id of active) services.append(mark(id));
    human.prepend(services);
    const reply = turn('assistant', 'Составляю план…');
    reply.classList.add('hm-task-running');
    reply.setAttribute('aria-live', 'polite');
    current.busy = true;
    sendButton.disabled = true;
    runTask(current, task, active, reply);
  }

  function send(event) {
    event.preventDefault();
    if (current.busy) return;
    const original = composer.value;
    const active = new Set(selected);
    const task = original.replace(mentionPattern, (whole, space, name) => {
      const key = name.toLowerCase();
      active.add(aliases[key] || key);
      return space;
    }).trim();
    if (!task || !active.size || secretPattern.test(task)) { submit(task, [...active]); return; }
    composer.value = '';
    closePicker();
    submit(task, [...active]);
  }

  function loadGoogle() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (googleScript) return googleScript;
    googleScript = new Promise((resolve, reject) => {
      const script = node('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = resolve;
      script.onerror = () => { script.remove(); googleScript = null; reject(Error('Вход Google сейчас недоступен.')); };
      document.head.append(script);
    });
    return googleScript;
  }

  function connect(id = 'gmail', resume = null) {
    if (!isCurrent(current)) return;
    const session = current;
    if (connections?.open) connections.close();
    const dialog = node('dialog', 'hm-task-dialog');
    connections = dialog;
    const header = node('header', 'hm-task-dialog-header');
    const tabs = node('nav', 'hm-task-connection-tabs');
    const panel = node('section', 'hm-task-connection-panel');
    const status = node('p', 'hm-task-connection-status');
    status.setAttribute('role', 'status');
    header.append(node('h2', '', 'Подключения'), iconButton('×', 'Закрыть', () => dialog.close()));
    dialog.append(header, tabs, panel, status);
    document.body.append(dialog);
    const ready = () => {
      dialog.close();
      if (resume && isCurrent(session)) {
        composer.value = resume.task;
        for (const plugin of resume.active) select(plugin, false);
        composer.focus();
      }
    };
    const render = plugin => {
      panel.replaceChildren();
      status.textContent = '';
      tabs.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.plugin === plugin)));
      const version = panel.appendChild(node('div'));
      if (plugin === 'gmail') {
        version.append(node('p', '', session.tokens.gmail ? 'Gmail подключён на время этой сессии.' : 'Выбери аккаунт Google, чтобы разрешить доступ к Gmail. Задачи могут передавать модели найденные письма для ответа или черновика.'));
        const control = button(session.tokens.gmail ? 'Переподключить Gmail' : 'Подключить Gmail', 'hm-task-primary', () => {
          client?.requestAccessToken();
        });
        let client;
        control.disabled = true;
        version.append(control);
        if (session.tokens.gmail) version.append(button('Отключить', 'hm-task-secondary', () => {
          delete session.tokens.gmail;
          session.mail = [];
          render('gmail');
        }));
        (async () => {
          try {
            const cfg = await request(session, 'config');
            if (!cfg.gmailClientId) throw Error('Подключение Gmail ожидает настройки OAuth.');
            await loadGoogle();
            if (!dialog.open || !version.isConnected) return;
            client = window.google.accounts.oauth2.initTokenClient({
              client_id: cfg.gmailClientId,
              scope: 'https://www.googleapis.com/auth/gmail.modify',
              include_granted_scopes: false,
              callback: reply => {
                if (!isCurrent(session) || !dialog.open || !version.isConnected) return;
                if (!reply.access_token) { status.textContent = 'Gmail не подключён.'; return; }
                session.tokens.gmail = reply.access_token;
                session.mail = [];
                ready();
              },
              error_callback: () => { if (version.isConnected) status.textContent = 'Окно подключения Gmail закрыто.'; }
            });
            control.disabled = false;
          } catch (error) {
            if (version.isConnected) status.textContent = error.message;
          }
        })();
      } else {
        const github = plugin === 'github';
        version.append(node('p', '', github ? 'Публичные репозитории доступны сразу. Для приватного укажи токен с доступом к нужному репозиторию.' :
          'Введи токен бота из BotFather. У бота должен быть доступ к нужному чату. Задачи могут передавать модели найденные сообщения для ответа или черновика.'));
        const field = node('label', 'hm-task-field', github ? 'Токен GitHub' : 'Токен Telegram-бота');
        const input = node('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = session.tokens[plugin] ? 'Токен подключён' : 'Вставь токен';
        field.append(input);
        version.append(field, button('Подключить', 'hm-task-primary', () => {
          const value = input.value.trim();
          const valid = github ? /^[\w.-]{12,2048}$/.test(value) : /^\d{6,16}:[\w-]{25,100}$/.test(value);
          if (!valid) { status.textContent = 'Проверь формат токена.'; return; }
          session.tokens[plugin] = value;
          input.value = '';
          ready();
        }));
        if (session.tokens[plugin]) version.append(button('Отключить', 'hm-task-secondary', () => {
          delete session.tokens[plugin];
          render(plugin);
        }));
      }
    };
    for (const plugin of Object.keys(plugins)) {
      const tab = button(plugins[plugin].name, 'hm-task-secondary', () => render(plugin));
      tab.dataset.plugin = plugin;
      tabs.append(tab);
    }
    dialog.addEventListener('close', () => { dialog.remove(); });
    dialog.showModal();
    render(id);
  }

  function build() {
    view = node('section', 'hm-task-chat');
    view.id = 'hmTasks';
    view.hidden = true;
    view.setAttribute('aria-labelledby', 'hmTasksTitle');
    sidebarButton = document.getElementById('hmTasksNav');
    const header = node('header', 'hm-task-header');
    const start = node('div', 'hm-task-header-start');
    const title = node('h1', '', 'Задачи');
    title.id = 'hmTasksTitle';
    const menu = iconButton('☰', 'Открыть меню', () => toggleSidebar());
    menu.classList.add('hm-task-menu');
    start.append(menu, title);
    const headerActions = node('div', 'hm-task-header-actions');
    headerActions.append(button('Подключения', 'hm-task-secondary', () => connect()), iconButton('×', 'Вернуться к чату', close));
    header.append(start, headerActions);

    timeline = node('div', 'hm-task-timeline');
    timeline.setAttribute('role', 'log');
    timeline.setAttribute('aria-label', 'Переписка в задачах');
    welcome = node('section', 'hm-task-welcome');
    const intro = node('div', 'hm-task-intro');
    const emblem = node('span', 'hm-task-emblem', '✓');
    emblem.setAttribute('aria-hidden', 'true');
    intro.append(emblem, node('h2', '', 'Что нужно сделать?'),
      node('p', '', 'Выбери плагины и опиши результат. Шаги и ответы появятся здесь.'));
    const examples = node('div', 'hm-task-examples');
    for (const id of Object.keys(plugins)) {
      const item = button('', 'hm-task-example', () => { selected.clear(); select(id); composer.value = plugins[id].example; });
      item.append(providerRow(id), node('span', 'hm-task-example-arrow', '↗'));
      examples.append(item);
    }
    welcome.append(intro, examples);
    timeline.append(welcome);

    const form = node('form', 'hm-task-composer');
    const input = node('div', 'hm-task-input');
    composer = node('textarea');
    composer.rows = 2;
    composer.maxLength = 3500;
    composer.placeholder = 'Опиши задачу или напиши @';
    composer.setAttribute('aria-label', 'Текст задачи');
    chips = node('div', 'hm-task-chips');
    const controls = node('div', 'hm-task-controls');
    const startControls = node('div', 'hm-task-control-start');
    picker = node('section', 'hm-task-picker');
    picker.id = 'hmTasksPlugins';
    picker.hidden = true;
    picker.setAttribute('aria-label', 'Плагины');
    pluginButton = iconButton('+', 'Выбрать плагины', () => picker.hidden ? showPicker() : closePicker());
    pluginButton.setAttribute('aria-controls', picker.id);
    pluginButton.setAttribute('aria-expanded', 'false');
    startControls.append(pluginButton, node('span', 'hm-task-plugin-label', 'Плагины'));
    sendButton = node('button', 'hm-task-send', '↑');
    sendButton.type = 'submit';
    sendButton.title = 'Отправить задачу';
    sendButton.setAttribute('aria-label', sendButton.title);
    controls.append(startControls, sendButton);
    input.append(chips, composer, controls, picker);
    form.append(input);
    form.addEventListener('submit', send);
    composer.addEventListener('input', () => {
      const mention = mentionAtCursor();
      if (mention) showPicker(mention);
      else closePicker();
    });
    composer.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { closePicker(); return; }
      if (!picker.hidden && event.key === 'ArrowDown') {
        event.preventDefault();
        picker.querySelector('button')?.focus();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!picker.hidden && mentionAtCursor()) picker.querySelector('button')?.click();
        else form.requestSubmit();
      }
    });
    view.addEventListener('click', event => {
      if (!input.contains(event.target)) closePicker();
    });
    view.append(header, timeline, form);
    document.getElementById('main').append(view);
  }

  function close() {
    if (!view || view.hidden) return;
    view.hidden = true;
    closePicker();
    document.getElementById('main').classList.remove('hm-tasks-open');
    sidebarButton?.removeAttribute('aria-current');
  }

  function open() {
    if (!curUser?.id) return;
    if (!view) build();
    if (current?.id !== curUser.id) {
      current?.cancel?.();
      connections?.close();
      current = { id: curUser.id, tokens: {}, previous: [], mail: [], busy: false, cancel: null };
      timeline.replaceChildren(welcome);
      welcome.hidden = false;
      selected.clear();
      refreshChips();
      composer.value = '';
      sendButton.disabled = false;
    }
    closeSidebar();
    view.hidden = false;
    document.getElementById('main').classList.add('hm-tasks-open');
    sidebarButton?.setAttribute('aria-current', 'page');
    scroll();
    if (!hmIsMobileUI()) composer.focus();
  }

  function reset() {
    current?.cancel?.();
    connections?.close();
    current = null;
    close();
  }

  window.HmCowork = { open, close, reset };
})();
