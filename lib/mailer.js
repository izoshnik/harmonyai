/* ============================================================================
   ПОЧТА HarmonyAI — отправка писем через Resend (resend.com).

   Переменные Vercel:
     RESEND_API_KEY   — ключ Resend (обязателен; без него письма не уходят,
                        а сервис работает как раньше);
     MAIL_FROM        — отправитель, по умолчанию «HarmonyAI <noreply@harmonyai.ru>»
                        (домен должен быть подтверждён в Resend);
     MAIL_REPLY_TO    — куда приходят ответы, по умолчанию harmonyaisent@gmail.com;
     MAIL_DAILY_LIMIT — писем в сутки (бесплатный Resend — 100), по умолчанию 100.

   Что отправляется:
     • оплата Pro и пополнение баланса API (api/payment/webhook.js);
     • блокировка аккаунта — автоматическая (рейтинг) и из панели;
     • рассылки из «Управления сервисом» — только тем, кто включил «Новости
       на почту» (profiles.settings.news_opt_in), со ссылкой отписки в одно
       касание. Больше суточного лимита не отправляем: остаток уходит по
       кнопке «Продолжить» на следующий день.
   Журнал — hm_mail_log (supabase/2026-11-04-mail.sql).
   ========================================================================== */
import crypto from 'node:crypto';
import { supabaseRest } from './auth.js';

const API = 'https://api.resend.com';
const env = (k) => String(process.env[k] || '').trim();
const SITE = () => (env('SITE_URL') || 'https://harmonyai.ru').replace(/\/+$/, '');
export const SUPPORT_EMAIL = 'harmonyaisent@gmail.com';

export function mailEnabled() { return Boolean(env('RESEND_API_KEY')); }
export function dailyLimit() { return Math.max(1, Math.trunc(Number(env('MAIL_DAILY_LIMIT')) || 100)); }
function fromAddr() { return env('MAIL_FROM') || 'HarmonyAI <noreply@harmonyai.ru>'; }
function replyTo() { return env('MAIL_REPLY_TO') || SUPPORT_EMAIL; }

/* ---------------------------------------------------------------- адреса */

export async function userEmail(userId) {
  if (!userId) return '';
  try {
    const u = await supabaseRest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { timeoutMs: 8000 });
    return String(u?.email || u?.user?.email || '').trim();
  } catch (e) { return ''; }
}

/* ---------------------------------------------------------------- журнал и лимит */

async function logMail(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return;
  try {
    await supabaseRest('/rest/v1/hm_mail_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(list), timeoutMs: 8000 });
  } catch (e) { console.warn('[mail] log failed', String(e.message).slice(0, 160)); }
}
/* Сколько писем ушло за последние 24 часа (скользящее окно — как считает Resend). */
export async function sentLast24h() {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = await supabaseRest(`/rest/v1/hm_mail_log?select=id&status=eq.sent&created_at=gte.${encodeURIComponent(since)}&limit=5000`, { timeoutMs: 8000 });
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { return 0; }
}

/* ---------------------------------------------------------------- шаблон письма */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Простой текст рассылки → HTML: абзацы, переносы, **жирный**, [ссылка](url). */
export function textToHtml(text) {
  return String(text || '').replace(/\r/g, '').trim().split(/\n{2,}/).map((p) => {
    let h = esc(p)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#111;">$1</a>')
      .replace(/\n/g, '<br>');
    return `<p style="margin:0 0 14px;">${h}</p>`;
  }).join('');
}

export function layout({ title, html, button, footer }) {
  const btn = button ? `<p style="margin:22px 0 6px;"><a href="${esc(button.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;">${esc(button.label)}</a></p>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;">
<div style="max-width:560px;margin:0 auto;padding:28px 16px;">
  <div style="font-weight:700;font-size:18px;letter-spacing:-.01em;margin:0 0 16px;">HarmonyAI</div>
  <div style="background:#fff;border-radius:18px;padding:26px 24px;font-size:15.5px;line-height:1.6;">
    <h1 style="font-size:20px;line-height:1.3;margin:0 0 14px;">${esc(title)}</h1>
    ${html}${btn}
  </div>
  <div style="font-size:12.5px;line-height:1.5;color:#71717a;padding:14px 6px;">${footer || `Вопросы — ответьте на это письмо или напишите на <a href="mailto:${SUPPORT_EMAIL}" style="color:#71717a;">${SUPPORT_EMAIL}</a>.`}</div>
</div></body></html>`;
}

const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

/* ---------------------------------------------------------------- отправка */

async function resend(path, payload, idempotencyKey) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) { const e = new Error(data?.message || `Resend ${r.status}`); e.status = r.status; throw e; }
  return data;
}

