import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { planTask, summarizeTask } from './cowork-plan.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ID = /^[a-z0-9_-]{1,96}$/i;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

async function providerJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(9000) });
  if (response.status === 401 || response.status === 403) fail('Провайдер отклонил доступ. Проверь подключение и разрешения.', 403);
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

async function github(body) {
  const repo = String(body.repo || '').replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!/^[\w-]{1,39}\/[\w.-]{1,100}$/.test(repo) || repo.split('/').some(part => /^\.+$/.test(part))) fail('Укажи репозиторий в формате владелец/имя.');
  const root = 'https://api.github.com/repos/' + repo.split('/').map(encodeURIComponent).join('/');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'HarmonyAI', ...(body.token ? bearer(body.token) : {}) };
  const [info, issues] = await Promise.all([
    providerJson(root, { headers }),
    providerJson(root + '/issues?state=open&per_page=12', { headers }).catch(() => [])
  ]);
  return {
    name: info.full_name, description: info.description, branch: info.default_branch, stars: info.stargazers_count,
    issues: issues.map(item => ({ title: item.title, number: item.number, pullRequest: Boolean(item.pull_request) }))
  };
}

function textPart(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 16000);
  return (part.parts || []).map(textPart).find(Boolean) || '';
}

async function gmail(action, body) {
  const headers = { ...bearer(body.token), 'Content-Type': 'application/json' };
  const request = (path, options) => providerJson(GMAIL + path, { headers, ...options });
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

async function telegram(action, body) {
  const token = String(body.token || '');
  if (!/^\d{6,16}:[a-z0-9_-]{25,100}$/i.test(token)) fail('Введи токен своего Telegram-бота.');
  const call = (method, payload) => providerJson('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (action === 'telegram.inbox') {
    const data = await call('getUpdates', { limit: 30, timeout: 0, allowed_updates: ['message', 'channel_post'] });
    if (!data.ok) fail('Telegram не вернул обновления.', 502);
    const chat = typeof body.chat === 'string' ? body.chat.trim().toLowerCase() : '';
    return { messages: (data.result || []).map(update => update.message || update.channel_post).filter(message => message &&
        (!chat || String(message.chat?.id) === chat || ('@' + (message.chat?.username || '')).toLowerCase() === chat)).map(message => ({
      chat: String(message.chat?.id || ''), title: message.chat?.title || message.chat?.first_name || '', text: String(message.text || message.caption || '').slice(0, 2000)
    })) };
  }
  if (action === 'telegram.send') {
    const chatId = String(body.chat || '').trim();
    const text = String(body.message || '').trim();
    if (!/^-?\d{1,19}$|^@[a-z0-9_]{5,32}$/i.test(chatId) || !text || text.length > 4000) fail('Укажи ID чата и текст.');
    const data = await call('sendMessage', { chat_id: chatId, text });
    if (!data.ok) fail('Telegram не подтвердил отправку.', 502);
    return { id: data.result?.message_id };
  }
  fail('Неизвестное действие Telegram.');
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
    if (action === 'config') return res.status(200).json({ gmailClientId: process.env.COWORK_GOOGLE_CLIENT_ID || '' });
    if (action === 'task.plan') return res.status(200).json(await planTask(body));
    if (action === 'task.summarize') return res.status(200).json(await summarizeTask(body));
    if (action === 'github.repo') return res.status(200).json(await github(body));
    if (action.startsWith('gmail.')) return res.status(200).json(await gmail(action, body));
    if (action.startsWith('telegram.')) return res.status(200).json(await telegram(action, body));
    return res.status(400).json({ error: { message: 'Неизвестное действие.' } });
  } catch (error) {
    return res.status(error.status || 502).json({ error: { message: error.status ? error.message : 'Провайдер не ответил. Попробуй позже.' } });
  }
}
