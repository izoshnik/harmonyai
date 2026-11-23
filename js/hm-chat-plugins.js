(() => {
  const names = { gmail: 'Gmail', github: 'GitHub', telegram: 'Telegram', funpay: 'FunPay' };
  const pluginName = { gmail: 'gmail', джимейл: 'gmail', github: 'github', гитхаб: 'github', telegram: 'telegram', телеграм: 'telegram', тг: 'telegram', funpay: 'funpay', фанпей: 'funpay', фанпэй: 'funpay' };
  const explicit = /(^|\s)@(gmail|джимейл|github|гитхаб|telegram|телеграм|тг|funpay|фанпей|фанпэй)(?=$|[\s,.:!?])/giu;
  const secret = /\b(?:gh[pousr]_[\w]{16,}|github_pat_[\w]{20,}|ya29\.[\w.-]{12,}|\d{6,16}:[\w-]{25,100}|golden_key\s*[:=]\s*[\w.%+~-]{8,})\b/i;
  const write = new Set(['gmail.send', 'gmail.trash', 'github.branch', 'github.commit', 'github.pull', 'telegram.send', 'telegram.edit',
    'funpay.publish', 'funpay.edit', 'funpay.delete', 'funpay.stock', 'funpay.automation.rule']);
  const supported = new Set([...write, 'github.search', 'github.repo', 'github.file', 'gmail.list', 'gmail.read', 'telegram.dialogs', 'telegram.messages', 'funpay.automation.status']);
  const progress = {
    'gmail.list': ['Ищу письма в Gmail…', 'Проверяю папку и фильтры…', 'Собираю список писем…'],
    'gmail.read': ['Открываю письмо…', 'Читаю письмо Gmail…', 'Распознаю текст и заголовки…'],
    'gmail.send': ['Отправляю письмо через Gmail…', 'Жду подтверждения доставки запроса…'],
    'gmail.trash': ['Перемещаю письмо в корзину Gmail…', 'Проверяю ответ Gmail…'],
    'github.search': ['Ищу репозитории GitHub…', 'Проверяю совпадения…'],
    'github.repo': ['Открываю репозиторий…', 'Собираю список issues и pull requests…'],
    'github.file': ['Открываю файл в GitHub…', 'Читаю содержимое файла…'],
    'github.branch': ['Создаю ветку на GitHub…', 'Проверяю ответ GitHub…'],
    'github.commit': ['Сохраняю коммит на GitHub…', 'Жду подтверждения коммита…'],
    'github.pull': ['Открываю pull request…', 'Жду ссылку от GitHub…'],
    'telegram.dialogs': ['Открываю Telegram…', 'Получаю список чатов…'],
    'telegram.messages': ['Нахожу чат Telegram…', 'Читаю сообщения…'],
    'telegram.send': ['Отправляю сообщение в Telegram…', 'Жду подтверждения Telegram…'],
    'telegram.edit': ['Обновляю сообщение Telegram…', 'Проверяю ответ Telegram…'],
    'funpay.publish': ['Открываю раздел FunPay…', 'Публикую предложение на FunPay…', 'Жду подтверждения от FunPay…'],
    'funpay.edit': ['Открываю предложение FunPay…', 'Сохраняю изменения…', 'Проверяю ответ FunPay…'],
    'funpay.delete': ['Проверяю предложение FunPay…', 'Удаляю предложение…', 'Жду подтверждения удаления…'],
    'funpay.stock': ['Проверяю настройки автовыдачи…', 'Пополняю запас товара…', 'Жду подтверждения остатка…'],
    'funpay.automation.rule': ['Настраиваю автоматизацию FunPay…', 'Сохраняю правило…'],
    'funpay.automation.status': ['Проверяю фоновое подключение FunPay…']
  };
  const contexts = new WeakMap();

  function safe(value, max = 8000) { return String(value ?? '').replace(new RegExp(secret.source, 'gi'), '[скрыто]').slice(0, max); }
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
    view.set('Жду подтверждения…');
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

  async function funpayStep(job, access, action, args, view) {
    const addStock = action === 'funpay.stock';
    const publish = action === 'funpay.publish';
    const remove = action === 'funpay.delete';
    if (publish && !/^[1-9]\d{0,11}$/.test(args.node || '')) throw Error('Сначала укажи, в каком разделе FunPay опубликовать предложение.');
    if (secret.test(args.title || '') || secret.test(args.description || '')) throw Error('В открытых полях товара обнаружены данные, похожие на токен.');
    check(job);
    view.cycle(publish && args.stock ? ['Открываю раздел FunPay…', 'Публикую товар с автовыдачей…', 'Проверяю результат FunPay…'] : progress[action]);
    const data = await access.invoke(action, args);
    check(job);
    if (action === 'funpay.automation.rule') {
      const rules = { message: 'Автоответ на сообщения', confirmed: 'Сообщение после подтверждения', review: 'Публичный ответ на отзыв' };
      const rule = rules[data.rule] || 'Команда ' + safe(data.rule, 30);
      return { action, text: rule + (data.removed ? ' · отключено.' : ' · сохранено на сервере.') };
    }
    if (action === 'funpay.automation.status') {
      const detail = !data.available ? 'Серверная автоматизация ещё не настроена.' : !data.enabled ? 'Серверное подключение FunPay выключено.' :
        data.ready ? 'Серверное подключение FunPay работает.' : 'Ожидается успешная фоновая проверка FunPay.';
      const pending = data.pending?.map(item => safe(item.event, 60) + ' · ' + (item.state === 'waiting' ? 'нет позиций в запасе' : 'проверь результат на FunPay'));
      return { action, text: [detail, data.issue, data.rules?.length && 'Включены правила: ' + data.rules.join(', '),
        pending?.length && 'Требуют проверки:\n' + pending.join('\n')].filter(Boolean).join('\n') };
    }
    const offer = /^[1-9]\d{0,11}$/.test(data?.offer || '') ? data.offer : '';
    if (!offer) throw Object.assign(Error('FunPay не вернул ID предложения. Проверь список своих предложений перед повтором.'),
      { code: publish ? 'FUNPAY_PUBLICATION_UNCONFIRMED' : undefined });
    const stockStatus = Number.isInteger(data.added) ? (data.delivery === 'server' ? ' Выдача через сервер HarmonyAI.' : ' Автовыдача FunPay включена.') +
      ' Добавлено позиций: ' + data.added + '.' + (data.sku ? ' Артикул: HA-' + data.sku + '.' : '') : '';
    const text = addStock ? 'Предложение №' + offer + '.' + stockStatus :
      publish ? 'Опубликовано предложение №' + offer + '.' :
        'Предложение №' + offer + (remove ? ' удалено.' : ' обновлено.');
    const link = remove ? '' : 'https://funpay.com/lots/offer?id=' + offer;
    return { action, text: text + (addStock ? '' : stockStatus), link, linkLabel: 'Открыть предложение FunPay' };
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
    view.cycle(progress[action]);
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
    if (id === 'funpay') return funpayStep(job, access, action, args, view);
    if (!write.has(action) || id === 'telegram') view.cycle(progress[action]);
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
        view.cycle(['Читаю текущую версию файла…', 'Готовлю изменения к коммиту…']);
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
      view.cycle(progress[action]);
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

  const funpayName = /funpay|фанпей|фанпэй/iu;
  const operationWords = /(?:покажи|найди|прочита|отправ|создай|проверь|измен|открой|сделай|удали|перемести|посмотри|добав|пополни|публику|выстав|вылож|отредактир|настрой|поставь|отключи|автоответ|\b(?:read|find|show|send|open|create|edit|search|publish|delete|stock)\b)/iu;

  function listingRequest(text) {
    return /(?:лот|товар|предложени|listing|offer|пополни)/iu.test(text) &&
      /(?:авто[\s-]*выдач|auto[\s-]*delivery|раздел[а-яё]*\s+[^\n].{0,130}(?:→|[-–—]))/iu.test(text);
  }

  function publicationTitle(text) {
    const task = text.replace(explicit, '$1').trim();
    if (!/^(?:создай|опубликуй|выставь|выложи|добавь|create|publish)\s+(?:(?:новый|новое|новую|a|new)\s+)*(?:предложение|предлоежние|объявление|лот|товар|offer|listing)(?=$|[\s,.:;!?])/iu.test(task)) return '';
    const field = task.match(/(?:^|[\n,.;])[ \t]*(?:название|заголовок|title)(?:[ \t]*[:—–-][ \t]*|[ \t]+)([^\r\n]+)/iu)?.[1];
    const title = field?.split(/[,.;]\s*(?=(?:цена|описание|категория|раздел|количество|автовыдача|price|description|category|amount|stock)(?=[:\s]))/iu, 1)[0];
    return title?.trim().replace(/^["«“]+|["»”]+$/gu, '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || '';
  }

  function retryConfirmed(text) {
    return /^(?:(?:я\s+)?проверил[аи]?[.,\s]+)?(?:(?:лота|лотов|предложения|предложений)(?:\s+у\s+меня)?\s+нет|список(?:\s+предложений)?\s+пуст)[\s.!]*$/iu.test(text.trim());
  }

  function followUp(text) {
    const task = text.trim().replace(/[.?!]+$/u, '').replace(/\s+(?:на|в)\s+(?:funpay|фанпей|фанпэй)$/iu, '');
    const short = task.replace(/^(?:(?:так|ну|да|давай|тогда|пожалуйста|ты)[,\s]+){1,5}/iu, '');
    if (retryConfirmed(short) ||
        /^(?:(?:попробуй|попробуйте|сделай)\s+(?:(?:еще|ещё)\s+раз|снова)(?:\s+(?:выставить|опубликовать)(?:\s+(?:лот|предложение))?)?|(?:повтори|продолжи)(?:\s+публикацию)?|(?:выстав[ьи]|выставляй|опубликуй|публикуй|выложи|создай|добавь)(?:\s+(?:его|это|лот|товар|пр[е]?дл[а-яё]{3,14}))?|try again|publish it)$/iu.test(short)) return 'write';
    if (/(?:^|\n)\s*(?:автовыдач|позици|выдавай|выдавать|цена|количество|названи|описани|раздел|подраздел)|→|\s>\s|^https:\/\/funpay\.com\/|^\s*(?:№\s*)?[1-9]\d{0,11}\s*$/iu.test(task)) return 'details';
    return '';
  }

  function funpayContext(history) {
    const later = [];
    let outcome, link, linked = false;
    for (const item of history.slice(-12).reverse()) {
      const text = typeof item.content === 'string' ? item.content.trim() : '';
      if (item.role === 'assistant') {
        linked = Boolean(item.funpayReply);
        if (linked && !outcome) {
          link = item.funpayReply.link;
          outcome = item.funpayReply.outcome ||
            (/^(?:FunPay не подтвердил публикацию|FunPay сохранил черновик|FunPay не вернул ID предложения)/i.test(text) ? 'uncertain' :
              link && /опубликован|публикация завершена/i.test(text) ? 'published' : 'open');
        }
        continue;
      }
      if (item.role !== 'user' || !text) break;
      const anchor = /(?:^|\s)@(?:funpay|фанпей|фанпэй)(?=$|[\s,.:!?])/iu.test(text) ||
        (operationWords.test(text) && (funpayName.test(text) || listingRequest(text)));
      if (anchor) return { outcome, link, requests: [item.content, ...later.slice(0, 2).reverse()] };
      const kind = followUp(text);
      if (!linked && !kind) break;
      if (kind !== 'write') later.push(item.content);
      linked = false;
    }
    return null;
  }

  function requestSelection(text, forced, state, history) {
    const plugins = new Set(forced ? [forced] : []);
    const task = text.replace(explicit, (matched, space, key) => { plugins.add(pluginName[key.toLowerCase()]); return space; }).trim();
    if (!plugins.size && operationWords.test(task)) {
      if (listingRequest(task)) plugins.add('funpay');
      for (const [id, pattern] of Object.entries({
        gmail: /gmail|джимейл/iu, github: /github|гитхаб/iu, telegram: /telegram|телеграм|(?:^|\s)тг(?=\s|$)/iu,
        funpay: funpayName
      })) if (!plugins.has('funpay') && pattern.test(task)) plugins.add(id);
      if (!plugins.size && /^(?:прочитай|покажи|перемести|открой|измени|отправь)\s+(?:его|её|это|последн|перв|втор|треть|(?:письмо|сообщение)\s*№?\d)/iu.test(task)) {
        for (const id of state?.plugins || []) if (id !== 'funpay') plugins.add(id);
      }
    }
    const context = !plugins.size || plugins.has('funpay') ? funpayContext(history) : null;
    const kind = followUp(task);
    if (!plugins.size && context && kind) plugins.add('funpay');
    const anchor = context?.requests[0]?.replace(explicit, '$1').trim();
    const title = anchor ? publicationTitle(task) : '';
    const previousTitle = title ? publicationTitle(anchor) : '';
    const sameListing = title && previousTitle ? title === previousTitle : Boolean(kind || task === anchor);
    const continuation = context && plugins.has('funpay') && sameListing;
    return { task, plugins: [...plugins].filter(id => Object.hasOwn(names, id)), context: continuation ? context : null };
  }

  async function route(text, forced = '') {
    const history = chatHistory;
    const user = curUser?.id;
    const previousState = contexts.get(history);
    const { task, plugins, context } = requestSelection(text, forced, previousState, history);
    if (!plugins.length || !user) return false;
    if (secret.test(text) && !plugins.includes('funpay')) { toast('Токены добавляются через Настройки → Плагины.'); return true; }
    const state = previousState || { gmail: [], previous: [], telegramMail: null, plugins: [], busy: false };
    if (state.busy) { toast('Плагин ещё выполняет предыдущий запрос.'); return true; }
    const isFunPay = plugins.includes('funpay');
    const job = { user, history, task: isFunPay ? text : task, state, plugins };
    contexts.set(history, state);
    state.busy = true;
    state.plugins = plugins;
    hmTmUserTurn(text);
    const label = plugins.map(id => names[id]).join(' · ');
    const view = hmPlugin('chat_plugins', '');
    const entries = [];
    let outcome = context?.outcome === 'uncertain' ? 'uncertain' : undefined;
    const finish = (answer, result, factsOnly = false) => view.finish(answer, { plain: !isFunPay, funpayReply: isFunPay, factsOnly, funpayOutcome: outcome, link: result?.link, linkLabel: result?.linkLabel,
      historyContent: isFunPay ? answer : label + ' · результат показан в текущей сессии.' });
    const answerFunPay = async (evidence, result) => {
      view.cycle(['Готовлю ответ по FunPay…', 'Сверяю результат…']);
      const response = await model(job, 'chat.response', { task: 'Ответь пользователю по результату запроса к FunPay.', evidence, mode: 'funpay' }).catch(() => null);
      finish(safe(response?.text || evidence), result);
    };
    try {
      if (context?.outcome === 'restricted') {
        outcome = 'restricted';
        finish('HarmonyAI не публикует материалы для обхода защит и вредоносные инструменты.', undefined, true);
        return true;
      }
      if (context?.outcome === 'published') {
        outcome = 'published';
        finish('Предложение уже опубликовано.', context.link ? { link: context.link } : undefined, true);
        return true;
      }
      view.cycle(['Составляю план · ' + label, 'Уточняю параметры запроса…', 'Подбираю действия плагина…']);
      const plan = await model(job, 'chat.plan', { task: job.task, plugins, previous: isFunPay ? context?.requests || [] : state.previous, hasMailList: state.gmail.length > 0 });
      if (plan.code === 'FUNPAY_RESTRICTED_LISTING') {
        outcome = 'restricted';
        finish(safe(plan.issue), undefined, true);
        return true;
      }
      if (context?.outcome === 'uncertain' && !retryConfirmed(task)) {
        outcome = 'uncertain';
        finish('FunPay не подтвердил предыдущую публикацию. Проверь список предложений. Если он пуст, напиши «Проверил, список пуст».', undefined, true);
        return true;
      }
      if (plan.question || plan.issue || !plan.steps?.length) {
        if (isFunPay) outcome = 'open';
        if (plan.question || !isFunPay) finish(safe(plan.question || 'Уточни, что нужно сделать.'));
        else await answerFunPay(plan.issue || 'Задача по FunPay требует уточнения. Спроси пользователя, что нужно сделать с предложением.');
        return true;
      }
      if (plan.steps.length > 6 || plan.steps.some(step => !supported.has(step.action) || !plugins.includes(step.action.split('.')[0]))) throw Error('План вышел за рамки подключённых плагинов.');
      for (const step of plan.steps) {
        const entry = await execute(job, step, entries, view);
        if (!entry) {
          const evidence = [...entries.map(e => e.text), 'Действие отменено.'].join('\n\n');
          finish(evidence, isFunPay ? entries.findLast(e => e.link) : undefined, isFunPay);
          return true;
        }
        entries.push(entry);
        if (entry.action === 'funpay.publish') outcome = 'published';
      }
      const last = entries.at(-1);
      const evidence = entries.map(e => e.text).join('\n\n');
      const useModel = !entries.some(e => write.has(e.action)) && !['gmail.list', 'telegram.messages', 'telegram.dialogs', 'github.file'].includes(last.action);
      if (isFunPay) {
        await answerFunPay(evidence, entries.findLast(e => e.link));
      } else if (useModel) {
        view.cycle(['Готовлю ответ…', 'Собираю результаты…']);
        const response = await model(job, 'chat.response', { task, evidence }).catch(() => null);
        finish(safe(response?.text || evidence, 19000));
      } else {
        const actions = entries.filter(e => write.has(e.action));
        const completed = actions.length && write.has(last.action) ? actions.map(e => e.text).join('\n') : evidence;
        finish(completed, entries.findLast(e => e.link));
      }
    } catch (error) {
      if (error.code === 'FUNPAY_PUBLICATION_UNCONFIRMED') outcome = 'uncertain';
      else if (error.code === 'FUNPAY_RESTRICTED_LISTING') outcome = 'restricted';
      else if (error.code === 'FUNPAY_SAVE_REJECTED' && outcome !== 'published') outcome = 'rejected';
      const text = safe(error.message || 'Не удалось выполнить действие плагина.');
      const evidence = entries.length ? 'Выполнено до ошибки:\n' + entries.map(e => e.text).join('\n') + '\n\n' + text : text;
      finish(evidence, isFunPay ? entries.findLast(e => e.link) : undefined, isFunPay);
      if (error.pluginId && history === chatHistory && job.user === curUser?.id) {
        const open = button('Подключить ' + names[error.pluginId], () => {
          openSettings();
          window.HmPlugins.detail(error.pluginId);
        }, true);
        view.shell.msg.append(open);
      }
    } finally {
      if (!isFunPay && task) state.previous = [...state.previous, task].slice(-3);
      state.busy = false;
    }
    return true;
  }
  window.HmChatPlugins = { route,
    hasFunPayKey(text) { return /\bgolden[_\s-]key\s*[:=]\s*[\w.%+~-]{8,}/i.test(text) || window.HmPlugins?.containsFunPayKey(text); }
  };
})();
