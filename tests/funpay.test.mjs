import test from 'node:test';
import assert from 'node:assert/strict';
import { funpay } from '../lib/funpay.js';
import { normalizePluginPlan } from '../lib/chat-plugins.js';

const token = 'mock-key_for-tests';
const base = '<form class="form-horizontal form-offer-editor">' +
  '<input name="csrf_token" value="test&amp;token" type="hidden">' +
  '<input name="offer_id" value="%OFFER%"><input name="node_id" value="1356">' +
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
      const editor = base.replace('%OFFER%', url.searchParams.get('offer') || '0');
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
  assert.deepEqual(await funpay('funpay.publish', { token, title: 'Товар', description: 'Описание товара', price: '125,90', amount: '3' }), { offer: '678', node: '1356' });
  assert.equal(writes[0].get('active'), 'on');
  assert.equal(writes[0].get('price'), '125.90');
  assert.equal(writes[0].get('fields[type]'), 'b');
  await funpay('funpay.edit', { token, offer: '678', price: '170' });
  assert.equal(writes[1].get('fields[summary][ru]'), 'Исходное "название"');
  assert.equal(writes[1].get('secrets'), 'first&unused\nsecond');
  assert.equal(writes[1].get('auto_delivery'), null);
  const added = await funpay('funpay.stock', { token, offer: '678', stock: 'second\nnew&third\nnew&third' });
  assert.deepEqual(added, { offer: '678', node: '1356', added: 1 });
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
    return new Response(base.replace('%OFFER%', '678'));
  });
  await assert.rejects(funpay('funpay.delete', { token, offer: '674' }), { status: 403 });
  assert.equal(writes, 0);
  await assert.rejects(funpay('funpay.stock', { token, offer: '678', stock: 'sensitive merchandise' }),
    error => error.status === 422 && !error.message.includes('sensitive merchandise'));
  assert.equal(writes, 1);
});

test('FunPay planner strips credentials and cannot populate stock', () => {
  const plan = normalizePluginPlan({ steps: [
    { action: 'funpay.stock', args: { offer: '89', stock: 'secret' } },
    { action: 'funpay.delete', args: { offer: 'wrong' } },
    { action: 'funpay.edit', args: { offer: '89', price: '3', token } }
  ] }, ['funpay']);
  assert.deepEqual(plan.steps, [{ action: 'funpay.edit', args: { offer: '89', price: '3' } }]);
});
