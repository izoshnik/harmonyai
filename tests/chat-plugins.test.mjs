import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePluginPlan } from '../lib/chat-plugins.js';

test('chat plan keeps operation order and accepts only selected, structured tools', () => {
  const plan = normalizePluginPlan({ steps: [
    { action: 'gmail.list', args: { query: 'is:unread', token: 'ignored' } },
    { action: 'telegram.send', args: { chat: 'me', fromResults: true } },
    { action: 'github.pull', args: { repo: 'test/repo', head: 'fix', base: 'main', title: 'Update' } },
    { action: 'gmail.trash', args: { position: 0, id: 'arbitrary' } },
    { action: 'gmail.url', args: { url: 'https://example.org' } }
  ] }, ['gmail', 'telegram']);
  assert.deepEqual(plan.steps, [
    { action: 'gmail.list', args: { query: 'is:unread', spam: false } },
    { action: 'telegram.send', args: { chat: 'me', fromResults: true } }
  ]);
});

test('repository edits require the explicit branch, path and instruction', () => {
  const edit = { action: 'github.commit', args: { repo: 'test/repo', branch: 'fix/ui', path: 'ui.js', message: 'Update UI', instruction: 'Change the heading.' } };
  const missing = { ...edit, args: { ...edit.args, branch: '' } };
  const alsoMissing = { action: 'telegram.send', args: { chat: 'me' } };
  assert.deepEqual(normalizePluginPlan({ steps: [missing, alsoMissing, edit] }, ['github', 'telegram']).steps, [edit]);
});
