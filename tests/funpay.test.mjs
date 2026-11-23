import test from 'node:test';
import assert from 'node:assert/strict';
import { funpay, resolveFunPayCategory } from '../lib/funpay.js';
import { normalizePluginPlan, planPluginRequest, resolveFunPayPublication, validateFunPayDelivery } from '../lib/chat-plugins.js';

const token = 'mock-key_for-tests';
const base = '<form class="form-horizontal form-offer-editor">' +
  '<input name="csrf_token" value="test&amp;token" type="hidden">' +
  '<input name="offer_id" value="%OFFER%"><input name="node_id" value="%NODE%">' +
  '<input name="price" value="100"><input name="amount" value="5">' +
  '<input name="fields[summary][ru]" value="Исходное &quot;название&quot;">' +
  '<textarea name="fields[desc][ru]">Исходное описание</textarea>' +
  '<textarea name="secrets">first&amp;unused\nsecond</textarea>' +
  '<input type="checkbox" name="auto_delivery" value="on">' +
  '<select name="fields[type]"><option value="a">A</option><option selected value="b">B</option></select>' +
  '<input type="checkbox" name="active" checked>' +
  '<input type="hidden" name="form_created_at" value="303">' +
  '</form>';

test('FunPay connects, publishes, edits, deletes and appends unique stock through the seller form', async t => {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://funpay.com');
    assert.equal(options.redirect, 'manual');
    assert.match(options.headers.Cookie, /^golden_key=mock-key_for-tests(?:;|$)/);
    if (url.pathname === '/') return new Response("<body data-app-data='{&quot;userId&quot;:7}'>");
    if (url.pathname === '/lots/offerEdit') {
      const editor = base.replace('%OFFER%', url.searchParams.get('offer') || '0').replace('%NODE%', '2456');
      return new Response(url.searchParams.has('node') ? editor : JSON.stringify({ html: editor }),
        { headers: { 'set-cookie': 'PHPSESSID=server-session; Path=/' } });
    }
    assert.equal(url.pathname, '/lots/offerSave');
    assert.match(options.headers.Cookie, /PHPSESSID=server-session/);
    assert.equal(options.headers.Origin, 'https://funpay.com');
    assert.equal(options.body.get('csrf_token'), 'test&token');
    writes.push(options.body);
    return Response.json({ done: true, url: '/lots/offer?id=678' });
  });
  assert.deepEqual(await funpay('funpay.connect', { token }), { account: '7' });
  const sale = { token, title: 'Товар', description: 'Описание товара', price: '125,90', amount: '3' };
  await assert.rejects(funpay('funpay.publish', sale), { status: 400 });
  assert.equal(writes.length, 0);
  assert.deepEqual(await funpay('funpay.publish', { ...sale, node: '2456' }), { offer: '678', node: '2456' });
  assert.equal(writes[0].get('active'), 'on');
  assert.equal(writes[0].get('price'), '125.90');
  assert.equal(writes[0].get('fields[type]'), 'b');
  await funpay('funpay.edit', { token, offer: '678', price: '170' });
  assert.equal(writes[1].get('fields[summary][ru]'), 'Исходное "название"');
  assert.equal(writes[1].get('secrets'), 'first&unused\nsecond');
  assert.equal(writes[1].get('auto_delivery'), null);
  const added = await funpay('funpay.stock', { token, offer: '678', stock: 'second\nnew&third\nnew&third' });
  assert.deepEqual(added, { offer: '678', node: '2456', added: 1 });
  assert.equal(writes[2].get('secrets'), 'first&unused\nsecond\nnew&third');
  assert.equal(writes[2].get('auto_delivery'), 'on');
  await funpay('funpay.delete', { token, offer: '678' });
  assert.deepEqual(Object.fromEntries(writes[3]), {
    offer_id: '678', csrf_token: 'test&token', deleted: '1', form_created_at: '303'
  });
});

test('FunPay does not write against a mismatched editor or accept ambiguous results and never returns raw stock', async t => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (options.method === 'POST') {
      writes++;
      return Response.json({ errors: { secrets: 'sensitive merchandise' } });
    }
    return new Response(base.replace('%OFFER%', '678').replace('%NODE%', '2456'));
  });
  await assert.rejects(funpay('funpay.delete', { token, offer: '674' }), { status: 403 });
  assert.equal(writes, 0);
  await assert.rejects(funpay('funpay.stock', { token, offer: '678', stock: 'sensitive merchandise' }),
    error => error.status === 422 && !error.message.includes('sensitive merchandise'));
  assert.equal(writes, 1);
});

test('FunPay does not publish a listing without its requested automatic delivery', async t => {
  let writes = 0;
  const editor = base.replace('%OFFER%', '0').replace('%NODE%', '2456')
    .replace(/<textarea name="secrets">[\s\S]*?<\/textarea>/, '')
    .replace(/<input type="checkbox" name="auto_delivery" value="on">/, '');
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (options.method === 'POST') writes++;
    return new Response(editor);
  });
  await assert.rejects(funpay('funpay.publish', {
    token, node: '2456', title: 'Скачиваемый шаблон', description: 'Шаблон для заметок', price: '50', stock: 'demo-item'
  }), error => error.status === 422 && /Предложение не создано/.test(error.message));
  assert.equal(writes, 0);
});

