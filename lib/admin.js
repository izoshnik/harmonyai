/* ============================================================================
   ПАНЕЛЬ УПРАВЛЕНИЯ СЕРВИСОМ (/management) — серверная часть.
   Все действия идут через /api/account?action=admin.* (лимит Vercel Hobby —
   12 функций, отдельный эндпоинт не заводим).

   Доступ (роль читается на сервере из profiles.role):
     developer, admin — всё: почты, финансы, действия над пользователями;
     moderator        — статистика и ошибки, без финансов, без почт
                        (маскируются) и без действий.
   Сводки считаются функциями hm_admin_* в базе (supabase/2026-11-02-admin.sql),
   сюда приходит готовый JSON.
   ============================================================================ */
import { mailStatus, sendTestNews, createCampaign, continueCampaign, notifyAccountBlocked, userEmail } from './mailer.js';
import { incidentsFor, pardon } from './moderation.js';
import { supabaseRest, readProfileRole } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { periodStart } from './stats.js';
import { PRO_PLANS, usdRubRateString } from './pricing.js';
import { providerForModel, FREE_TEXT_MODEL, PRO_TEXT_MODEL, currentModelName } from './models.js';
import { reportError } from './observe.js';

const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, error: { message, ...extra } });
const FULL = ['developer', 'admin'];
const VIEW = ['developer', 'admin', 'moderator'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function staffRole(user) {
  if (isDevAccountUser(user)) {
    const r = await readProfileRole(user.id);
    return r === 'developer' ? 'developer' : 'admin';
  }
  return readProfileRole(user.id);
}

const rpc = (name, args = {}, timeoutMs = 15000) =>
  supabaseRest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args), timeoutMs });

const days = (v, def, max = 365) => Math.max(1, Math.min(max, Math.trunc(Number(v) || def)));

/* Маска почты для модератора: a***@gmail.com */
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : s;
  return s[0] + '***' + s.slice(at);
}
function maskDeep(value) {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'email' || k === 'admin' || k === 'invitedBy' ? maskEmail(v) : maskDeep(v);
    return out;
  }
  return value;
}

/* Миграция не выполнена → понятное сообщение вместо 503 без причины. */
function migrationHint(e) {
  const code = e?.code || '';
  if (code === 'PGRST202' || code === '42883' || code === '42P01' || code === 'PGRST205' || /function .* does not exist|Could not find the function/i.test(String(e?.message || ''))) {
    return 'Выполните в Supabase SQL-миграцию supabase/2026-11-02-admin.sql (SQL Editor → вставить → Run).';
  }
  return null;
}

async function hmStats(period) {
  try {
    return await rpc('hm_stats', { p_user: null, p_since: periodStart(period), p_until: new Date().toISOString() }, 10000);
  } catch (e) { return null; }
}

/* Остаток на OpenRouter (единственный провайдер с открытым API баланса). */
async function openRouterBalance() {
  const key = providerForModel('x/y').apiKey;
  if (!key) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { error: r.status };
    const d = (await r.json())?.data || {};
    return { totalUsd: Number(d.total_credits) || 0, usedUsd: Number(d.total_usage) || 0 };
  } catch (e) { return { error: 'timeout' }; }
}

/* «Проверить сейчас»: короткий запрос к каждой модели чата. */
async function probeModels() {
  const adan = String(process.env.ADAN_MODELS || '').split(',').map((x) => currentModelName(x.trim())).filter(Boolean);
  const list = [...new Set([PRO_TEXT_MODEL, FREE_TEXT_MODEL, ...adan])].slice(0, 8);
  return Promise.all(list.map(async (m) => {
    const pr = providerForModel(m);
    const t0 = Date.now();
    if (!pr.apiKey) return { model: m, ok: false, error: 'нет ключа' };
    try {
      const body = { model: m, messages: [{ role: 'user', content: 'Ответь одним словом: привет' }], max_tokens: 40, stream: false };
      if (pr.openrouter) body.reasoning = { enabled: false };
      const r = await fetch(`${pr.baseUrl}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pr.apiKey}`, ...(pr.headers || {}) },
        body: JSON.stringify(body)
      });
      const t = await r.text();
      return { model: m, provider: pr.openrouter ? 'openrouter' : 'pro-ai', ok: r.ok, status: r.status, ms: Date.now() - t0, error: r.ok ? null : t.slice(0, 200) };
    } catch (e) {
      return { model: m, provider: pr.openrouter ? 'openrouter' : 'pro-ai', ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message).slice(0, 200) };
    }
  }));
}

