import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_SYSTEM, SUPPORT_EMAIL, sanitizeReply } from '../lib/util-support.js';

test('support prompt holds the hard rules and the policy facts', () => {
  assert.equal(SUPPORT_EMAIL, 'harmonyaisent@gmail.com');
  for (const s of ['НЕТ доступа к аккаунтам', 'Никогда не проси', '7.1', '7.2', '10 рабочих дней', 'Не раскрывай', 'Telegram-бота нет']) {
    assert.ok(SUPPORT_SYSTEM.includes(s), s);
  }
  assert.ok(!/t\.me\//.test(SUPPORT_SYSTEM));
});

test('replies never point to the removed Telegram bot or leak reasoning', () => {
  assert.equal(sanitizeReply('Пишите в https://t.me/harmonyaisupport_bot'), 'Пишите в harmonyaisent@gmail.com');
  assert.equal(sanitizeReply('<think>secret</think>Ответ'), 'Ответ');
  assert.equal(sanitizeReply('## Заголовок\nтекст'), 'Заголовок\nтекст');
});
