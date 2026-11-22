(() => {
  const names = { gmail: 'Gmail', github: 'GitHub', telegram: 'Telegram' };
  const pluginName = { gmail: 'gmail', джимейл: 'gmail', github: 'github', гитхаб: 'github', telegram: 'telegram', телеграм: 'telegram', тг: 'telegram' };
  const explicit = /(^|\s)@(gmail|джимейл|github|гитхаб|telegram|телеграм|тг)(?=$|[\s,.:!?])/giu;
  const secret = /\b(?:gh[pousr]_[\w]{16,}|github_pat_[\w]{20,}|ya29\.[\w.-]{12,}|\d{6,16}:[\w-]{25,100})\b/;
  const write = new Set(['gmail.send', 'gmail.trash', 'github.branch', 'github.commit', 'github.pull', 'telegram.send', 'telegram.edit']);
  const supported = new Set([...write, 'github.search', 'github.repo', 'github.file', 'gmail.list', 'gmail.read', 'telegram.dialogs', 'telegram.messages']);
  const contexts = new WeakMap();

  function safe(value, max = 8000) { return String(value ?? '').replace(new RegExp(secret.source, 'g'), '[скрыто]').slice(0, max); }
  function element(tag, classes, text) {
    const el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text) el.textContent = text;
    return el;
  }
  function button(label, action, primary = false) {
    const b = element('button', 'stp-btn ' + (primary ? 'stp-btn-white' : 'hm-plugin-badge--off'), label);
    b.type = 'button';
    b.onclick = action;
    return b;
  }
  function check(job) {
    if (job.user !== curUser?.id || job.history !== chatHistory) throw Error('Чат изменился.');
  }
  async function model(job, action, body) {
    check(job);
    const data = await hmUtil('plugins', { body: { ...body, action } });
    check(job);
    return data;
  }
  function confirm(job, view, title, content) {
    check(job);
    return new Promise(resolve => {
      const card = element('div', 'hm-chat-plugin-confirm');
      const actions = element('div', 'hm-plugin-actions');
      const finish = (ok) => { clearInterval(timer); card.remove(); resolve(ok); };
      const deadline = Date.now() + 90000;
      const timer = setInterval(() => {
        if (job.user !== curUser?.id || job.history !== chatHistory || Date.now() > deadline) finish(false);
      }, 500);
      actions.append(button('Подтвердить', () => finish(true), true), button('Отмена', () => finish(false)));
      card.append(element('strong', '', title));
      if (content) {
        const detail = element('details', 'hm-chat-plugin-preview');
        detail.open = content.length < 1200;
        detail.append(element('summary', '', 'Содержимое'), element('pre', 'hm-chat-plugin-result', content));
        card.append(detail);
      }
      card.append(actions);
      view.slot.replaceChildren(card);
      scrollChat();
    });
  }

  async function telegramStep(job, api, action, args, view) {
    const state = job.state;
    if (action === 'telegram.dialogs') {
      const rows = await api.dialogs(job.user);
      check(job);
      state.dialogs = rows;
      return rows.map(c => safe(c.name, 150) + ' [' + safe(c.id, 70) + ']').join('\n');
    }
    const name = String(args.chat).toLowerCase();
    let target = /^(?:me|избранное|saved messages)$/.test(name) ? { id: 'me', name: 'Избранное' } : null;
    if (!target) {
      state.dialogs = await api.dialogs(job.user);
      check(job);
      const matches = state.dialogs.filter(c => c.id === args.chat || c.name.toLowerCase() === name);
      if (matches.length !== 1) throw Error('Укажи точное название или ID чата Telegram. Могу сначала показать список чатов.');
      [target] = matches;
    }
    if (action === 'telegram.messages') {
      const rows = await api.messages(job.user, target.id);
      check(job);
      state.telegramMail = { id: target.id, rows };
      return rows.map((m, i) => (i + 1) + '. ' + (m.outgoing ? 'Моё: ' : '') + safe(m.text, 1500)).join('\n') || 'Текстовых сообщений нет.';
    }
    const previous = state.telegramMail?.id === target.id && state.telegramMail.rows[args.position - 1];
    if (action === 'telegram.edit' && !previous?.outgoing) throw Error('Сначала покажи сообщения в этом чате, затем укажи номер своего сообщения.');
    const edit = action === 'telegram.edit';
    if (secret.test(args.message)) throw Error('Сообщение похоже на секрет. Укажи другой текст.');
    if (!await confirm(job, view, (edit ? 'Изменить сообщение в Telegram · ' : 'Отправить в Telegram · ') + safe(target.name, 160), args.message)) return null;
    check(job);
    await api.send(job.user, target.id, args.message, edit ? previous.id : undefined);
    return edit ? 'Сообщение Telegram изменено.' : 'Сообщение отправлено в «' + safe(target.name, 150) + '».';
  }

  function result(action, data) {
    if (action === 'github.search') return (data.repos || []).map(item => safe(item.name, 200) + ' · ' + safe(item.description, 260)).join('\n') || 'Репозитории не найдены.';
    if (action === 'github.repo') return [safe(data.name), safe(data.description), 'Основная ветка: ' + safe(data.branch), ...(data.issues || []).map(i => (i.pullRequest ? 'PR' : 'Issue') + ' #' + i.number + ' · ' + safe(i.title))].filter(Boolean).join('\n');
    if (action === 'github.file') return safe(data.content, 19000) || 'Файл пуст.';
    if (action === 'gmail.list') return (data.messages || []).map((m, i) => (i + 1) + '. ' + safe(m.subject || 'Без темы', 220) + '\n' + safe(m.from, 160) + '\n' + safe(m.snippet, 250)).join('\n\n') || 'Письма не найдены.';
    if (action === 'gmail.read') return safe(data.text, 12000) || 'Письмо без текста.';
    if (action === 'gmail.send') return 'Письмо Gmail отправлено.';
    if (action === 'gmail.trash') return 'Письмо перемещено в корзину.';
    if (action === 'github.branch') return 'Создана ветка ' + safe(data.branch) + '.';
    if (action === 'github.commit') return 'Коммит сохранён: ' + safe(data.commit, 40) + '.';
    if (action === 'github.pull') return 'Открыт pull request #' + Number(data.number) + '.';
    throw Error('Неизвестный результат плагина.');
  }
  async function execute(job, step, entries, view) {
    const { action } = step, args = { ...step.args };
    const id = action.split('.')[0];
    const access = await window.HmPlugins.chatAccess(id, write.has(action));
    check(job);
    view.set('Работаю с ' + names[id] + '…');
    if (args.fromResults) {
      const evidence = entries.map(e => e.text).join('\n\n');
      if (!evidence) throw Error('Нет результатов, из которых можно составить сообщение.');
      args.message = (await model(job, 'chat.response', { task: job.task, evidence, mode: 'draft' })).text;
      if (!args.message) throw Error('Не удалось подготовить текст. Напиши, что отправить.');
    }
    if (id === 'telegram') {
      const text = await telegramStep(job, access.telegram, action, args, view);
      return text === null ? null : { action, text };
    }
    let mail;
    if (action === 'gmail.read' || action === 'gmail.trash') {
      mail = job.state.gmail[args.position - 1];
      if (!mail) throw Error('Сначала попроси показать список писем, затем укажи номер.');
      args.id = mail.id;
    }
    if (write.has(action)) {
      let title, preview;
      if (action === 'github.commit') {
        const current = await access.invoke('github.file', { repo: args.repo, branch: args.branch, path: args.path });
        check(job);
        if (current.content.length > 18000) throw Error('Изменения через чат доступны для файлов до 18 000 символов.');
        if (secret.test(current.content)) throw Error('В файле обнаружен похожий на секрет текст. Я не буду передавать файл модели.');
        const generated = await model(job, 'chat.response', { task: args.instruction, evidence: 'FILE ' + args.path + '\n' + current.content, mode: 'code' });
        if (!generated.text || secret.test(generated.text)) throw Error('Не удалось подготовить безопасную полную версию файла.');
        if (generated.text === current.content) throw Error('Файл остался без изменений.');
        args.content = /\r\n/.test(current.content) && !/(?<!\r)\n/.test(current.content)
          ? generated.text.replace(/\r?\n/g, '\r\n') : generated.text;
        args.sha = current.sha;
        title = 'Коммит в ' + args.repo + ' · ' + args.branch + ' · ' + args.path;
        preview = 'Сообщение коммита: ' + args.message + '\n\n' + args.content;
      } else if (action === 'github.branch') {
        title = 'Создать ветку ' + args.branch + ' от ' + args.base + ' в ' + args.repo;
      } else if (action === 'github.pull') {
        title = 'Открыть PR в ' + args.repo + ' · ' + args.head + ' → ' + args.base;
        preview = args.title + (args.description ? '\n\n' + args.description : '');
      } else if (action === 'gmail.send') {
        title = 'Отправить письмо через Gmail · ' + args.to;
        preview = args.subject + '\n\n' + args.message;
      } else {
        title = 'Переместить письмо Gmail в корзину';
        preview = safe(mail.subject || 'Без темы', 220) + '\n' + safe(mail.from, 160);
      }
      if (secret.test(title) || secret.test(preview || '')) throw Error('Действие содержит похожий на токен текст.');
      if (!await confirm(job, view, title, preview)) return null;
      check(job);
    }
    const data = await access.invoke(action, args);
    check(job);
    if (action === 'gmail.list') job.state.gmail = data.messages || [];
    const entry = { action, text: result(action, data) };
    if (action === 'github.pull' && Number.isSafeInteger(Number(data.number))) {
      const slug = args.repo.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
      if (/^[\w-]+\/[\w.-]+$/.test(slug)) entry.link = 'https://github.com/' + slug + '/pull/' + Number(data.number);
    }
    return entry;
  }

  function requestSelection(text, forced, state) {
    const plugins = new Set(forced ? [forced] : []);
    const task = text.replace(explicit, (matched, space, key) => { plugins.add(pluginName[key.toLowerCase()]); return space; }).trim();
    if (!plugins.size && /(?:покажи|найди|прочита|отправ|создай|проверь|измен|открой|сделай|удали|перемести|посмотри|\b(?:read|find|show|send|open|create|edit|search)\b)/iu.test(task)) {
      for (const [id, pattern] of Object.entries({
        gmail: /gmail|джимейл/iu, github: /github|гитхаб/iu, telegram: /telegram|телеграм|(?:^|\s)тг(?=\s|$)/iu
      })) if (pattern.test(task)) plugins.add(id);
      if (!plugins.size && /^(?:прочитай|покажи|перемести|открой|измени|отправь)\s+(?:его|её|это|последн|перв|втор|треть|(?:письмо|сообщение)\s*№?\d)/iu.test(task)) {
        for (const id of state?.plugins || []) plugins.add(id);
      }
    }
    return { task, plugins: [...plugins].filter(id => Object.hasOwn(names, id)) };
  }

  async function route(text, forced = '') {
    const history = chatHistory;
    const previousState = contexts.get(history);
    const { task, plugins } = requestSelection(text, forced, previousState);
    if (!plugins.length) return false;
    if (secret.test(text)) { toast('Токены добавляются через Настройки → Плагины.'); return true; }
    const state = previousState || { gmail: [], previous: [], telegramMail: null, plugins: [], busy: false };
    if (state.busy) { toast('Плагин ещё выполняет предыдущий запрос.'); return true; }
    if (!curUser?.id) return false;
    const job = { user: curUser.id, history, task, state, plugins };
    contexts.set(history, state);
    state.busy = true;
    state.plugins = plugins;
    hmTmUserTurn(text);
    const label = plugins.map(id => names[id]).join(' · ');
    const view = hmPlugin('chat_plugins', '');
    const entries = [];
    const finish = (answer, link) => view.finish(answer, { plain: true, link, historyContent: label + ' · результат показан в текущей сессии.' });
    try {
      view.set('Составляю план · ' + label);
      const plan = await model(job, 'chat.plan', { task, plugins, previous: state.previous, hasMailList: state.gmail.length > 0 });
      if (plan.question || !plan.steps?.length) {
        finish(safe(plan.question || 'Уточни, что нужно сделать.'));
        return true;
      }
      if (plan.steps.length > 6 || plan.steps.some(step => !supported.has(step.action) || !plugins.includes(step.action.split('.')[0]))) throw Error('План вышел за рамки подключённых плагинов.');
      for (const step of plan.steps) {
        const entry = await execute(job, step, entries, view);
        if (!entry) {
          finish([...entries.map(e => e.text), 'Действие отменено.'].join('\n\n'));
          return true;
        }
        entries.push(entry);
      }
      const last = entries.at(-1);
      const evidence = entries.map(e => e.text).join('\n\n');
      const useModel = !entries.some(e => write.has(e.action)) && !['gmail.list', 'telegram.messages', 'telegram.dialogs', 'github.file'].includes(last.action);
      if (useModel) {
        view.set('Готовлю ответ…');
        const response = await model(job, 'chat.response', { task, evidence }).catch(() => null);
        finish(safe(response?.text || evidence, 19000));
      } else {
        const actions = entries.filter(e => write.has(e.action));
        const completed = actions.length && write.has(last.action) ? actions.map(e => e.text).join('\n') : evidence;
        finish(completed, entries.findLast(e => e.link)?.link);
      }
    } catch (error) {
      const text = safe(error.message || 'Не удалось выполнить действие плагина.');
      finish(entries.length ? 'Выполнено до ошибки:\n' + entries.map(e => e.text).join('\n') + '\n\n' + text : text);
      if (error.pluginId && history === chatHistory && job.user === curUser?.id) {
        const open = button('Подключить ' + names[error.pluginId], () => {
          openSettings();
          window.HmPlugins.detail(error.pluginId);
        }, true);
        view.shell.msg.append(open);
      }
    } finally {
      if (task) state.previous = [...state.previous, task].slice(-3);
      state.busy = false;
    }
    return true;
  }
  window.HmChatPlugins = { route };
})();