async function audit(adminId, targetId, action, detail) {
  try {
    await supabaseRest('/rest/v1/hm_admin_actions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ admin_id: adminId, target_id: targetId, action, detail }) });
  } catch (e) { console.warn('[admin] audit failed', e.code || e.status); }
}

async function userAction(user, role, body) {
  const target = String(body.target || '');
  const op = String(body.op || '');
  if (!UUID_RE.test(target)) return { status: 400, message: 'Не выбран пользователь' };
  if (target === user.id) return { status: 400, message: 'Действия над своим аккаунтом недоступны' };
  const rows = await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(target)}&select=*&limit=1`, { method: 'GET' });
  const prof = Array.isArray(rows) ? rows[0] : null;
  if (!prof) return { status: 404, message: 'Профиль не найден' };
  const targetRole = String(prof.role || '').toLowerCase();
  if (['block', 'revoke_pro'].includes(op) && FULL.includes(targetRole) && role !== 'developer') {
    return { status: 403, message: 'Сотрудника может ограничить только Developer' };
  }
  let patch = null;
  let detail = {};
  if (op === 'grant_pro') {
    const n = Math.max(1, Math.min(3650, Math.trunc(Number(body.days) || 30)));
    const cur = String(prof.plan || '').toLowerCase() === 'pro' ? Date.parse(prof.plan_expires_at || '') : NaN;
    if (String(prof.plan || '').toLowerCase() === 'pro' && !prof.plan_expires_at) return { status: 400, message: 'У пользователя уже бессрочный Pro' };
    const base = Number.isFinite(cur) && cur > Date.now() ? cur : Date.now();
    patch = { plan: 'pro', plan_expires_at: new Date(base + n * 86400000).toISOString() };
    detail = { days: n, until: patch.plan_expires_at };
  } else if (op === 'revoke_pro') {
    patch = { plan: 'free', plan_expires_at: null };
  } else if (op === 'block') {
    patch = { blocked_at: new Date().toISOString(), blocked_reason: String(body.reason || '').trim().slice(0, 300) || null };
    detail = { reason: patch.blocked_reason };
  } else if (op === 'unblock') {
    patch = { blocked_at: null, blocked_reason: null };
    // Разблокировка «прощает» нарушения — иначе первое же сообщение снова заблокировало бы аккаунт.
    await pardon(target).catch(() => null);
    detail = { pardoned: true };
  } else if (op === 'reset_limits') {
    patch = { limits_reset_at: new Date().toISOString() };
  } else {
    return { status: 400, message: 'Неизвестное действие' };
  }
  try {
    await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(target)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  } catch (e) {
    return { status: 503, message: migrationHint(e) || 'Не удалось сохранить изменения' };
  }
  await audit(user.id, target, op, detail);
  // Письмо пользователю о блокировке (причина из панели в письмо не попадает — она только для персонала).
  if (op === 'block') await notifyAccountBlocked(target).catch(() => null);
  return { status: 200, patch };
}

export async function handleAdmin(req, res, user, action, body) {
  const role = await staffRole(user);
  if (!VIEW.includes(role)) return fail(res, 403, 'Доступ только для Developer, Admin и Moderator');
  const full = FULL.includes(role);
  const q = req.query || {};
  const name = action.slice('admin.'.length);
  const out = (data) => res.status(200).json({ ok: true, role, data: full ? data : maskDeep(data) });
  const fullOnly = () => fail(res, 403, 'Раздел доступен только Developer и Admin');

  try {
    switch (name) {
      case 'me':
        return res.status(200).json({ ok: true, role, can: { finance: full, emails: full, actions: full } });
      case 'overview': {
        const [ov, hour, all] = await Promise.all([rpc('hm_admin_overview'), hmStats('hour'), hmStats('all')]);
        return out({ ...ov, online: hour?.onlineUsers ?? null, activeSeconds: all?.activeSeconds ?? null, filesProcessed: all?.filesProcessed ?? null,
          filesCreated: all?.filesCreated ?? null, recognized: all?.recognized ?? null, images: all?.images ?? null, apiTokensAll: all?.apiTokens ?? null,
          revenueMonthKop: full ? ov?.revenueMonthKop : null, costMonthUsd: full ? ov?.costMonthUsd : null, usdRub: Number(usdRubRateString()) });
      }
      case 'users': {
        const page = Math.max(0, Math.trunc(Number(q.page) || 0));
        const data = await rpc('hm_admin_users', { p_q: String(q.q || '').slice(0, 100), p_filter: String(q.filter || 'all'), p_sort: String(q.sort || 'created'), p_limit: 50, p_offset: page * 50 });
        return out(data);
      }
      case 'user': {
        if (!UUID_RE.test(String(q.id || ''))) return fail(res, 400, 'Некорректный id');
        const data = await rpc('hm_admin_user', { p_user: String(q.id) });
        if (!data) return fail(res, 404, 'Пользователь не найден');
        // Скрытый рейтинг и нарушения (supabase/2026-11-04-moderation.sql). Нет миграции — просто без блока.
        const [incidents, trust] = await Promise.all([
          incidentsFor(String(q.id)).catch(() => null),
          supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(String(q.id))}&select=trust_score&limit=1`).then((r) => r?.[0]?.trust_score).catch(() => null)
        ]);
        if (incidents) data.moderation = { score: trust == null ? 100 : Number(trust), incidents };
        if (!full) { delete data.revenue; if (data.api) delete data.api.balanceMicro; }
        return out({ ...data, usdRub: Number(usdRubRateString()) });
      }
      case 'usage':
        return out(await rpc('hm_admin_usage', { p_days: days(q.days, 30) }));
      case 'api':
        if (!full) return fullOnly();
        return out(await rpc('hm_admin_api', { p_days: days(q.days, 30) }));
      case 'errors':
        return out(await rpc('hm_admin_errors', { p_days: days(q.days, 7), p_q: String(q.q || '').slice(0, 60), p_limit: 200 }));
      case 'finance': {
        if (!full) return fullOnly();
        const [fin, or] = await Promise.all([rpc('hm_admin_finance', { p_days: days(q.days, 30, 3650) }), openRouterBalance()]);
        return out({ ...fin, openrouter: or, usdRub: Number(usdRubRateString()),
          prices: { monthRub: Number(PRO_PLANS.month.priceRublesString), weekRub: Number(PRO_PLANS.week.priceRublesString) },
          fixed: [
            { name: 'Vercel', plan: 'Hobby', rub: 0 },
            { name: 'Supabase', plan: process.env.HM_SUPABASE_PLAN || 'Free', rub: Number(process.env.HM_SUPABASE_RUB || 0) }
          ] });
      }
      case 'providers':
        return out(await rpc('hm_admin_providers', { p_days: days(q.days, 7) }));
      /* Почта и рассылки (lib/mailer.js). Отправлять могут только Developer и Admin. */
      case 'mail':
        return out(await mailStatus());
      case 'mail_test':
      case 'mail_send':
      case 'mail_continue': {
        if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается');
        if (!full) return fail(res, 403, 'Рассылки доступны Developer и Admin');
        if (name === 'mail_continue') {
          const r = await continueCampaign(String(body?.id || ''));
          return r.ok ? out(r) : fail(res, 400, r.error || 'Не получилось');
        }
        const subject = String(body?.subject || '').trim().slice(0, 150);
        const text = String(body?.body || '').trim().slice(0, 20000);
        if (subject.length < 3 || text.length < 10) return fail(res, 400, 'Нужны тема (от 3 символов) и текст (от 10 символов)');
        if (name === 'mail_test') {
          const to = String(user.email || '') || await userEmail(user.id);
          const r = await sendTestNews({ to, subject, body: text, userId: user.id });
          return r.ok ? out({ sentTo: to }) : fail(res, 400, r.skipped === 'no_key' ? 'Почта не настроена: добавьте RESEND_API_KEY в Vercel' : r.skipped === 'daily_limit' ? 'Суточный лимит писем исчерпан' : (r.error || 'Не удалось отправить'));
        }
        const c = await createCampaign({ subject, body: text, createdBy: user.id }).catch((e) => ({ error: migrationHint(e) || e.message }));
        if (c.error) return fail(res, 503, c.error);
        const r = await continueCampaign(c.id);
        return r.ok ? out({ id: c.id, ...r }) : fail(res, 400, r.error || 'Не получилось');
      }
      case 'probe':
        if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается');
        return out({ models: await probeModels(), openrouter: await openRouterBalance() });
      case 'features':
        return out(await rpc('hm_admin_features', { p_days: days(q.days, 30) }));
      case 'retention': {
        const [ret, all] = await Promise.all([rpc('hm_admin_retention'), hmStats('all')]);
        return out({ ...ret, sources: all?.sources || [], otherSources: all?.otherSources || [] });
      }
      case 'feedback':
        return out(await rpc('hm_admin_feedback', { p_days: days(q.days, 30) }));
      case 'action': {
        if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается');
        if (!full) return fail(res, 403, 'Действия доступны только Developer и Admin');
        const r = await userAction(user, role, body);
        if (r.status !== 200) return fail(res, r.status, r.message);
        return res.status(200).json({ ok: true, patch: r.patch });
      }
      default:
        return fail(res, 404, 'Неизвестный раздел');
    }
  } catch (e) {
    const hint = migrationHint(e);
    console.warn('[admin]', name, e?.code || e?.status, String(e?.message || '').slice(0, 200));
    return fail(res, 503, hint || 'Данные пока недоступны. Попробуйте обновить через минуту.', { migration: Boolean(hint) });
  }
}

