/* ============================================================================
   ГЕНЕРАЦИЯ ВИДЕО ПО ОПИСАНИЮ — CloseRouter (api.closerouter.dev), тот же
   CLOSEROUTER_API_KEY, что у картинок Pro.

   Модель — bytedance/seedance-1.5-pro: самая дешёвая из сильных (≈ $0.02/с,
   5-секундный ролик 480p ≈ $0.10). Pro — 720p. Сменить без кода:
     VIDEO_GEN_MODEL — id модели CloseRouter;
     VIDEO_GEN_RES_FREE / VIDEO_GEN_RES_PRO — разрешение (480p / 720p).

   API асинхронный: POST /v1/videos/quote (цена, ничего не списывает) →
   POST /v1/videos с max_cost_usd из расчёта → 202 {id} → GET /v1/videos/{id}
   до status=completed → GET /v1/videos/{id}/content?index=0 (с ключом).
   Повторный POST — новая платная генерация, поэтому при сбое не повторяем.

   Ролик делается 30–120 с — дольше, чем живёт функция Vercel: клиент
   опрашивает нас раз в 5 с по подписанному номеру задачи, мы — CloseRouter.
   Готовое видео копируем в Supabase Storage (generated-images/videos/…).

   Лимиты меньше, чем у картинок (usage_events, model = 'video_gen'):
     Free — 1 в день, 3 в неделю, 5 в месяц;  Pro — 5 / 15 / 40.
   ============================================================================ */
import crypto from 'node:crypto';
import { supabaseRest } from './auth.js';

export const VIDEO_GEN_LIMITS = {
  free: { day: 1, week: 3, month: 5 },
  pro: { day: 5, week: 15, month: 40 }
};

function readEnv(name) { return String(process.env[name] || '').trim(); }
function key() { return readEnv('CLOSEROUTER_API_KEY'); }
function base() { return (readEnv('CLOSEROUTER_BASE_URL') || 'https://api.closerouter.dev/v1').replace(/\/+$/, ''); }
export function videoGenConfigured() { return Boolean(key()); }

function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })]).finally(() => clearTimeout(t));
}

/* Основная — Seedance 1.5 Pro; запасные — следующие по цене хорошие модели
   CloseRouter (≈ $0.11–0.21 за 5 с). Модель у провайдера бывает «temporarily
   unavailable» (502) — тогда берём следующую. VIDEO_GEN_MODEL — свой список через запятую. */
const VIDEO_MODELS = ['bytedance/seedance-1.5-pro', 'bytedance/v1-lite', 'x-ai/grok-imagine-video', 'bytedance/seedance-2-mini'];
export function videoModels() {
  const env = readEnv('VIDEO_GEN_MODEL');
  return env ? env.split(',').map((x) => x.trim()).filter(Boolean) : VIDEO_MODELS;
}
export function videoModel() { return videoModels()[0]; }
function resolutionFor(pro) { return readEnv(pro ? 'VIDEO_GEN_RES_PRO' : 'VIDEO_GEN_RES_FREE') || (pro ? '720p' : '480p'); }

/* ------------------------------------------------------------ подпись задачи */
function secret() { return readEnv('VIDEO_GEN_SECRET') || readEnv('SUPABASE_SERVICE_ROLE_KEY') || 'hm-video'; }
export function signJob(jobId, userId) {
  const body = Buffer.from(JSON.stringify({ j: jobId, u: userId || '' })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  return body + '.' + mac;
}
export function readJob(token, userId) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if ((d.u || '') !== (userId || '')) return null;
    return String(d.j || '') || null;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------ лимиты */
function startOf(kind) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (kind === 'week') { const day = d.getDay() || 7; d.setDate(d.getDate() - (day - 1)); }
  if (kind === 'month') d.setDate(1);
  return d;
}
function resetAt(kind) {
  const d = startOf(kind);
  if (kind === 'day') d.setDate(d.getDate() + 1);
  if (kind === 'week') d.setDate(d.getDate() + 7);
  if (kind === 'month') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}
