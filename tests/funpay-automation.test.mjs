import assert from 'node:assert/strict';
import test from 'node:test';
import { automateListing, managedTitle, matchesDelivery, openFunPay, pollFunPayAccount, renderFunPayTemplate, sealFunPay, selectFunPayReply } from '../lib/funpay-automation.js';
import { parseOrder, parseSaleIds } from '../lib/funpay-events.js';

const owner = 'bb29ede0-8c36-4c4b-8cad-efbedca35d58';
const sku = '01ABCDEF2345';
const title = managedTitle('Шаблон заметок', sku);
const offer = { sku, enabled: true, offer: '800', category: '2456', title };
const providerOrder = {
  order_uid: 'HAG0022', seller: { user_id: 8 }, buyer: { user_id: 19 }, status: 'paid',
  section: { type_id: 'lot', local_id: 2456 }, chat: { node_name: 'users-8-19' },
  type_data: { amount: 1, fields: { summary: { name: 'Краткое описание', value: title } } }
};

test('delivery checks the authenticated seller, buyer chat, paid state and exact listing identifier or title', () => {
  const order = parseOrder(providerOrder, '8', 'HAG0022');
  assert.ok(matchesDelivery(order, offer));
  assert.equal(matchesDelivery({ ...order, title: 'Похожий ' + title }, offer), false);
  assert.equal(matchesDelivery({ ...order, state: 'refunded' }, offer), false);
  assert.equal(matchesDelivery({ ...order, offer: '801' }, offer), false);
  assert.equal(matchesDelivery({ ...order, node: '2455' }, offer), false);
  assert.equal(matchesDelivery({ ...order, title: '', offer: '800' }, offer), true);
  assert.equal(parseOrder(providerOrder, '7', 'HAG0022'), null);
  assert.equal(parseOrder({ ...providerOrder, chat: { node_name: 'users-8-20' } }, '8', 'HAG0022'), null);
});

test('only the buyer’s own order can be expanded into a reply, and command takes precedence', () => {
  const order = parseOrder(providerOrder, '8', 'HAG0022');
  assert.match(selectFunPayReply({ buyer: '19', text: '!order' }, [order], { message: 'Шаблон' }), /orders\/HAG0022\/.*оплачен/);
  assert.doesNotMatch(selectFunPayReply({ buyer: '20', text: '!order' }, [order], {}), /HAG0022/);
  assert.equal(selectFunPayReply({ buyer: '19', text: 'Привет' }, [order], { message: 'Добрый день' }), 'Добрый день');
  assert.equal(selectFunPayReply({ buyer: '19', text: '!help' }, [order], { '!help': '' }), '');
  assert.match(renderFunPayTemplate('Отзыв на заказ $order', { order }), /https:\/\/funpay\.com\/orders\/HAG0022/);
  assert.throws(() => parseSaleIds('<h1>Вход</h1>'), /не вернул список/);
});

