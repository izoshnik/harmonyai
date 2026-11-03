/* ============================================================================
   ВРЕМЕННАЯ ПОЧТА — /api/util?op=tempmail.

   ИИ создаёт одноразовый ящик, показывает адрес, ждёт письма, читает их и
   достаёт коды подтверждения и ссылки. Провайдеры (без ключей):
     • mail.tm (основной) — api.mail.tm, аккаунт + JWT;
     • tempmail.lol (запасной) — api.tempmail.lol/v2, токен ящика, ящик живёт ~1 час;
     • Guerrilla Mail (последний запасной) — api.guerrillamail.com, sid_token.
   mail.tm с серверов Vercel иногда отвечает 500 — тогда ящик выдаёт следующий.
   Временные ящики только ПРИНИМАЮТ письма — отправить письмо из них нельзя.

   Клиенту отдаётся «ручка» ящика: подписанный (HMAC) блок с провайдером,
   адресом и токеном доступа, привязанный к user_id. Чужую ручку подставить
   нельзя: подпись и владелец проверяются на каждом запросе.
   action: create | inbox {handle} | read {handle, id}
   ============================================================================ */
import crypto from 'node:crypto';
import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { reportError } from './observe.js';

const MT = 'https://api.mail.tm';
const GM = 'https://api.guerrillamail.com/ajax.php';
const TL = 'https://api.tempmail.lol/v2';
const UA = 'HarmonyAI/1.0 (+https://harmonyai.ru)';

function secret() {
  return crypto.createHash('sha256').update('hm-tempmail:' + String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TEMPMAIL_SECRET || 'dev')).digest();
}
export function signHandle(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  return body + '.' + mac;
}
export function readHandle(handle, userId) {
  const [body, mac] = String(handle || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!d || d.u !== userId || !d.a || !d.t) return null;
    return d;
  } catch (e) { return null; }
}

async function jfetch(url, init = {}, ms = 9000) {
  const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) { const e = new Error(`${r.status} ${text.slice(0, 160)}`); e.status = r.status; throw e; }
  return data;
}
/* mail.tm отдаёт коллекции по-разному: с Accept: application/json — простым
   массивом, с application/ld+json — объектом { 'hydra:member': [...] }. */
export const members = (d) => (Array.isArray(d) ? d : (d && (d['hydra:member'] || d.member)) || []);
const rnd = (n) => crypto.randomBytes(n).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase();

/* ---------------------------------------------------------------- провайдеры */
async function mtCreate() {
  const d = await jfetch(`${MT}/domains`);
  const domains = members(d).filter((x) => x && x.isActive !== false && !x.isPrivate);
  if (!domains.length) throw new Error('mail.tm: no domains');
  const domain = domains[Math.floor(Math.random() * domains.length)].domain;
  const address = `hm${rnd(6)}${Date.now().toString(36).slice(-3)}@${domain}`.toLowerCase();
  const password = rnd(14) + 'A9';
  await jfetch(`${MT}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }) });
  const tok = await jfetch(`${MT}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }) });
  if (!tok || !tok.token) throw new Error('mail.tm: no token');
  return { p: 'mt', a: address, t: tok.token };
}
async function mtInbox(h) {
  const d = await jfetch(`${MT}/messages?page=1`, { headers: { Authorization: `Bearer ${h.t}` } });
  return members(d).slice(0, 20).map((m) => ({
    id: m.id, from: (m.from && (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address)) || '',
    subject: m.subject || '(без темы)', intro: m.intro || '', at: m.createdAt || null
  }));
}
async function mtRead(h, id) {
  const m = await jfetch(`${MT}/messages/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${h.t}` } });
  const html = Array.isArray(m.html) ? m.html.join('\n') : String(m.html || '');
  return { id: m.id, from: (m.from && m.from.address) || '', subject: m.subject || '', at: m.createdAt || null, text: m.text || htmlToText(html), html };
}
async function gmCreate() {
  const d = await jfetch(`${GM}?f=get_email_address&lang=en`);
  if (!d || !d.email_addr || !d.sid_token) throw new Error('guerrilla: no address');
  return { p: 'gm', a: d.email_addr, t: d.sid_token };
}
async function gmInbox(h) {
  const d = await jfetch(`${GM}?f=check_email&seq=0&sid_token=${encodeURIComponent(h.t)}`);
  return ((d && d.list) || []).filter((m) => !/guerrillamail\.com$/i.test(String(m.mail_from || ''))).slice(0, 20).map((m) => ({
    id: String(m.mail_id), from: m.mail_from || '', subject: m.mail_subject || '(без темы)', intro: htmlToText(m.mail_excerpt || '').slice(0, 200),
    at: m.mail_timestamp ? new Date(Number(m.mail_timestamp) * 1000).toISOString() : null
  }));
}
async function gmRead(h, id) {
  const m = await jfetch(`${GM}?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(h.t)}`);
  const html = String((m && m.mail_body) || '');
  return { id: String(m.mail_id || id), from: m.mail_from || '', subject: m.mail_subject || '', at: m.mail_timestamp ? new Date(Number(m.mail_timestamp) * 1000).toISOString() : null, text: htmlToText(html), html };
}

