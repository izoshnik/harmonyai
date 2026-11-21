import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotTarget } from '../lib/chat-browser.js';
import { CHAT_PAUSE_REPLY, shouldPauseChat } from '../lib/moderation.js';
import { __routing } from '../api/chat.js';

test('Sion is gated, Dynatos is available on Free', () => {
  const messages = [{ role: 'user', content: 'Напиши чистую функцию' }];
  const adan = __routing.selectRoute({}, 'lite', messages).models;
  const denied = __routing.selectRoute({}, 'sion', messages).models;
  const dynatos = __routing.selectRoute({}, 'pro', messages).models;
  const sion = __routing.selectRoute({ role: 'admin' }, 'sion', messages).models;
  assert.deepEqual(denied, adan);
  assert.ok(dynatos.includes('glm-5.3-flash'));
  assert.equal(sion[0], 'deepseek-v4-flash');
  assert.ok(sion.includes(adan[0]));
});

test('screenshot routes accept only public HarmonyAI pages', () => {
  assert.deepEqual(screenshotTarget('Сделай скриншот https://harmonyai.ru/about'), { url: 'https://harmonyai.ru/about' });
  assert.equal(screenshotTarget('Расскажи, как сделать скриншот'), null);
  assert.ok(screenshotTarget('Сделай скриншот https://harmonyai.ru:81/').error);
  assert.ok(screenshotTarget('Сделай скриншот https://harmonyai.ru/chat/abc').error);
  assert.ok(screenshotTarget('Сделай скриншот https://harmonyai.ru/?redirect=http://localhost').error);
});

test('confirmed insult pauses the conversation until an apology', async () => {
  assert.equal(await shouldPauseChat('Ты тупой', '', Promise.resolve({ flagged: ['insult'] })), true);
  assert.equal(await shouldPauseChat('Ты ошибся в расчёте', ''), false);
  assert.equal(await shouldPauseChat('Продолжай задачу', CHAT_PAUSE_REPLY), true);
  assert.equal(await shouldPauseChat('Извини за резкость. Продолжим?', CHAT_PAUSE_REPLY), false);
  assert.equal(await shouldPauseChat('Не извиняюсь. Это шутка, извини', CHAT_PAUSE_REPLY), true);
});