test('worker delivers once, handles incoming commands, and sends confirmation and review replies from verified events', async t => {
  const saved = { key: process.env.FUNPAY_AUTOMATION_KEY, url: process.env.SUPABASE_URL, db: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.FUNPAY_AUTOMATION_KEY = '2'.repeat(64);
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  t.after(() => {
    for (const [name, value] of Object.entries({ FUNPAY_AUTOMATION_KEY: saved.key, SUPABASE_URL: saved.url, SUPABASE_SERVICE_ROLE_KEY: saved.db })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const token = 'test_funpay_cookie';
  const encrypted = sealFunPay(owner, 'example-stock');
  assert.throws(() => openFunPay('other', encrypted));
  const row = { owner, seller_id: '8', credential: sealFunPay(owner, token), lease_id: 'lease',
    cursor: null, rules: { message: 'Здравствуйте!', confirmed: 'Оставьте отзыв на заказ $order', review: 'Спасибо!' } };
  const taken = new Set();
  const sent = [];
  const reviews = [];
  let state = 'paid';
  let chatMessage = 10;
  const review = { text: 'Всё отлично', rating: 5, reply: '', hidden: false };
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    if (url.hostname === 'supabase.invalid') {
      if (url.pathname.endsWith('/funpay_automation_lots')) return Response.json([offer]);
      if (url.pathname.endsWith('/rpc/funpay_claim_event')) {
        const event = JSON.parse(options.body);
        if (taken.has(event.p_event)) return Response.json([]);
        taken.add(event.p_event);
        return Response.json([{ state: 'reserved', items: event.p_sku ? [encrypted] : [] }]);
      }
      if (url.pathname.endsWith('/funpay_automation_events')) return new Response(null, { status: 204 });
      assert.fail('unexpected DB call ' + url.pathname);
    }
    assert.equal(url.origin, 'https://funpay.com');
    assert.equal(options.headers.Cookie, 'golden_key=' + token);
    if (url.pathname === '/') return new Response('<body data-app-data="{&quot;userId&quot;:8,&quot;csrf-token&quot;:&quot;csrf&quot;}">');
    if (url.pathname === '/orders/trade') return new Response('<h1 class="page-header">Мои продажи</h1><a class="tc-item" href="/orders/HAG0022/">');
    if (url.pathname === '/api/orders/get') return Response.json({ status: 'SUCCESS', data: {
      HAG0022: { ...providerOrder, status: state, ...(state === 'closed' ? { review } : {}) }
    } });
    if (url.pathname === '/orders/review') {
      reviews.push(options.body.get('text'));
      assert.equal(options.body.get('orderId'), 'HAG0022');
      return Response.json({ content: 'saved' });
    }
    assert.equal(url.pathname, '/runner/');
    const objects = JSON.parse(options.body.get('objects'));
    const request = JSON.parse(options.body.get('request'));
    if (request) {
      sent.push(request.data.content);
      return Response.json({ objects: [], response: { accepted: true } });
    }
    if (objects[0].type === 'chat_bookmarks') return Response.json({ objects: [{ type: 'chat_bookmarks', data: {
      html: '<a class="contact-item" data-id="33" data-node-msg="' + chatMessage + '"></a>'
    } }] });
    return Response.json({ objects: [{ type: 'chat_node', data: { node: { name: 'users-8-19', id: 33, silent: false }, messages: [
      { author: 19, id: chatMessage, html: '<div class="chat-msg-text">!order</div>' },
      { author: 8, id: chatMessage, html: '<div class="chat-msg-text">my own reply</div>' },
      ...(state === 'closed' ? [{ author: 0, id: 12, html: '<a href="/users/19/">Покупатель</a> подтвердил заказ <a href="/orders/HAG0022/">#HAG0022</a>' }] : [])
    ] } }] });
  });
  row.cursor = (await pollFunPayAccount(row, Date.now() + 6000)).cursor;
  assert.deepEqual(sent, []);
  chatMessage = 11;
  row.cursor = (await pollFunPayAccount(row, Date.now() + 6000)).cursor;
  assert.equal(sent[0], 'example-stock');
  assert.match(sent[1], /HAG0022/);
  await pollFunPayAccount(row, Date.now() + 6000);
  assert.equal(sent.length, 2);
  state = 'closed';
  row.cursor = (await pollFunPayAccount(row, Date.now() + 6000)).cursor;
  assert.match(sent[2], /Оставьте отзыв.*HAG0022/);
  assert.deepEqual(reviews, ['Спасибо!']);
});

test('server delivery links a disabled draft to encrypted stock before activation without native delivery fields', async t => {
  const values = {
    FUNPAY_AUTOMATION_KEY: '3'.repeat(64), FUNPAY_WORKER_SECRET: '4'.repeat(64),
    SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test'
  };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const token = 'seller_test_cookie';
  const profile = { owner, credential: sealFunPay(owner, token), cursor: {}, last_poll: new Date().toISOString() };
  const writes = [];
  let stored;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    if (url.hostname === 'supabase.invalid') {
      if (url.pathname.endsWith('/funpay_automation_accounts')) return Response.json([profile]);
      assert.ok(url.pathname.endsWith('/funpay_automation_lots'));
      stored = { ...stored, ...JSON.parse(options.body) };
      writes.push(options.method === 'POST' ? 'reserve' : 'bind');
      assert.deepEqual(stored.items.map(item => openFunPay(owner, item)), ['sample-template']);
      return Response.json([stored]);
    }
    assert.equal(url.host, 'funpay.com');
    if (url.pathname === '/lots/offerEdit') {
      const offerId = url.searchParams.get('offer') || '0';
      return new Response('<form class="form-offer-editor">' +
        '<input name="csrf_token" value="csrf"><input name="node_id" value="2456"><input name="offer_id" value="' + offerId + '">' +
        '<input name="price" value="50"><input name="amount" value="1"><input name="fields[summary][ru]" value="Example">' +
        '<textarea name="fields[desc][ru]">Description</textarea><input type="checkbox" name="active"></form>');
    }
    assert.equal(url.pathname, '/lots/offerSave');
    assert.equal(options.body.has('secrets'), false);
    assert.equal(options.body.has('auto_delivery'), false);
    if (options.body.get('offer_id') === '0') {
      assert.equal(options.body.has('active'), false);
      assert.equal(options.body.get('fields[summary][ru]'), stored.title);
      writes.push('draft');
    } else {
      assert.equal(stored.offer, '811');
      assert.equal(stored.enabled, true);
      assert.equal(options.body.get('active'), 'on');
      writes.push('activate');
    }
    return Response.json({ done: true, offer_id: '811' });
  });
  const published = await automateListing('funpay.publish', owner, {
    token, node: '2456', title: 'Шаблон для заметок', description: 'Мой цифровой шаблон', price: '50', stock: 'sample-template'
  });
  assert.deepEqual(writes, ['reserve', 'draft', 'bind', 'activate']);
  assert.equal(published.delivery, 'server');
  assert.match(stored.title, /\[HA-[A-F0-9]{12}\]$/);
  assert.equal(published.offer, '811');
  assert.doesNotMatch(JSON.stringify(published), /sample-template/);
});