/* ---------------------------------------------------------------- клиент
   errors.report — ошибка, пойманная в браузере (обрыв сети, сбой разбора
   ответа): код создаёт сервер, клиент показывает его пользователю.
   stats.rate — лайк / дизлайк ответа. */
const reportBudget = new Map();
// Настройка «Использовать мои чаты для улучшения сервиса» (по умолчанию включена).
async function textAllowed(userId) {
  try {
    const rows = await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=settings&limit=1`, { method: 'GET', timeoutMs: 2500 });
    return rows?.[0]?.settings?.ai_training !== false;
  } catch (e) { return true; }
}
export async function handleClientSignals(req, res, user, action, body) {
  if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается');
  if (action === 'errors.report') {
    const now = Date.now();
    const rec = reportBudget.get(user.id) || { at: now, n: 0 };
    if (now - rec.at > 60000) { rec.at = now; rec.n = 0; }
    rec.n += 1;
    reportBudget.set(user.id, rec);
    if (reportBudget.size > 5000) reportBudget.delete(reportBudget.keys().next().value);
    if (rec.n > 12) return fail(res, 429, 'Слишком много отчётов');
    const allowText = await textAllowed(user.id);
    const code = await reportError({
      source: String(body.source || 'client').slice(0, 30),
      status: Number(body.status) || 0,
      message: String(body.message || '').slice(0, 1000),
      detail: { where: String(body.where || '').slice(0, 80), model: String(body.model || '').slice(0, 40), ua: String(req.headers['user-agent'] || '').slice(0, 200), online: body.online !== false },
      userId: user.id, userText: String(body.text || ''), allowText
    });
    return res.status(200).json({ ok: true, code });
  }
  if (action === 'stats.rate') {
    const rating = Number(body.rating);
    if (rating !== 1 && rating !== -1) return fail(res, 400, 'Некорректная оценка');
    const excerpt = (await textAllowed(user.id)) ? String(body.excerpt || '').slice(0, 300) : '';
    try {
      await supabaseRest('/rest/v1/hm_message_ratings', { method: 'POST', headers: { Prefer: 'return=minimal' }, timeoutMs: 3000,
        body: JSON.stringify({ user_id: user.id, rating, model: String(body.model || '').slice(0, 40) || null, excerpt: excerpt || null }) });
    } catch (e) { /* оценка не критична */ }
    return res.status(200).json({ ok: true });
  }
  return fail(res, 404, 'Неизвестное действие');
}
