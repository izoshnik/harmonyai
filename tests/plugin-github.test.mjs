import test from 'node:test';
import assert from 'node:assert/strict';
import { github } from '../lib/util-plugins.js';

test('writes are rejected for the default branch and file updates use the original SHA', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json(options.method === 'PUT'
      ? { content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } }
      : { default_branch: 'main' });
  });
  const change = { repo: 'example/repo', token: 'github_pat_test_token_01234567890', path: 'src/тест.js',
    branch: 'main', content: 'новый текст', sha: 'c'.repeat(40), message: 'Обновить файл' };
  await assert.rejects(github('github.commit', change), /отдельную ветку/);
  assert.equal(calls.length, 1);
  await github('github.commit', { ...change, branch: 'fix/folder' });
  const request = calls.at(-1);
  assert.equal(request.url, 'https://api.github.com/repos/example/repo/contents/src/%D1%82%D0%B5%D1%81%D1%82.js');
  assert.equal(request.body.sha, change.sha);
  assert.equal(request.body.branch, 'fix/folder');
  assert.equal(Buffer.from(request.body.content, 'base64').toString(), change.content);
});

test('file paths and branch names cannot redirect the GitHub request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected network call'); });
  const params = { repo: 'example/repo', branch: 'main', path: '../secret' };
  await assert.rejects(github('github.file', params), /путь/);
  await assert.rejects(github('github.file', { ...params, path: 'ok', branch: 'fix/../main' }), /ветки/);
  assert.equal(fetch.mock.callCount(), 0);
});
