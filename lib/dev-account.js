/* ============================================================================
   АККАУНТ РАЗРАБОТЧИКА devharmonyai0802@dev.dev — вход без письма с кодом.

   Почта на домене dev.dev не принимает письма, поэтому обычный вход по OTP
   невозможен. Вместо кода используется СЕКРЕТНЫЙ КЛЮЧ из переменной окружения
   Vercel DEV_LOGIN_KEY:
     • ключа в окружении нет → вход выключен полностью (ответ 404);
     • ключ неверный → 403, и не больше 5 попыток за 10 минут с одного IP.
   Без ключа это был бы публичный вход в аккаунт администратора: адрес почты
   виден в коде app.html любому посетителю.

   Сессия — НАСТОЯЩАЯ сессия Supabase (access_token + refresh_token): сервер
   через Admin API создаёт пользователя (email_confirm: true), выпускает
   одноразовую magic-ссылку и сам же её подтверждает. Своих токенов и второй
   системы авторизации здесь нет.

   Права выдаются на сервере:
     • profiles: role = admin (developer сохраняется), plan = pro, без срока;
     • app_metadata.hm_dev_account = true — пользователь сам изменить это поле
       не может, поэтому по нему сервер узнаёт аккаунт, а не по одной почте
       (почту при отключённом подтверждении можно было бы зарегистрировать
       чужим паролем раньше нас).
   ============================================================================ */
import crypto from 'node:crypto';

export const DEV_ACCOUNT_EMAIL = 'devharmonyai0802@dev.dev';

function readEnv(name) { return String(process.env[name] || '').trim(); }

/* Пользователь из verifyAccessToken (lib/auth.js) — аккаунт разработчика? */
export function isDevAccountUser(user) {
  return Boolean(user && String(user.email || '').toLowerCase() === DEV_ACCOUNT_EMAIL && user.devAccount === true);
}

/* Профиль с гарантированными Pro и admin для аккаунта разработчика. */
export function applyDevAccountProfile(profile, user) {
  if (!isDevAccountUser(user)) return profile;
  const role = String(profile?.role || '').toLowerCase();
  return {
    ...(profile || { id: user.id, nickname: 'Developer', settings: {} }),
    role: role === 'developer' || role === 'admin' ? role : 'admin',
    plan: 'pro',
    plan_expires_at: null
  };
}
applyDevAccountProfile.isDev = isDevAccountUser;

/* ---------- защита от перебора ---------- */
const attempts = new Map(); // ip → [timestamps]
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 5;
}
function noteFailure(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}
function keyMatches(given) {
  const expected = readEnv('DEV_LOGIN_KEY');
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function clientIp(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '');
  return (xff.split(',')[0] || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '').trim();
}

/* ---------- Supabase Admin API ---------- */
async function gotrue(path, { method = 'GET', body } = {}) {
  const base = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${base}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data, text };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const base = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${base}/rest/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data, text };
}

/* Профиль: admin (developer сохраняется) + Pro без срока. Столбцы — только
   существующие в profiles (id, role, plan, plan_expires_at). */
