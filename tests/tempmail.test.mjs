import test from 'node:test';
import assert from 'node:assert/strict';
import { signHandle, readHandle, extractCodes, htmlToText } from '../lib/util-tempmail.js';

test('mailbox handle is signed and bound to its owner', () => {
  const h = signHandle({ p: 'mt', a: 'x@y.z', t: 'tok', u: 'user-1', c: 1 });
  assert.equal(readHandle(h, 'user-1').a, 'x@y.z');
  assert.equal(readHandle(h, 'user-2'), null);
  const [body, mac] = h.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'mt', a: 'x@y.z', t: 'tok', u: 'user-2', c: 1 })).toString('base64url');
  assert.equal(readHandle(forged + '.' + mac, 'user-2'), null);
  assert.equal(readHandle(body, 'user-1'), null);
  assert.equal(readHandle('', 'user-1'), null);
});

test('verification codes and links are pulled out of letters', () => {
  assert.deepEqual(extractCodes('Ваш код подтверждения: 482913. Никому его не сообщайте.').codes, ['482913']);
  assert.deepEqual(extractCodes('Your verification code is A7K9Q2').codes, ['A7K9Q2']);
  assert.deepEqual(extractCodes('Use code 123 456 to sign in').codes, ['123456']);
  assert.deepEqual(extractCodes('© 2026 Example. Order 55821 shipped').codes, ['55821']);
  const r = extractCodes('Confirm: https://ex.com/verify?token=abc. Unsubscribe https://ex.com/unsub');
  assert.deepEqual(r.links, ['https://ex.com/verify?token=abc']);
});

test('html letters become readable text', () => {
  const t = htmlToText('<style>p{}</style><p>Привет&nbsp;!</p><a href="https://a.b/c">ссылка</a>');
  assert.match(t, /Привет !/);
  assert.match(t, /ссылка \(https:\/\/a\.b\/c\)/);
  assert.ok(!t.includes('p{}'));
});