/* tempmail.lol отдаёт письма целиком прямо в списке и без id — id собираем
   из даты, отправителя и темы, а «прочитать» = найти письмо в свежем списке. */
async function tlCreate() {
  const d = await jfetch(`${TL}/inbox/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!d || !d.address || !d.token) throw new Error('tempmail.lol: no address');
  return { p: 'tl', a: d.address, t: d.token };
}
async function tlEmails(h) {
  const d = await jfetch(`${TL}/inbox?token=${encodeURIComponent(h.t)}`);
  if (d && d.expired) { const e = new Error('tempmail.lol: expired'); e.status = 404; throw e; }
  return ((d && d.emails) || []).map((m) => ({
    id: crypto.createHash('sha1').update(`${m.date}|${m.from}|${m.subject}`).digest('hex').slice(0, 16),
    from: m.from || '', subject: m.subject || '(без темы)',
    at: m.date ? new Date(Number(m.date) || m.date).toISOString() : null,
    text: m.body || htmlToText(m.html || '')
  })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
async function tlInbox(h) {
  return (await tlEmails(h)).slice(0, 20).map(({ text, ...m }) => ({ ...m, intro: String(text || '').replace(/\s+/g, ' ').slice(0, 200) }));
}
async function tlRead(h, id) {
  const m = (await tlEmails(h)).find((x) => x.id === id);
  if (!m) throw new Error('tempmail.lol: message not found');
  return m;
}

export const PROVIDERS = {
  mt: { name: 'mail.tm', create: mtCreate, inbox: mtInbox, read: mtRead },
  tl: { name: 'tempmail.lol', create: tlCreate, inbox: tlInbox, read: tlRead },
  gm: { name: 'Guerrilla Mail', create: gmCreate, inbox: gmInbox, read: gmRead }
};

/* ---------------------------------------------------------------- текст и коды */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => `${inner.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
/* Коды подтверждения: сначала рядом со словами «код/code/OTP/PIN», потом
   отдельные 4–8-значные числа (кроме годов). Ссылки — verify/confirm/activate. */
export function extractCodes(text) {
  const t = String(text || '');
  const codes = [];
  const add = (c) => { c = String(c || '').trim(); if (c && !codes.includes(c) && codes.length < 3) codes.push(c); };
  // После ключевого слова ищем первый «токен» с цифрой в ближайших 60 символах.
  const kw = /(?:код|code|pin|otp|пароль|passcode|verification|подтвержд\S*|одноразов\S*)/gi;
  let m;
  while ((m = kw.exec(t))) {
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 60).split('\n')[0];
    const tok = tail.match(/(?:^|[^A-Za-z0-9])((?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,8}|\d{3}[ -]\d{3})(?![A-Za-z0-9])/);
    if (tok) add(tok[1].replace(/[ -]/g, ''));
  }
  if (!codes.length) {
    const nums = t.match(/(?<![\d.,:/-])\d{4,8}(?![\d.,:/-])/g) || [];
    nums.filter((n) => !(n.length === 4 && /^(19|20)\d\d$/.test(n))).slice(0, 2).forEach(add);
  }
  const links = [];
  (t.match(/https?:\/\/[^\s)"'<>]+/g) || []).forEach((u) => {
    if (/verif|confirm|activat|validate|magic|login|signin|auth|token|подтвер/i.test(u) && !links.includes(u) && links.length < 3) links.push(u.replace(/[.,;]+$/, ''));
  });
  return { codes, links };
}

const budget = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const r = budget.get(key) || { at: now, n: 0 };
  if (now - r.at > windowMs) { r.at = now; r.n = 0; }
  r.n += 1; budget.set(key, r);
  if (budget.size > 10000) budget.delete(budget.keys().next().value);
  return r.n <= limit;
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const action = String(body.action || 'create');
  try {
    if (action === 'create') {
      if (!allow('c:' + user.id, 10, 3600000)) return res.status(429).json({ ok: false, error: { message: 'Слишком много временных ящиков за час. Попробуйте позже.' } });
      let box = null, last = null;
      const failed = [];
      for (const { name, create: make } of Object.values(PROVIDERS)) {
        // mail.tm ограничивает частоту запросов (≈8 в секунду на IP, а IP у
        // Vercel общие) — на 429 даём ему вторую попытку.
        for (let attempt = 0; attempt < 2 && !box; attempt++) {
          try { box = await make(); } catch (e) {
            last = e;
            if (attempt === 0 && e.status === 429) { await new Promise((r) => setTimeout(r, 1200)); continue; }
            failed.push(`${name}: ${String(e.message || e).slice(0, 200)}`);
            console.warn('[tempmail] create failed', name, String(e.message).slice(0, 160));
            break;
          }
        }
        if (box) break;
      }
      // В «Управление сервисом → Ошибки» пишем, только когда отказали двое и больше:
      // одиночный отказ mail.tm с Vercel — известная история и шум в журнале.
      if (failed.length > 1 || (!box && failed.length)) await reportError({ source: 'tempmail', status: (last && last.status) || 502, message: failed.join(' | '), userId: user.id, allowText: false }).catch(() => {});
      if (!box) return res.status(502).json({ ok: false, error: { message: 'Сервисы временной почты сейчас не отвечают. Попробуйте чуть позже.' }, detail: String(last && last.message || '').slice(0, 160) });
      const handle = signHandle({ ...box, u: user.id, c: Date.now() });
      return res.status(200).json({ ok: true, address: box.a, provider: PROVIDERS[box.p].name, handle });
    }
    const h = readHandle(body.handle, user.id);
    if (!h) return res.status(400).json({ ok: false, error: { message: 'Ящик не найден — создайте новый.' } });
    if (!allow('r:' + user.id, 240, 3600000)) return res.status(429).json({ ok: false, error: { message: 'Слишком частые проверки почты.' } });
    if (action === 'inbox') {
      const prov = PROVIDERS[h.p] || PROVIDERS.gm;
      const list = await prov.inbox(h);
      return res.status(200).json({ ok: true, address: h.a, messages: list });
    }
    if (action === 'read') {
      const id = String(body.id || '').slice(0, 80);
      if (!id) return res.status(400).json({ ok: false, error: { message: 'Не указано письмо' } });
      const m = await (PROVIDERS[h.p] || PROVIDERS.gm).read(h, id);
      const text = String(m.text || '').slice(0, 20000);
      return res.status(200).json({ ok: true, message: { id: m.id, from: m.from, subject: m.subject, at: m.at, text }, ...extractCodes(m.subject + '\n' + text) });
    }
    return res.status(400).json({ ok: false, error: { message: 'Unknown action' } });
  } catch (e) {
    const expired = e && (e.status === 401 || e.status === 404);
    console.warn('[tempmail]', action, String(e.message).slice(0, 200));
    return res.status(expired ? 410 : 502).json({ ok: false, expired, error: { message: expired ? 'Срок жизни ящика истёк — создайте новый.' : 'Почтовый сервис не ответил. Попробуйте ещё раз.' } });
  }
}