async function ensureProfile(userId) {
  const cur = await rest(`/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role&limit=1`);
  const row = Array.isArray(cur.data) ? cur.data[0] : null;
  const role = String(row?.role || '').toLowerCase();
  const patch = { role: role === 'developer' || role === 'admin' ? role : 'admin', plan: 'pro', plan_expires_at: null };
  if (row) {
    const r = await rest(`/profiles?id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    if (!r.ok) console.warn('[dev-account] profile patch failed', r.status, r.text.slice(0, 200));
    return;
  }
  const r = await rest('/profiles', { method: 'POST', body: { id: userId, nickname: 'Developer', ...patch }, prefer: 'return=minimal' });
  if (!r.ok) console.warn('[dev-account] profile insert failed', r.status, r.text.slice(0, 200));
}

export async function handleDevInstantLogin(req, res, body) {
  if (!readEnv('DEV_LOGIN_KEY')) return res.status(404).json({ error: { message: 'Не найдено' } });
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Метод не поддерживается' } });
  const email = String(body?.email || '').trim().toLowerCase();
  if (email !== DEV_ACCOUNT_EMAIL) return res.status(404).json({ error: { message: 'Не найдено' } });

  const ip = clientIp(req) || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ error: { message: 'Слишком много попыток. Подождите 10 минут.' } });
  if (!keyMatches(body?.key)) {
    noteFailure(ip);
    return res.status(403).json({ error: { message: 'Неверный ключ разработчика' } });
  }

  // 1. Пользователь: создаём с подтверждённой почтой (если уже есть — 422, это нормально).
  const created = await gotrue('/admin/users', {
    method: 'POST',
    body: { email: DEV_ACCOUNT_EMAIL, email_confirm: true, app_metadata: { hm_dev_account: true }, user_metadata: { nickname: 'Developer' } }
  });
  if (!created.ok && created.status !== 422 && created.status !== 400) {
    console.error('[dev-account] create user failed', created.status, created.text.slice(0, 300));
    return res.status(502).json({ error: { message: 'Supabase Admin API недоступен' } });
  }

  // 2. Одноразовая magic-ссылка (заодно возвращает id пользователя).
  const link = await gotrue('/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: DEV_ACCOUNT_EMAIL } });
  const hashed = link.data?.hashed_token || link.data?.properties?.hashed_token;
  const userId = link.data?.id || link.data?.user?.id || created.data?.id;
  if (!link.ok || !hashed || !userId) {
    console.error('[dev-account] generate_link failed', link.status, link.text.slice(0, 300));
    return res.status(502).json({ error: { message: 'Не удалось выпустить сессию' } });
  }

  // 3. Метка аккаунта в app_metadata (пользователь её изменить не может) + права в profiles.
  await gotrue(`/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: { email_confirm: true, app_metadata: { hm_dev_account: true } } });
  await ensureProfile(userId);

  /* 4. Сессия. Supabase в разных версиях по-разному принимает magic-ссылку,
        поэтому пробуем по очереди:
        a) token_hash (type magiclink, затем email);
        b) одноразовый код email_otp из той же ссылки;
        c) пароль: сервер ставит аккаунту пароль HMAC(DEV_LOGIN_KEY, id) через
           Admin API и входит обычным password grant. Пароль нигде не хранится
           и без DEV_LOGIN_KEY не вычисляется. */
  const tries = [];
  const done = (r) => r && r.ok && r.data?.access_token;
  let session = await gotrue('/verify', { method: 'POST', body: { type: 'magiclink', token_hash: hashed } });
  tries.push(session);
  if (!done(session)) { session = await gotrue('/verify', { method: 'POST', body: { type: 'email', token_hash: hashed } }); tries.push(session); }
  const otp = link.data?.email_otp || link.data?.properties?.email_otp;
  if (!done(session) && otp) {
    // Ссылка уже могла сгореть на попытке (a) — выпускаем новую.
    const link2 = await gotrue('/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: DEV_ACCOUNT_EMAIL } });
    const otp2 = link2.data?.email_otp || link2.data?.properties?.email_otp || otp;
    session = await gotrue('/verify', { method: 'POST', body: { type: 'email', email: DEV_ACCOUNT_EMAIL, token: otp2 } });
    tries.push(session);
  }
  if (!done(session)) {
    const password = crypto.createHmac('sha256', readEnv('DEV_LOGIN_KEY')).update('hm-dev:' + userId).digest('base64url');
    const setPw = await gotrue(`/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: { password, email_confirm: true } });
    tries.push(setPw);
    if (setPw.ok) {
      session = await gotrue('/token?grant_type=password', { method: 'POST', body: { email: DEV_ACCOUNT_EMAIL, password } });
      tries.push(session);
    }
  }
  if (!done(session)) {
    const why = tries.map((t) => `${t.status}:${String(t.data?.msg || t.data?.error_description || t.data?.message || t.data?.error || t.text || '').slice(0, 80)}`).join(' | ');
    console.error('[dev-account] session failed', why);
    return res.status(502).json({ error: { message: `Не удалось подтвердить сессию (${why})` } });
  }
  attempts.delete(ip);
  return res.status(200).json({
    ok: true,
    access_token: session.data.access_token,
    refresh_token: session.data.refresh_token,
    expires_in: session.data.expires_in,
    user: { id: userId, email: DEV_ACCOUNT_EMAIL }
  });
}