test('FunPay requires a specific offer ID before acknowledging publication', async t => {
  let providerReply = { done: true, url: '/lots/2456/trade' };
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (options.method !== 'POST') return new Response(base.replace('%OFFER%', '0').replace('%NODE%', '2456'));
    if (!providerReply) throw new TypeError('network timeout');
    return Response.json(providerReply);
  });
  const sale = { token, node: '2456', title: 'Шаблон', description: 'Шаблон для заметок', price: '50', amount: '1' };
  const unavailable = /не подтвердил публикацию конкретного предложения/;
  await assert.rejects(funpay('funpay.publish', sale), unavailable);
  providerReply = { done: true, offer_id: '700', url: '/lots/offer?id=701' };
  await assert.rejects(funpay('funpay.publish', sale), unavailable);
  providerReply = { done: false, url: '/lots/offer?id=700' };
  await assert.rejects(funpay('funpay.publish', sale), { code: 'FUNPAY_SAVE_REJECTED' });
  providerReply = { url: 'https://elsewhere.invalid/lots/offer?id=700' };
  await assert.rejects(funpay('funpay.publish', sale), unavailable);
  providerReply = null;
  await assert.rejects(funpay('funpay.publish', sale), unavailable);
  providerReply = { url: '/lots/offer?id=700' };
  assert.deepEqual(await funpay('funpay.publish', sale), { offer: '700', node: '2456' });
});

test('FunPay reports explicit validation failures without reflecting marketplace content', async t => {
  let reply;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (options.method === 'POST') return reply;
    assert.equal(new URL(address).pathname, '/lots/offerEdit');
    return new Response(base.replace('%OFFER%', '0').replace('%NODE%', '2456'));
  });
  const sale = { token, node: '2456', title: 'Шаблон', description: 'Шаблон для заметок', price: '50', amount: '1' };
  reply = Response.json({ errors: [['price', 'hidden payload'], ['fields[summary][ru]', 'hidden payload']] });
  await assert.rejects(funpay('funpay.publish', sale), {
    code: 'FUNPAY_SAVE_REJECTED', message: 'FunPay отклонил сохранение предложения. Проверь цену, название.'
  });
  reply = Response.json({ errors: { secrets: 'hidden payload' } }, { status: 400 });
  await assert.rejects(funpay('funpay.publish', sale), {
    code: 'FUNPAY_SAVE_REJECTED', message: 'FunPay отклонил сохранение предложения. Проверь позиции автовыдачи.'
  });
});