async function countSince(userId, since) {
  const rows = await supabaseRest(`/rest/v1/usage_events?select=messages&user_id=eq.${encodeURIComponent(userId)}&model=eq.video_gen&created_at=gte.${encodeURIComponent(since.toISOString())}&limit=1000`, { method: 'GET' });
  return (rows || []).reduce((s, r) => s + (r.messages || 0), 0);
}
export async function checkVideoGenAllowance(userId, { pro = false, staff = false } = {}) {
  if (staff) return { ok: true };
  if (!userId) return { ok: false, scope: 'auth', message: 'Войдите в аккаунт, чтобы создавать видео.' };
  const cfg = pro ? VIDEO_GEN_LIMITS.pro : VIDEO_GEN_LIMITS.free;
  const upgrade = pro ? '' : ' Больше видео — в Pro.';
  try {
    const [day, week, month] = await Promise.all(['day', 'week', 'month'].map((k) => countSince(userId, startOf(k))));
    if (day >= cfg.day) return { ok: false, scope: 'day', resetAt: resetAt('day'), plan: pro ? 'pro' : 'free', message: `Дневной лимит видео исчерпан — обновится завтра.${upgrade}` };
    if (week >= cfg.week) return { ok: false, scope: 'week', resetAt: resetAt('week'), plan: pro ? 'pro' : 'free', message: `Недельный лимит видео исчерпан — обновится в понедельник.${upgrade}` };
    if (month >= cfg.month) return { ok: false, scope: 'month', resetAt: resetAt('month'), plan: pro ? 'pro' : 'free', message: `Месячный лимит видео исчерпан — обновится 1-го числа.${upgrade}` };
    return { ok: true, left: cfg.day - day };
  } catch (e) {
    console.warn('[video-gen] allowance check failed (allowing):', String(e.message).slice(0, 160));
    return { ok: true };
  }
}
export async function recordVideoGen(userId) {
  if (!userId) return;
  try {
    await supabaseRest('/rest/v1/usage_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, model: 'video_gen', tokens: 1, messages: 1, created_at: new Date().toISOString() }]) });
  } catch (e) { console.warn('[video-gen] usage insert failed:', String(e.message).slice(0, 160)); }
}

/* ------------------------------------------------------------ CloseRouter */
function headers() { return { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }; }
function crError(status, data, fallback) {
  const e = new Error(`closerouter ${status}: ${String(data?.error?.message || data?.message || fallback || '').slice(0, 300)}`);
  e.status = status;
  return e;
}

async function quote(body) {
  const q = await withTimeout(fetch(`${base()}/videos/quote`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }), 15000, 'quote timeout');
  const qd = await q.json().catch(() => ({}));
  if (!q.ok) throw crError(q.status, qd, 'quote failed');
  const maxCost = qd.max_cost_usd ?? qd.quote?.max_cost_usd;
  if (maxCost == null) throw crError(500, qd, 'no max_cost_usd in quote');
  return { maxCost, option: qd.provider?.option_id || qd.option_id || '' };
}
function bodyFor(model, prompt, pro, aspect) {
  return { model, prompt, duration: 5, aspect_ratio: aspect === '9:16' ? '9:16' : '16:9', resolution: resolutionFor(pro) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Поставить ролик в очередь. → {status:'pending', job, cost, model}
   Перебор моделей: расчёт цены бесплатный, поэтому при его сбое смело идём
   дальше. Создание задачи повторяем на другой модели только при явном
   отказе без задачи (502/503 без id и без reconciliation_pending) — иначе
   можно оплатить две генерации. */
export async function startVideoJob(prompt, { pro = false, aspect = '16:9' } = {}) {
  const cap = Number(readEnv('VIDEO_GEN_MAX_USD')) || 0.4;
  let last = null;
  for (const model of videoModels()) {
    const body = bodyFor(model, prompt, pro, aspect);
    let qt = null;
    for (let attempt = 0; attempt < 2 && !qt; attempt++) {
      try { qt = await quote(body); }
      catch (e) {
        last = e;
        if (e.status === 401 || e.status === 403) throw e; // ключ — другие модели не помогут
        if (attempt === 0 && (e.status === 502 || e.status === 503 || e.status === 429)) await sleep(1500);
        else break;
      }
    }
    if (!qt) continue;
    if (Number(qt.maxCost) > cap) { last = crError(402, { message: `${model}: quote ${qt.maxCost} > cap ${cap}` }); continue; }
    const r = await withTimeout(fetch(`${base()}/videos`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ ...body, max_cost_usd: String(qt.maxCost), ...(qt.option ? { provider: { option_id: qt.option } } : {}) })
    }), 25000, 'create timeout');
    const d = await r.json().catch(() => ({}));
    if (d.id) return { status: 'pending', job: d.id, cost: qt.maxCost, model };
    last = crError(r.status, d, 'create failed');
    const unknown = JSON.stringify(d).includes('reconciliation_pending');
    if (unknown || !(r.status === 502 || r.status === 503 || r.status === 400 || r.status === 422)) throw last;
    console.warn('[video-gen]', model, 'create refused:', last.message.slice(0, 200));
  }
  throw last || crError(500, {}, 'no video model available');
}

