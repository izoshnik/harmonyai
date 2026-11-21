(() => {
  let dialog;
  let googleClient;
  let gmailToken = '';
  let googleScript;
  let sessionUser = '';

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function button(label, action) {
    const control = element('button', label);
    control.type = 'button';
    control.onclick = action;
    return control;
  }

  function field(parent, label, type = 'text') {
    const wrapper = element('label', label);
    const input = element(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.autocomplete = 'off';
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function call(action, args = {}) {
    return hmUtil('cowork', { body: { action, ...args } });
  }

  function loadGoogle() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (googleScript) return googleScript;
    googleScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        googleScript = null;
        reject(new Error('Вход Google сейчас недоступен.'));
      };
      document.head.append(script);
    });
    return googleScript;
  }

  function build() {
    dialog = element('dialog');
    dialog.className = 'hm-cowork';
    dialog.setAttribute('aria-label', 'Задачи CoWork');
    const header = element('header');
    header.append(element('h2', 'Задачи · CoWork'), button('Закрыть', () => dialog.close()));
    const status = element('p');
    status.className = 'hm-cowork-status';
    status.setAttribute('role', 'status');
    const output = element('div');
    output.className = 'hm-cowork-output';
    const tabs = element('nav');
    const panel = element('div');
    dialog.append(header, tabs, panel, status, output);
    document.body.append(dialog);

    let busy = false;
    let view = 'GitHub';
    async function run(work) {
      if (busy) return;
      busy = true;
      status.textContent = 'Выполняю…';
      try { await work(); status.textContent = ''; }
      catch (error) { status.textContent = error.message || 'Операция не выполнена.'; }
      finally { busy = false; }
    }
    function showText(text) {
      output.replaceChildren(element('pre', text || 'Нет данных.'));
    }

    function showGithub() {
      const repo = field(panel, 'Репозиторий');
      repo.placeholder = 'владелец/репозиторий';
      const token = field(panel, 'Токен для приватного репозитория (необязательно)', 'password');
      panel.append(button('Проверить репозиторий', () => run(async () => {
        const result = await call('github.repo', { repo: repo.value.trim(), token: token.value });
        showText([result.name, result.description, 'Основная ветка: ' + result.branch, '', ...result.issues.map(item => (item.pullRequest ? 'PR' : 'Issue') + ' #' + item.number + ' · ' + item.title)].filter(line => line != null).join('\n'));
      })));
    }

    function showGmail() {
      const connect = button(gmailToken ? 'Переподключить Gmail' : 'Подключить Gmail', () => {
        if (googleClient) googleClient.requestAccessToken();
      });
      connect.disabled = !googleClient;
      panel.append(connect);
      if (!googleClient) run(async () => {
        const config = await call('config');
        if (!config.gmailClientId) throw new Error('Подключение Gmail ожидает настройки OAuth.');
        await loadGoogle();
        googleClient = window.google.accounts.oauth2.initTokenClient({
          client_id: config.gmailClientId,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
          include_granted_scopes: false,
          callback: response => {
            gmailToken = response.access_token || '';
            status.textContent = gmailToken ? 'Gmail подключён на время этой сессии.' : 'Gmail не подключён.';
            if (view === 'Gmail') connect.textContent = gmailToken ? 'Переподключить Gmail' : 'Подключить Gmail';
          },
          error_callback: () => { status.textContent = 'Окно подключения Gmail закрыто.'; }
        });
        connect.disabled = false;
      });
      const list = spam => run(async () => {
        const result = await call('gmail.list', { token: gmailToken, spam });
        output.replaceChildren();
        if (!result.messages.length) showText(spam ? 'Спам пуст.' : 'Входящие пусты.');
        for (const message of result.messages) {
          const row = element('article');
          const read = element('pre');
          row.append(element('strong', message.subject || 'Без темы'), element('p', message.from), element('p', message.snippet));
          row.append(button('Читать', () => run(async () => {
            const result = await call('gmail.read', { token: gmailToken, id: message.id });
            read.textContent = result.text;
          })));
          if (spam) row.append(button('В корзину', () => {
            if (!window.confirm('Переместить выбранное письмо в корзину Gmail?')) return;
            run(async () => { await call('gmail.trash', { token: gmailToken, id: message.id }); row.remove(); });
          }));
          row.append(read); output.append(row);
        }
      });
      panel.append(button('Входящие', () => list(false)), button('Проверить спам', () => list(true)));
      const to = field(panel, 'Получатель', 'email');
      const subject = field(panel, 'Тема');
      subject.maxLength = 120;
      const message = field(panel, 'Текст письма', 'textarea');
      message.maxLength = 20000;
      panel.append(button('Отправить письмо', () => {
        if (!to.validity.valid || !to.value.trim() || !subject.value.trim() || !message.value.trim()) {
          status.textContent = 'Заполни адрес, тему и текст.';
          return;
        }
        if (!window.confirm('Отправить письмо на ' + to.value + '?')) return;
        run(async () => {
          await call('gmail.send', { token: gmailToken, to: to.value, subject: subject.value, message: message.value });
          showText('Письмо отправлено.');
        });
      }));
    }

    function showTelegram() {
      const token = field(panel, 'Токен Telegram-бота', 'password');
      const chat = field(panel, 'ID чата');
      const message = field(panel, 'Сообщение', 'textarea');
      message.maxLength = 4000;
      panel.append(button('Читать обновления', () => run(async () => {
        const result = await call('telegram.inbox', { token: token.value });
        showText(result.messages.map(item => (item.title || item.chat) + ' [' + item.chat + ']\n' + item.text).join('\n\n'));
      })), button('Отправить сообщение', () => {
        if (!chat.value.trim() || !message.value.trim()) { status.textContent = 'Укажи ID чата и сообщение.'; return; }
        if (!window.confirm('Отправить сообщение в чат ' + chat.value + '?')) return;
        run(async () => {
          await call('telegram.send', { token: token.value, chat: chat.value, message: message.value });
          showText('Сообщение отправлено.');
        });
      }));
    }

    function select(name) {
      if (busy) return;
      view = name;
      panel.replaceChildren(); output.replaceChildren(); status.textContent = '';
      for (const control of tabs.children) control.setAttribute('aria-pressed', String(control.textContent === name));
      ({ GitHub: showGithub, Gmail: showGmail, Telegram: showTelegram })[name]();
    }
    for (const name of ['GitHub', 'Gmail', 'Telegram']) tabs.append(button(name, () => select(name)));
    dialog.addEventListener('close', () => { gmailToken = ''; googleClient = null; select('GitHub'); });
    select('GitHub');
  }

  window.HmCowork = { open() {
    if (!curUser?.id) return;
    if (sessionUser !== curUser.id) { gmailToken = ''; googleClient = null; dialog?.remove(); dialog = null; sessionUser = curUser.id; }
    if (!dialog) build();
    if (!dialog.open) dialog.showModal();
  } };
})();
