import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { planPluginRequest, writePluginResponse } from './chat-plugins.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ID = /^[a-z0-9_-]{1,96}$/i;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

async function providerJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(9000) });
  if (response.status === 401 || response.status === 403) fail('Провайдер отклонил доступ. Проверь подключение и разрешения.', 403);
  if (response.status === 409 || response.status === 422) fail('Сервис отклонил изменение. Проверь параметры и наличие конфликта.', 409);
  if (response.status === 429) fail('Провайдер ограничил запросы. Попробуй позже.', 429);
  if (response.status === 404) fail('Данные не найдены у провайдера.', 404);
  if (!response.ok) fail('Провайдер не выполнил операцию.', 502);
  return response.json();
}

function bearer(token) {
  const value = String(token || '');
  if (!/^[a-z0-9._~-]{12,2048}$/i.test(value)) fail('Подключи аккаунт.');
  return { Authorization: 'Bearer ' + value };
}


function githubRepo(value) {
  const repo = String(value || '').replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!/^[\w-]{1,39}\/[\w.-]{1,100}$/.test(repo) || repo.split('/').some(part => /^\.+$/.test(part))) fail('Укажи репозиторий в формате владелец/имя.');
  return repo;
}

function githubBranch(value) {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 120 || !/^[\w./-]+$/.test(branch) || branch.includes('..') ||
      branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) fail('Проверь название ветки.');
  return branch;
}

function githubPath(value) {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path || path.length > 300 || /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Укажи путь к файлу относительно корня репозитория.');
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function github(action, body) {
  const source = 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'HarmonyAI', 'Content-Type': 'application/json',
    ...(body.token ? bearer(body.token) : {}) };
  const request = (path, method = 'GET', payload) => providerJson(source + path, { headers, method, body: payload && JSON.stringify(payload) });
  if (action === 'github.connect') {
    if (!body.token) fail('Укажи токен GitHub.');
    const me = await request('/user');
    return { login: me.login };
  }
  if (action === 'github.search') {
    const query = String(body.query || '').trim().slice(0, 100);
    if (!query) fail('Введи запрос поиска.');
    const params = new URLSearchParams({ q: query, per_page: '10' });
    const data = await request('/search/repositories?' + params);
    return { repos: (data.items || []).map(item => ({ name: item.full_name, description: item.description })) };
  }
  const repo = githubRepo(body.repo);
  const root = '/repos/' + repo;
  if (action === 'github.repo') {
    const [info, issues] = await Promise.all([
      request(root),
      request(root + '/issues?state=open&per_page=12').catch(() => [])
    ]);
    return { name: info.full_name, description: info.description, branch: info.default_branch, stars: info.stargazers_count,
      issues: issues.map(item => ({ title: item.title, number: item.number, pullRequest: Boolean(item.pull_request) })) };
  }
  if (action === 'github.file') {
    const path = githubPath(body.path);
    const branch = githubBranch(body.branch);
    const file = await request(root + '/contents/' + path + '?ref=' + encodeURIComponent(branch));
    if (file.type !== 'file' || file.encoding !== 'base64' || Number(file.size) > 150000) fail('Открой текстовый файл размером до 150 КБ.');
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(file.content, 'base64'));
      if (content.includes('\u0000')) throw Error('binary');
      return { content, sha: file.sha };
    } catch { fail('Редактор поддерживает файлы UTF-8.'); }
  }
  if (!body.token) fail('Для изменений подключи GitHub с правом записи.');
  if (action === 'github.branch') {
    const branch = githubBranch(body.branch);
    const base = githubBranch(body.base);
    if (branch === base) fail('Введи новое имя ветки.');
    const ref = await request(root + '/git/ref/heads/' + base.split('/').map(encodeURIComponent).join('/'));
    await request(root + '/git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: ref.object.sha });
    return { branch };
  }
  if (action === 'github.commit') {
    const path = githubPath(body.path);
    const branch = githubBranch(body.branch);
    const content = typeof body.content === 'string' ? body.content : null;
    const sha = String(body.sha || '');
    const message = String(body.message || '').trim().slice(0, 150);
    if (!message || !/^[a-f0-9]{40}$/i.test(sha) || content === null || Buffer.byteLength(content) > 150000) fail('Укажи сообщение коммита и открой текстовый файл до 150 КБ.');
    const info = await request(root);
    if (branch === info.default_branch) fail('Для коммита создай отдельную ветку.');
    const data = await request(root + '/contents/' + path, 'PUT', { branch, message, sha, content: Buffer.from(content).toString('base64') });
    return { sha: data.content.sha, commit: data.commit.sha };
  }
  if (action === 'github.pull') {
    const head = githubBranch(body.head);
    const base = githubBranch(body.base);
    const title = String(body.title || '').trim().slice(0, 150);
    if (!title || head === base) fail('Проверь заголовок и укажи разные ветки.');
    const data = await request(root + '/pulls', 'POST', { head, base, title, body: String(body.description || '').slice(0, 8000), draft: body.draft === true });
    return { number: data.number };
  }
  fail('Неизвестное действие GitHub.');
}

