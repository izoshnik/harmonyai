import test from 'node:test';
import assert from 'node:assert/strict';
import { textToHtml, paymentEmail, blockedEmail, unsubscribeToken, checkUnsubscribe, unsubscribeUrl, sendMail, mailEnabled } from '../lib/mailer.js';

test('newsletter text becomes safe html', () => {
  const h = textToHtml('Привет, **друзья**!\nНовая версия.\n\nПодробнее: [сайт](https://harmonyai.ru) <script>x</script>');
  assert.match(h, /<b>друзья<\/b>/);
  assert.match(h, /<br>/);
  assert.match(h, /<a href="https:\/\/harmonyai\.ru"[^>]*>сайт<\/a>/);
  assert.ok(!h.includes('<script>'));
  assert.equal((h.match(/<p /g) || []).length, 2);
});

test('payment and block emails carry the essentials', () => {
  const p = paymentEmail({ kind: 'subscription', amountKop: 34900, periodDays: 30, expiresAt: '2026-12-04T10:00:00Z' });
  assert.match(p.subject, /Pro до 4 декабря 2026/);
  assert.match(p.html, /349 ₽/);
  const t = paymentEmail({ kind: 'topup', amountKop: 50050 });
  assert.match(t.subject, /500,5 ₽/);
  const b = blockedEmail();
  assert.match(b.html, /harmonyaisent@gmail\.com/);
  assert.match(b.html, /10 рабочих дней/);
  assert.ok(!/telegram|t\.me/i.test(b.html));
});

test('unsubscribe links are signed per user', () => {
  const u = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  assert.ok(checkUnsubscribe(u, unsubscribeToken(u)));
  assert.ok(!checkUnsubscribe(u, unsubscribeToken('11111111-1111-1111-1111-111111111111')));
  assert.ok(!checkUnsubscribe(u, 'short'));
  assert.match(unsubscribeUrl(u), /op=unsubscribe&u=7c9e6679/);
});

test('without RESEND_API_KEY nothing is sent', async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(mailEnabled(), false);
  const r = await sendMail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' });
  assert.equal(r.skipped, 'no_key');
});
