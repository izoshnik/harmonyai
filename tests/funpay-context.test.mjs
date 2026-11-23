import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../js/hm-chat-plugins.js', import.meta.url), 'utf8');
const original = '@FunPay Создай предложение. Раздел: Canva — Подписка. Название: Шаблон для заметок. Цена: 50 ₽. Автовыдача: demo';
const user = content => ({ role: 'user', content });
const bot = (content, funpayReply) => ({ role: 'assistant', content, funpayReply });
const offerLink = 'https://funpay.com/lots/offer?id=481681';

function browser(history, publishError) {
  const requests = [];
  const actions = [];
  const results = [];
  const window = { HmPlugins: { chatAccess: async () => ({ invoke: async action => {
    actions.push(action);
    if (publishError) throw publishError;
    return { offer: '481681', node: '3400', added: 1 };
  } }) } };
  vm.runInNewContext(script, {
    window, chatHistory: history, curUser: { id: 'owner' }, toast: assert.fail,
    hmTmUserTurn: content => history.push(user(content)),
    hmPlugin: () => ({ cycle() {}, finish(content, options) {
      results.push({ content, options });
      history.push(bot(content, options.funpayReply ? { outcome: options.funpayOutcome, link: options.link } : undefined));
    } }),
    hmUtil: async (op, { body }) => {
      assert.equal(op, 'plugins');
      requests.push(body);
      return body.action === 'chat.plan'
        ? { question: '', steps: [{ action: 'funpay.publish', args: { node: '3400', stock: 'demo' } }] }
        : { text: 'Предложение опубликовано.' };
    }
  });
  return { route: window.HmChatPlugins.route, requests, actions, results };
}

test('FunPay routes implicit publication and keeps the original task after reopening a conversation', async () => {
  const history = [user(original), bot('Уточняю необходимые детали.', { outcome: 'open' }),
    user('Цена: 50 ₽'), bot('Черновик из старой версии.')];
  const app = browser(history);
  assert.equal(await app.route('Так ты выстави прдлоежние'), true);
  assert.equal(app.requests[0].plugins.join(','), 'funpay');
  assert.equal(app.requests[0].previous[0], original);
  assert.equal(app.requests[0].previous[1], 'Цена: 50 ₽');
  assert.deepEqual(app.actions, ['funpay.publish']);
  assert.equal(app.results[0].options.link, offerLink);
  const reopened = browser(structuredClone(history));
  assert.equal(await reopened.route('попробуй еще раз'), true);
  assert.deepEqual(reopened.actions, []);
  assert.equal(reopened.results[0].options.link, offerLink);
  assert.match(reopened.results[0].content, /уже опубликовано/);
});

test('a retry keeps the pending context but avoids duplicate writes while the previous outcome is unknown', async () => {
  const history = [user(original), bot('FunPay не подтвердил публикацию конкретного предложения.', { factsOnly: true }),
    user('Цена: 55 ₽'), bot('Цену уточнил.'), user('Так ты выстави предложение'), bot('Я подготовил черновик.')];
  const app = browser(history);
  assert.equal(await app.route('попробуй ещё раз'), true);
  assert.equal(app.requests.length, 0);
  assert.match(app.results[0].content, /Проверь список/);
  assert.equal(await app.route('Проверил, лота нет'), true);
  assert.equal(app.requests[0].previous[0], original);
  assert.equal(app.requests[0].previous[1], 'Цена: 55 ₽');
  assert.deepEqual(app.actions, ['funpay.publish']);
});

test('a fresh topic is not pulled into a stale marketplace workflow', async () => {
  const app = browser([user(original), bot('Лот создан.', { outcome: 'published', link: offerLink }),
    user('Посоветуй фильм на вечер'), bot('Попробуй посмотреть комедию')]);
  assert.equal(await app.route('попробуй еще раз'), false);
  assert.deepEqual(app.actions, []);
  const fresh = browser([]);
  assert.equal(await fresh.route('Выстави товар в разделе Canva — Подписка с автовыдачей'), true);
  assert.equal(fresh.requests[0].plugins.join(','), 'funpay');
});

test('a restricted listing stays blocked on follow-up without another tool call', async () => {
  const error = Object.assign(Error('Публикация ограничена'), { code: 'FUNPAY_RESTRICTED_LISTING' });
  const app = browser([user(original), bot('Публикация ограничена.', { outcome: 'restricted' })], error);
  await app.route('попробуй еще раз');
  assert.equal(app.actions.length, 0);
  assert.equal(app.results[0].options.funpayOutcome, 'restricted');
});