function textPart(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 16000);
  return (part.parts || []).map(textPart).find(Boolean) || '';
}

async function gmail(action, body) {
  const headers = { ...bearer(body.token), 'Content-Type': 'application/json' };
  const request = (path, options) => providerJson(GMAIL + path, { headers, ...options });
  if (action === 'gmail.profile') {
    const data = await request('/profile');
    return { email: data.emailAddress };
  }
  if (action === 'gmail.list') {
    const folder = body.spam === true ? 'SPAM' : 'INBOX';
    const params = new URLSearchParams({ maxResults: '8', labelIds: folder, includeSpamTrash: String(folder === 'SPAM') });
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 180) : '';
    if (query) params.set('q', query);
    const data = await request('/messages?' + params);
    const results = await Promise.all((data.messages || []).slice(0, 8).map(item => request('/messages/' + encodeURIComponent(item.id) + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From')));
    return { messages: results.map(message => ({
      id: message.id, snippet: message.snippet,
      subject: message.payload?.headers?.find(h => h.name.toLowerCase() === 'subject')?.value,
      from: message.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value
    })) };
  }
  if (action === 'gmail.send') {
    const to = String(body.to || '').trim();
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '');
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(to) || to.length > 254) fail('Укажи один допустимый адрес получателя.');
    if (!subject || /[\r\n]/.test(subject) || subject.length > 120 || !message.trim() || message.length > 20000) fail('Проверь тему и текст письма.');
    const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=';
    const encodedBody = Buffer.from(message).toString('base64').match(/.{1,76}/g).join('\r\n');
    const raw = Buffer.from('To: ' + to + '\r\nSubject: ' + encodedSubject + '\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + encodedBody).toString('base64url');
    const sent = await request('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
    return { id: sent.id };
  }
  const id = String(body.id || '');
  if (!ID.test(id)) fail('Выбери письмо.');
  if (action === 'gmail.read') {
    const data = await request('/messages/' + id + '?format=full');
    return { text: textPart(data.payload) || data.snippet || '' };
  }
  if (action === 'gmail.trash') {
    await request('/messages/' + id + '/trash', { method: 'POST', body: '{}' });
    return { ok: true };
  }
  fail('Неизвестное действие Gmail.');
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : '';
  try {
    if (action === 'chat.plan') return res.status(200).json(await planPluginRequest(body));
    if (action === 'chat.response') return res.status(200).json(await writePluginResponse(body));
    if (action === 'config') return res.status(200).json({ gmailClientId: process.env.COWORK_GOOGLE_CLIENT_ID || '' });
    if (action.startsWith('github.')) return res.status(200).json(await github(action, body));
    if (action.startsWith('gmail.')) return res.status(200).json(await gmail(action, body));
    return res.status(400).json({ error: { message: 'Неизвестное действие.' } });
  } catch (error) {
    const message = error.status ? error.message : 'Провайдер не ответил. Попробуй позже.';
    return res.status(error.status || 502).json({ error: { message } });
  }
}