/* Одно письмо. Возвращает {ok, id?, skipped?, error?}; исключений не бросает. */
export async function sendMail({ to, subject, html, kind = 'other', userId = null, idempotencyKey = '', headers = null }) {
  if (!mailEnabled()) return { ok: false, skipped: 'no_key' };
  if (!to) return { ok: false, skipped: 'no_email' };
  if ((await sentLast24h()) >= dailyLimit()) {
    await logMail({ user_id: userId, kind, to_email: to, status: 'limit' });
    return { ok: false, skipped: 'daily_limit' };
  }
  try {
    const data = await resend('/emails', { from: fromAddr(), to: [to], reply_to: replyTo(), subject, html, text: plain(html), ...(headers ? { headers } : {}) }, idempotencyKey);
    await logMail({ user_id: userId, kind, to_email: to, status: 'sent', provider_id: data?.id || null });
    return { ok: true, id: data?.id || null };
  } catch (e) {
    console.warn('[mail] send failed', kind, String(e.message).slice(0, 200));
    await logMail({ user_id: userId, kind, to_email: to, status: 'failed', error: String(e.message).slice(0, 300) });
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

/* ---------------------------------------------------------------- служебные письма */

const rub = (kop) => (Number(kop) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dateRu = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }) : ''; };

export function paymentEmail({ kind, amountKop, periodDays, expiresAt }) {
  if (kind === 'topup') {
    return {
      subject: `Баланс API пополнен на ${rub(amountKop)} ₽`,
      html: layout({
        title: 'Баланс API пополнен',
        html: `<p style="margin:0 0 14px;">Мы получили оплату <b>${rub(amountKop)} ₽</b> — деньги уже на балансе API.</p><p style="margin:0 0 14px;">Расход и ключи — в личном кабинете.</p>`,
        button: { label: 'Открыть кабинет API', url: `${SITE()}/api-dashboard` }
      })
    };
  }
  const until = expiresAt ? dateRu(expiresAt) : '';
  return {
    subject: until ? `Оплата прошла — HarmonyAI Pro до ${until}` : 'Оплата прошла — HarmonyAI Pro активирован',
    html: layout({
      title: 'Спасибо! Pro активирован',
      html: `<p style="margin:0 0 14px;">Мы получили оплату <b>${rub(amountKop)} ₽</b>${periodDays ? ` за ${periodDays} дн.` : ''}.</p>`
        + `<p style="margin:0 0 14px;">HarmonyAI Pro ${until ? `действует до <b>${esc(until)}</b>` : 'активирован'}: модель Dynatos, лимиты в 25 раз выше и все функции.</p>`
        + '<p style="margin:0 0 14px;color:#52525b;">Если вы не совершали эту оплату — просто ответьте на это письмо.</p>',
      button: { label: 'Открыть HarmonyAI', url: `${SITE()}/chat` }
    })
  };
}

export function blockedEmail() {
  return {
    subject: 'Аккаунт HarmonyAI заблокирован',
    html: layout({
      title: 'Аккаунт заблокирован',
      html: '<p style="margin:0 0 14px;">Ваш аккаунт HarmonyAI заблокирован за нарушение <a href="' + SITE() + '/legal/terms.html" style="color:#111;">Условий использования</a> — оскорбления ИИ-помощника или попытки обойти его защиту.</p>'
        + `<p style="margin:0 0 14px;">Если вы считаете, что это ошибка, ответьте на это письмо или напишите на <a href="mailto:${SUPPORT_EMAIL}" style="color:#111;">${SUPPORT_EMAIL}</a>. Мы рассмотрим обращение в течение 10 рабочих дней.</p>`
    })
  };
}

