/* ============================================================================
   ГЕНЕРАЦИЯ ВИДЕО ПО ОПИСАНИЮ — Pollinations (gen.pollinations.ai).

   Бесплатных видео-API без карты и с ≥10 роликами в день на ноябрь 2026 нет
   (у Pollinations все видеомодели paid_only). Поэтому берём самые дешёвые:
     Free — alibaba/wan-2.2-fast, 480p, 5 с  (≈ $0.05 за ролик);
     Pro  — prunaai/p-video,      720p, 5 с  (≈ $0.10 за ролик).
   Переменные Vercel:
     POLLINATIONS_API_KEY — секретный ключ sk_… (enter.pollinations.ai), с балансом Pollen;
     VIDEO_GEN_MODEL_FREE / VIDEO_GEN_MODEL_PRO — сменить модель без кода.

   Ролик делается 30–120 с — дольше, чем живёт функция Vercel. Поэтому задача
   ставится в очередь Pollinations (Prefer: respond-async), клиент опрашивает
   нас раз в 5 с, а мы — Pollinations. Готовое видео копируем в Supabase
   Storage (generated-images/videos/…): адрес Pollinations в чат не попадает.
   Номер задачи клиенту отдаём подписанным — чужую задачу не прочитать.

   Лимиты меньше, чем у картинок (usage_events, model = 'video_gen'):
     Free — 1 в день, 3 в неделю, 5 в месяц;  Pro — 5 / 15 / 40.
   ============================================================================ */
import crypto from 'node:crypto';
import { supabaseRest } from './auth.js';

const API = 'https://gen.pollinations.ai';
export const VIDEO_GEN_LIMITS = {
  free: { day: 1, week: 3, month: 5 },
  pro: { day: 5, week: 15, month: 40 }
};

function readEnv(name) { return String(process.env[name] || '').trim(); }
function key() { return readEnv('POLLINATIONS_API_KEY'); }
export function videoGenConfigured() { return Boolean(key()); }

function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })]).finally(() => clearTimeout(t));
}

export function modelsFor(pro) {
  const env = readEnv(pro ? 'VIDEO_GEN_MODEL_PRO' : 'VIDEO_GEN_MODEL_FREE');
  if (env) return env.split(',').map((x) => x.trim()).filter(Boolean);
  return pro ? ['prunaai/p-video', 'alibaba/wan-2.2-fast'] : ['alibaba/wan-2.2-fast', 'bytedance/seedance-1-pro-fast'];
}
function resolutionFor(model, pro) {
  if (/wan-2\.2/.test(model)) return '480p';
  if (/seedance-1-pro/.test(model)) return pro ? '720p' : '480p';
  return pro ? '720p' : '';
}

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

/* ------------------------------------------------------------ Pollinations */
function auth() { return { Authorization: `Bearer ${key()}` }; }

/* Поставить ролик в очередь. → {status:'pending', job} | {status:'done', bytes} */
export async function startVideoJob(prompt, { pro = false, aspect = '16:9' } = {}) {
  let last = null;
  for (const model of modelsFor(pro)) {
    const p = new URLSearchParams({ model, duration: '5', aspectRatio: aspect === '9:16' ? '9:16' : '16:9' });
    const res = resolutionFor(model, pro);
    if (res) p.set('resolution', res);
    try {
      const r = await withTimeout(fetch(`${API}/video/${encodeURIComponent(prompt)}?${p}`, { headers: { ...auth(), Prefer: 'respond-async' } }), 25000, 'pollinations timeout');
      if (r.status === 202) {
        const d = await r.json().catch(() => ({}));
        if (d.id) return { status: 'pending', job: d.id, model };
      }
      if (r.ok && /video\//.test(r.headers.get('content-type') || '')) {
        return { status: 'done', bytes: Buffer.from(await r.arrayBuffer()), model };
      }
      const t = await r.text().catch(() => '');
      last = { status: r.status, message: t.slice(0, 300), model };
      // Кончился баланс или неверный ключ — другая модель не поможет.
      if (r.status === 401 || r.status === 402 || r.status === 403) break;
    } catch (e) { last = { status: 0, message: e.message, model }; }
  }
  const err = new Error(last ? `pollinations ${last.status}: ${last.message}` : 'pollinations failed');
  err.status = last && last.status;
  throw err;
}

/* Состояние задачи. → {status:'pending'|'failed'|'done', bytes?} */
export async function pollVideoJob(jobId) {
  const r = await withTimeout(fetch(`${API}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: auth() }), 10000, 'job timeout');
  if (r.status === 404) return { status: 'failed', message: 'job not found' };
  const d = await r.json().catch(() => ({}));
  const st = String(d.status || '').toLowerCase();
  if (st === 'failed' || st === 'error') return { status: 'failed', message: String(d.error?.message || d.error || '').slice(0, 300) };
  if (st !== 'succeeded' && st !== 'completed') return { status: 'pending' };
  const v = await withTimeout(fetch(`${API}/v1/jobs/${encodeURIComponent(jobId)}/result`, { headers: auth() }), 40000, 'result timeout');
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
  if (s === 400) return 'Сервис не принял это описание. Попробуйте описать сцену по-другому.';
  return 'Не получилось создать видео. Попробуйте ещё раз чуть позже.';
}
