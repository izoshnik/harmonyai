import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../lib/cowork-plan.js';

test('a plan only uses the plugins the user selected and excludes raw credentials and IDs', () => {
  const plan = normalizePlan({ steps: [
    { action: 'github.repo', args: { repo: 'izoshnik/harmonyai', token: 'ignored' } },
    { action: 'telegram.send', args: { chat: '-100123456', message: 'Hello' } },
    { action: 'gmail.read', args: { position: 1, id: 'untrusted' } },
    { action: 'github.request', args: { url: 'https://example.test' } },
  ] }, ['gmail', 'github']);
  assert.deepEqual(plan.steps, [
    { action: 'github.repo', args: { repo: 'izoshnik/harmonyai' }, confirm: false },
    { action: 'gmail.read', args: { position: 1 }, confirm: false },
  ]);
});

test('a multi-plugin plan executes reads before at most one confirmed write', () => {
  const plan = normalizePlan({ steps: [
    { action: 'telegram.send', args: { chat: '-12345', fromResults: true } },
    { action: 'gmail.list', args: { query: 'is:unread', spam: false } },
    { action: 'gmail.trash', args: { position: 2 } },
    { action: 'gmail.read', args: { position: 2 } },
  ] }, ['gmail', 'telegram']);
  assert.deepEqual(plan.steps.map(step => [step.action, step.confirm]), [
    ['gmail.list', false], ['gmail.read', false], ['telegram.send', true],
  ]);
});

test('invalid references and incomplete writes are not allowed', () => {
  const plan = normalizePlan({ steps: [
    { action: 'gmail.read', args: { position: '1' } },
    { action: 'gmail.trash', args: { position: 99 } },
    { action: 'gmail.send', args: { to: 'mail@example.test', subject: '' } },
  ], question: 'Что должно быть в письме?' }, ['gmail']);
  assert.deepEqual(plan, { steps: [], question: 'Что должно быть в письме?' });
});