test('FunPay rejects restricted listings before calling the marketplace', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('marketplace request on rejected listing'));
  await assert.rejects(funpay('funpay.publish', { token, title: 'JailBreak для модели' }),
    { status: 400, code: 'FUNPAY_RESTRICTED_LISTING' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('FunPay refuses an obfuscated restricted offer before AI planning or seller requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected external request'));
  const title = 'Дополнение Codex';
  const description = 'Новый J для модели GPT. Использование может привести к блокировке учётной записи.';
  const task = '@FunPay Создай предложение.\nНазвание: ' + title + '\nОписание: ' + description;
  const plan = await planPluginRequest({ task, plugins: ['funpay'] });
  assert.equal(plan.code, 'FUNPAY_RESTRICTED_LISTING');
  assert.deepEqual(plan.steps, []);
  await assert.rejects(funpay('funpay.publish', { token, title, description }), { code: 'FUNPAY_RESTRICTED_LISTING' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('FunPay planner strips credentials and takes delivery positions verbatim from the request', () => {
  const plan = normalizePluginPlan({ steps: [
    { action: 'funpay.stock', args: { offer: '89', stock: 'secret' } },
    { action: 'funpay.delete', args: { offer: 'wrong' } },
    { action: 'funpay.edit', args: { offer: '89', price: '3', token } }
  ] }, ['funpay']);
  assert.deepEqual(plan.steps, [
    { action: 'funpay.stock', args: { offer: '89', stock: 'secret' } },
    { action: 'funpay.edit', args: { offer: '89', price: '3', autoDelivery: false } }
  ]);
  assert.equal(validateFunPayDelivery(plan, ['В автовыдачу: secret']), plan);
  assert.match(validateFunPayDelivery(plan, ['В автовыдачу: altered']).issue, /точно сопоставить/);
  const publish = args => ({ steps: [{ action: 'funpay.publish', args }] });
  assert.match(validateFunPayDelivery(publish({ autoDelivery: true, amount: '1' }), ['Включи автовыдачу']).issue, /позиции автоматической выдачи/);
  assert.match(validateFunPayDelivery(publish({ amount: '1' }), ['Оформь товар.\nАвтовыдача: Demo-ABC_1']).issue, /ещё не опубликован/);
  assert.match(validateFunPayDelivery(publish({ stock: 'secret', description: 'secret' }), ['В автовыдачу: secret']).issue, /публичных полей/);
});

test('the AI plans a new listing with stock in one operation from the original chat message', async t => {
  const task = 'Добавь товар в разделе ChatGPT — Прочее.\nНазвание: Тестовый набор\nЦена: 250 ₽\nОписание: Тестовый комплект.\nАвтовыдача:\nDemo-ABC_1\nDemo&xyz 2';
  const catalog = '<div class="game-title" data-id="11"><a href="/lots/2456/">ChatGPT</a></div>' +
    '<ul class="list-inline" data-id="11"><li><a href="/lots/2456/">Прочее</a></li></ul>';
  const expectedStock = 'Demo-ABC_1\nDemo&xyz 2';
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    if (url.pathname.endsWith('/chat/completions')) {
      const input = JSON.parse(options.body).messages;
      assert.equal(JSON.parse(input.at(-1).content).task, task);
      assert.match(input[0].content, /ONE funpay\.publish/i);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ steps: [
        { action: 'funpay.publish', args: { game: 'ChatGPT', section: 'Прочее', title: 'Тестовый набор',
          description: 'Тестовый комплект.', price: '250', stock: expectedStock, autoDelivery: true } }
      ], question: '' }) } }] });
    }
    assert.equal(url.origin, 'https://funpay.com');
    if (url.pathname === '/') return new Response(catalog);
    if (url.pathname === '/lots/offerEdit') {
      assert.equal(url.searchParams.get('node'), '2456');
      return new Response(base.replace('%OFFER%', '0').replace('%NODE%', '2456').replace('first&amp;unused\nsecond', ''));
    }
    assert.equal(url.pathname, '/lots/offerSave');
    writes++;
    assert.equal(options.body.get('active'), 'on');
    assert.equal(options.body.get('auto_delivery'), 'on');
    assert.equal(options.body.get('secrets'), expectedStock);
    assert.equal(options.body.get('amount'), '2');
    assert.equal(options.body.get('fields[desc][ru]'), 'Тестовый комплект.');
    return Response.json({ done: true, offer_id: '678' });
  });
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'mock-provider-api-key';
  t.after(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });
  const plan = await planPluginRequest({ task, plugins: ['funpay'] });
  assert.equal(plan.question, '');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].action, 'funpay.publish');
  assert.equal(plan.steps[0].args.node, '2456');
  const result = await funpay(plan.steps[0].action, { ...plan.steps[0].args, token });
  assert.equal(writes, 1);
  assert.deepEqual(result, { offer: '678', added: 2, node: '2456' });
  assert.doesNotMatch(JSON.stringify(result), /Demo/);
});

test('publication uses only the category named or linked by the user', async t => {
  const group = (id, name, sections) => '<div class="game-title" data-id="' + id + '"><a href="/lots/42/">' +
    name + '</a></div><ul class="list-inline" data-id="' + id + '">' + sections.map(([url, label]) =>
      '<li><a href="' + url + '">' + label + '</a></li>').join('') + '</ul>';
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://funpay.com/');
    assert.equal(options.headers.Cookie, undefined);
    return new Response(group(40, 'Game &amp; Co', [['/lots/42/', 'Подписка'], ['https://unrelated.test/lots/31/', 'Прочее']]) +
      group(50, 'Video Service', [['https://funpay.com/lots/51/', 'Подписка'], ['/lots/52/', 'Разное'], ['/lots/53/', 'Разное']]));
  });
  const publication = args => ({ steps: [{ action: 'funpay.publish', args }], question: '' });
  assert.match((await resolveFunPayPublication(publication({}), ['Опубликуй предложение'])).question, /Укажи раздел/);
  assert.match((await resolveFunPayPublication(publication({ node: '42' }), ['Опубликуй за 42 рубля'])).question, /Укажи раздел/);
  assert.equal(fetch.mock.callCount(), 0);
  const linked = await resolveFunPayPublication(publication({ node: '51' }), ['Выложи на FunPay', 'https://funpay.com/lots/51/']);
  assert.equal(linked.steps[0].args.node, '51');
  assert.equal(fetch.mock.callCount(), 0);
  const named = await resolveFunPayPublication(publication({ game: 'Game & Co', section: 'Подписка' }), ['Game & Co → Подписка']);
  assert.equal(named.steps[0].args.node, '42');
  assert.equal(named.steps[0].args.categoryLabel, 'Game & Co → Подписка');
  assert.deepEqual(await resolveFunPayCategory('Video Service', 'Подписка'), { node: '51', label: 'Video Service → Подписка' });
  assert.equal(await resolveFunPayCategory('Video Service', 'Разное'), null);
  assert.equal(await resolveFunPayCategory('Game & Co', 'Прочее'), null);
});
