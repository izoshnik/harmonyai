import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../js/hm-chat-plugins.js', import.meta.url), 'utf8');
const original = '@FunPay Создай предложение. Раздел: Canva — Подписка. Название: Шаблон для заметок. Цена: 50 ₽. Автовыдача: demo';
const user = content => ({ role: 'user', content });
const bot = (content, funpayReply) => ({ role: 'assistant', content, funpayReply });
const offerLink = 'https://funpay.com/lots/offer?id=481681';

function browser(history, publishError, plan) {
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
        ? plan || { question: '', steps: [{ action: 'funpay.publish', args: { node: '3400', stock: 'demo' } }] }
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
  assert.deepEqual(app.actions, []);
  assert.deepEqual(app.requests.map(request => request.action), ['chat.plan']);
  assert.match(app.results[0].content, /Проверь список/);
  assert.equal(await app.route('предложений у меня нет'), true);
  assert.equal(app.requests[1].previous[0], original);
  assert.equal(app.requests[1].previous[1], 'Цена: 55 ₽');
  assert.deepEqual(app.actions, ['funpay.publish']);
});

test('an old 428 followed by a guard-only reply can resume after reopening', async () => {
  const refusal = 'FunPay не подтвердил публикацию конкретного предложения. Проверь список своих предложений перед повтором. Ответ FunPay: HTTP 428. Код диагностики: Ab123.';
  const guard = 'FunPay не подтвердил предыдущую публикацию. Проверь список предложений. Если он пуст, напиши «Проверил, список пуст».';
  const pending = { outcome: 'uncertain', factsOnly: true };
  for (const [status, expected] of [['428', ['funpay.publish']], ['502', []]]) {
    const app = browser([user(original), bot(refusal.replace('428', status), pending), user('попробуй снова'), bot(guard, pending)]);
    await app.route('попробуй ещё раз');
    assert.deepEqual(app.actions, expected);
  }
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

test('an explicitly titled new listing does not inherit a previous uncertain publication', async () => {
  const app = browser([user(original), bot('FunPay не подтвердил публикацию.', { outcome: 'uncertain' })]);
  const task = '@FunPay Создай предлоежние, категория Canva — Подписка, название Персональный календарь, описание Планер.\n\nЦена: 75 ₽.\nАвтовыдача: demo';
  assert.equal(await app.route(task), true);
  assert.equal(app.requests[0].task, task);
  assert.deepEqual(Array.from(app.requests[0].previous), []);
  assert.deepEqual(app.actions, ['funpay.publish']);
  assert.equal(app.results[0].options.funpayOutcome, 'published');
});

test('rephrasing a full request for the same listing does not bypass uncertainty protection', async () => {
  const app = browser([user(original), bot('FunPay не подтвердил публикацию.', { outcome: 'uncertain' })]);
  const task = '@FunPay Опубликуй товар, название «Шаблон для заметок», описание Новый вариант.\nЦена: 75 ₽.';
  assert.equal(await app.route(task), true);
  assert.equal(app.requests[0].previous[0], original);
  assert.deepEqual(app.actions, []);
  assert.equal(app.results[0].options.funpayOutcome, 'uncertain');
});

test('a restricted listing stays blocked on follow-up without another tool call', async () => {
  const error = Object.assign(Error('Публикация ограничена'), { code: 'FUNPAY_RESTRICTED_LISTING' });
  const app = browser([user(original), bot('Публикация ограничена.', { outcome: 'restricted' })], error);
  await app.route('попробуй еще раз');
  assert.equal(app.actions.length, 0);
  assert.equal(app.results[0].options.funpayOutcome, 'restricted');
});

test('a restriction found by the planner supersedes an outdated uncertain state without writing', async () => {
  const issue = 'HarmonyAI не публикует материалы для обхода защит и вредоносные инструменты.';
  const app = browser([user(original), bot('FunPay не подтвердил публикацию.', { outcome: 'uncertain' })], null,
    { steps: [], issue, code: 'FUNPAY_RESTRICTED_LISTING' });
  assert.equal(await app.route('попробуй снова'), true);
  assert.deepEqual(app.actions, []);
  assert.deepEqual(app.requests.map(request => request.action), ['chat.plan']);
  assert.equal(app.results[0].content, issue);
  assert.equal(app.results[0].options.funpayOutcome, 'restricted');
});

test('a marketplace rejection is preserved in the chat and does not trigger the uncertainty guard', async () => {
  const message = 'FunPay отклонил сохранение предложения. Проверь цену.';
  const error = Object.assign(Error(message), { code: 'FUNPAY_SAVE_REJECTED' });
  const app = browser([user(original), bot('FunPay не подтвердил публикацию.', { outcome: 'uncertain' })], error);
  assert.equal(await app.route('предложений у меня нет'), true);
  assert.equal(app.results[0].content, message);
  assert.equal(app.results[0].options.factsOnly, true);
  assert.equal(app.results[0].options.funpayOutcome, 'rejected');
  assert.deepEqual(app.actions, ['funpay.publish']);
});