export async function notifyPayment({ userId, kind = 'subscription', amountKop, periodDays = 0, expiresAt = null, paymentId = '' }) {
  if (!mailEnabled()) return { ok: false, skipped: 'no_key' };
  const to = await userEmail(userId);
  const m = paymentEmail({ kind, amountKop, periodDays, expiresAt });
  return sendMail({ to, subject: m.subject, html: m.html, kind: kind === 'topup' ? 'topup' : 'payment', userId, idempotencyKey: paymentId ? `pay-${paymentId}` : '' });
}

export async function notifyAccountBlocked(userId) {
  if (!mailEnabled()) return { ok: false, skipped: 'no_key' };
  const to = await userEmail(userId);
  const m = blockedEmail();
  return sendMail({ to, subject: m.subject, html: m.html, kind: 'blocked', userId, idempotencyKey: `blocked-${userId}-${new Date().toISOString().slice(0, 10)}` });
}

/* ---------------------------------------------------------------- отписка */

function secret() {
  return crypto.createHash('sha256').update('hm-mail:' + (env('SUPABASE_SERVICE_ROLE_KEY') || env('MAIL_SECRET') || 'dev')).digest();
}
export function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', secret()).update(String(userId)).digest('base64url').slice(0, 24);
}
export function unsubscribeUrl(userId) {
  return `${SITE()}/api/util?op=unsubscribe&u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}
export function checkUnsubscribe(userId, token) {
  const want = unsubscribeToken(userId);
  const got = String(token || '');
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

async function setNewsOptIn(userId, on) {
  const rows = await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=settings&limit=1`, { timeoutMs: 8000 });
  if (!rows?.[0]) return false;
  const settings = { ...(rows[0].settings || {}), news_opt_in: Boolean(on) };
  await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settings }), timeoutMs: 8000 });
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* /api/util?op=unsubscribe — ссылка из письма (GET) и отписка «в одно касание»
   почтовой программы (POST, заголовок List-Unsubscribe-Post). */
export async function unsubscribeHandler(req, res) {
  const q = req.query || {};
  const u = String(q.u || ''), t = String(q.t || '');
  const page = (title, text) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;color:#111;"><div style="max-width:460px;margin:12vh auto;padding:28px 24px;background:#fff;border-radius:18px;"><h1 style="font-size:20px;margin:0 0 10px;">${esc(title)}</h1><p style="margin:0 0 18px;line-height:1.55;">${text}</p><a href="${SITE()}/chat" style="color:#111;">Открыть HarmonyAI</a></div></body></html>`;
  res.setHeader('Cache-Control', 'no-store');
  if (!UUID_RE.test(u) || !checkUnsubscribe(u, t)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(page('Ссылка недействительна', 'Отписаться можно в настройках HarmonyAI: «Новости на почту».'));
  }
  try { await setNewsOptIn(u, false); } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send(page('Не получилось', 'Попробуйте ещё раз чуть позже или отключите новости в настройках HarmonyAI.'));
  }
  if (req.method === 'POST') return res.status(200).json({ ok: true });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(page('Вы отписались', 'Новости HarmonyAI больше не будут приходить на эту почту. Письма об оплате и важных изменениях в аккаунте приходят по-прежнему.'));
}

/* ---------------------------------------------------------------- рассылки */