/* Для персонала: какие модели сейчас отвечают на расчёт цены (бесплатно). */
export async function probeVideoModels(pro = false) {
  return Promise.all(videoModels().map(async (model) => {
    const t0 = Date.now();
    try { const q = await quote(bodyFor(model, 'A cup of coffee on a wooden table, soft morning light', pro, '16:9')); return { model, ok: true, cost: q.maxCost, ms: Date.now() - t0 }; }
    catch (e) { return { model, ok: false, error: e.message.slice(0, 200), ms: Date.now() - t0 }; }
  }));
}

/* Состояние задачи. → {status:'pending'|'failed'|'done', bytes?} */
export async function pollVideoJob(jobId) {
  const r = await withTimeout(fetch(`${base()}/videos/${encodeURIComponent(jobId)}`, { headers: headers() }), 10000, 'status timeout');
  if (r.status === 404) return { status: 'failed', message: 'task not found' };
  const d = await r.json().catch(() => ({}));
  const st = String(d.status || '').toLowerCase();
  if (st === 'failed' || st === 'cancelled' || st === 'canceled') return { status: 'failed', message: String(d.error?.message || d.error || '').slice(0, 300) };
  if (st !== 'completed') return { status: 'pending' };
  const url = (Array.isArray(d.unsigned_urls) && d.unsigned_urls[0]) || `${base()}/videos/${encodeURIComponent(jobId)}/content?index=0`;
  const v = await withTimeout(fetch(url, { headers: { Authorization: `Bearer ${key()}` } }), 40000, 'content timeout');
  if (!v.ok) return { status: 'pending' };
  return { status: 'done', bytes: Buffer.from(await v.arrayBuffer()) };
}

/* ------------------------------------------------------------ хранилище */
function storagePath(userId, jobId) {
  const seg = String(userId || 'guest').replace(/[^a-zA-Z0-9_-]/g, '') || 'guest';
  const id = String(jobId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return `videos/${seg}/${id}.mp4`;
}
export async function storeVideo(bytes, userId, jobId) {
  const base = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const sk = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !sk) throw new Error('Supabase not configured');
  const path = storagePath(userId, jobId);
  const r = await withTimeout(fetch(`${base}/storage/v1/object/generated-images/${path}`, {
    method: 'POST',
    headers: { apikey: sk, Authorization: `Bearer ${sk}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: bytes
  }), 30000, 'storage timeout');
  if (!r.ok) throw new Error('storage ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  return `${base}/storage/v1/object/public/generated-images/${path}`;
}

export function videoGenErrorText(e) {
  const s = Number(e && e.status) || 0;
  if (s === 402) return 'Генерация видео временно недоступна: закончился баланс сервиса. Мы уже знаем об этом.';
  if (s === 401 || s === 403) return 'Генерация видео не настроена на сервере.';
  if (s === 429) return 'Сервис видео сейчас перегружен. Попробуйте через минуту.';
  if (s === 400) return 'Сервис не принял это описание. Попробуйте описать сцену по-другому.';
  return 'Не получилось создать видео. Попробуйте ещё раз чуть позже.';
}