function newsHtml(subject, body, userId) {
  return layout({
    title: subject,
    html: textToHtml(body),
    button: { label: 'Открыть HarmonyAI', url: `${SITE()}/chat` },
    footer: `Вы получили это письмо, потому что включили «Новости на почту» в HarmonyAI. <a href="${unsubscribeUrl(userId)}" style="color:#71717a;">Отписаться</a>.`
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function newsSubscribers() {
  const rows = await supabaseRest('/rest/v1/profiles?select=id&settings->>news_opt_in=eq.true&blocked_at=is.null&limit=20000', { timeoutMs: 10000 });
  return (rows || []).map((r) => r.id);
}

export async function mailStatus() {
  const [sent, subs, campaigns] = await Promise.all([
    sentLast24h(),
    newsSubscribers().then((l) => l.length).catch(() => null),
    supabaseRest('/rest/v1/hm_mail_campaigns?select=id,created_at,subject,total,sent,finished_at&order=created_at.desc&limit=20', { timeoutMs: 8000 }).catch(() => null)
  ]);
  return { enabled: mailEnabled(), from: fromAddr(), limit: dailyLimit(), sent24h: sent, subscribers: subs, campaigns, migrated: campaigns != null };
}

export async function sendTestNews({ to, subject, body, userId }) {
  if (!to) return { ok: false, error: 'Нет адреса' };
  return sendMail({ to, subject: '[Тест] ' + subject, html: newsHtml(subject, body, userId), kind: 'test', userId });
}

export async function createCampaign({ subject, body, createdBy }) {
  const [c] = await supabaseRest('/rest/v1/hm_mail_campaigns', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ subject, body, created_by: createdBy }]), timeoutMs: 8000
  }) || [];
  if (!c) throw new Error('Не удалось создать рассылку');
  return c;
}

/* Отправить очередную порцию рассылки: подписчикам, кому ещё не ушло, в
   пределах суточного лимита. Пакетами по 100 (Resend batch). */
export async function continueCampaign(id) {
  if (!mailEnabled()) return { ok: false, error: 'Почта не настроена: добавьте RESEND_API_KEY в Vercel' };
  const [c] = await supabaseRest(`/rest/v1/hm_mail_campaigns?id=eq.${encodeURIComponent(id)}&limit=1`, { timeoutMs: 8000 }) || [];
  if (!c) return { ok: false, error: 'Рассылка не найдена' };
  const kind = 'news:' + c.id;
  const [subs, sentRows] = await Promise.all([
    newsSubscribers(),
    supabaseRest(`/rest/v1/hm_mail_log?select=user_id&kind=eq.${encodeURIComponent(kind)}&status=eq.sent&limit=20000`, { timeoutMs: 10000 })
  ]);
  const done = new Set((sentRows || []).map((r) => r.user_id));
  const todo = subs.filter((u) => !done.has(u));
  const room = Math.max(0, dailyLimit() - (await sentLast24h()));
  const portion = todo.slice(0, room);
  let sent = 0;
  for (let i = 0; i < portion.length; i += 100) {
    const ids = portion.slice(i, i + 100);
    const emails = await pool(ids, 8, (u) => userEmail(u));
    const batch = ids.map((u, k) => ({ u, to: emails[k] })).filter((x) => x.to);
    if (!batch.length) continue;
    try {
      const data = await resend('/emails/batch', batch.map((x) => ({
        from: fromAddr(), to: [x.to], reply_to: replyTo(), subject: c.subject, html: newsHtml(c.subject, c.body, x.u), text: plain(newsHtml(c.subject, c.body, x.u)),
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl(x.u)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      })), `${kind}-${i}-${batch[0].u}`);
      const ids2 = (data?.data || []).map((d) => d.id);
      await logMail(batch.map((x, k) => ({ user_id: x.u, kind, to_email: x.to, status: 'sent', provider_id: ids2[k] || null })));
      sent += batch.length;
    } catch (e) {
      await logMail(batch.map((x) => ({ user_id: x.u, kind, to_email: x.to, status: 'failed', error: String(e.message).slice(0, 300) })));
      return { ok: false, error: 'Resend: ' + String(e.message).slice(0, 160), sent };
    }
  }
  const total = subs.length;
  const sentTotal = done.size + sent;
  await supabaseRest(`/rest/v1/hm_mail_campaigns?id=eq.${encodeURIComponent(c.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ total, sent: sentTotal, finished_at: sentTotal >= total ? new Date().toISOString() : null }), timeoutMs: 8000
  }).catch(() => null);
  return { ok: true, sent, sentTotal, total, left: Math.max(0, total - sentTotal), limitReached: todo.length > portion.length };
}
