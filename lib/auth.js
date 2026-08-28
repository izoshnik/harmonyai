/* ============================================================================
   ПРОВЕРКА СЕССИИ SUPABASE НА СЕРВЕРЕ.

   ЗАЧЕМ ЭТО ПОЯВИЛОСЬ.
   Раньше серверные функции брали user_id прямо из тела запроса
   (`req.body.userId`). Для чата это было терпимо, но для денег и API-ключей —
   нет: любой мог отправить чужой id и получить чужой баланс или ключ.
   Теперь личность пользователя определяется ТОЛЬКО из подписанного
   access-токена Supabase, который клиент присылает в заголовке
   `Authorization: Bearer <access_token>`.

   ПОЧЕМУ ЗАПРОС К SUPABASE, А НЕ ЛОКАЛЬНАЯ ПРОВЕРКА ПОДПИСИ.
   Локально проверять HS256-подпись можно только имея JWT-секрет проекта,
   которого в окружении нет (есть service-role ключ — это другое). Поэтому
   валидируем токен там, где он был выдан: GET /auth/v1/user. Supabase сам
   проверит подпись, срок жизни и то, что пользователь не удалён/не заблокирован.
   Результат кэшируем в памяти на минуту, чтобы не ходить туда на каждый чанк
   стрима.

   ВАЖНО: здесь НЕТ второй системы авторизации. Мы не выдаём свои токены,
   не храним пароли, не заводим свой /login — только проверяем то, что уже
   выдал Supabase существующему пользователю.
   ============================================================================ */

/* -------- Кэш проверенных токенов -------- */
const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_MAX = 500;
const _tokenCache = new Map(); // token -> { user, at }

function cacheGet(token) {
  const rec = _tokenCache.get(token);
  if (!rec) return null;
  if (Date.now() - rec.at > TOKEN_CACHE_TTL_MS) {
    _tokenCache.delete(token);
    return null;
  }
  return rec.user;
}

function cacheSet(token, user) {
  if (_tokenCache.size >= TOKEN_CACHE_MAX) {
    // Простая уборка: выбрасываем всё просроченное, иначе — самый старый ключ.
    const now = Date.now();
    for (const [k, v] of _tokenCache) {
      if (now - v.at > TOKEN_CACHE_TTL_MS) _tokenCache.delete(k);
    }
    if (_tokenCache.size >= TOKEN_CACHE_MAX) {
      const oldest = _tokenCache.keys().next().value;
      if (oldest) _tokenCache.delete(oldest);
    }
  }
  _tokenCache.set(token, { user, at: Date.now() });
}

/* -------- Утилиты -------- */
function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* Достаём Bearer-токен. Смотрим и Authorization, и x-supabase-authorization:
   второй нужен там, где Authorization уже занят API-ключом sk-h-. */
export function bearerToken(req) {
  const raw = String(
    req.headers?.['x-supabase-authorization'] ||
    req.headers?.authorization ||
    ''
  ).trim();
  if (!raw) return '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = (m ? m[1] : raw).trim();
  // Отсекаем очевидно не-JWT (например, наш собственный ключ API).
  if (!token || token.startsWith('sk-h-')) return '';
  return token;
}

/* ============================================================================
   ГЛАВНАЯ ФУНКЦИЯ: проверить токен и вернуть { id, email } или null.
   null означает «не аутентифицирован» — вызывающий отдаёт 401.
   ============================================================================ */
export async function verifyAccessToken(token) {
  const jwt = String(token || '').trim();
  if (!jwt) return null;

  const cached = cacheGet(jwt);
  if (cached) return cached;

  const baseUrl = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceKey) {
    console.error('[auth] SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не настроены');
    return null;
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        }
      }),
      8000,
      'Supabase auth request timed out'
    );

    if (!response.ok) {
      // 401/403 — обычная ситуация: токен истёк. Не шумим в логах.
      if (response.status !== 401 && response.status !== 403) {
        console.warn('[auth] /auth/v1/user ответил', response.status);
      }
      return null;
    }

    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    const id = String(data?.id || '').trim();
    if (!id) return null;

    const user = {
      id,
      email: String(data?.email || '').trim(),
      createdAt: String(data?.created_at || '') || null
    };
    cacheSet(jwt, user);
    return user;
  } catch (error) {
    console.warn('[auth] ошибка проверки токена:', String(error?.message || error).slice(0, 200));
    return null;
  }
}

/* Удобная обёртка: сразу из запроса. */
export async function authenticateRequest(req) {
  return verifyAccessToken(bearerToken(req));
}

/* ============================================================================
   ЖЁСТКИЙ ВАРИАНТ: либо пользователь, либо готовый 401 в ответе.
   Возвращает объект пользователя или null; при null ответ уже отправлен.
   ============================================================================ */
export async function requireUser(req, res) {
  const user = await authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: { message: 'Требуется вход в аккаунт', code: 'unauthorized' } });
    return null;
  }
  return user;
}

/* ============================================================================
   ОБЩИЙ КЛИЕНТ SUPABASE REST ДЛЯ СЕРВЕРНЫХ МОДУЛЕЙ.
   Тот же контракт, что у supabaseRequest в api/chat.js, но переиспользуемый.
   Ходит под service-role ключом, поэтому КАЖДЫЙ запрос обязан сам фильтровать
   по user_id — RLS в этом режиме не применяется.
   ============================================================================ */
export async function supabaseRest(path, init = {}) {
  const baseUrl = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceKey) throw new Error('Supabase не настроен');

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...(init.headers || {})
  };

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, { ...init, headers }),
    Number(init.timeoutMs) || 8000,
    'Supabase request timed out'
  );

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

  if (!response.ok) {
    const message = data?.message || data?.error_description || data?.error || `Supabase error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.details = data?.details || null;
    err.code = data?.code || null;
    throw err;
  }
  return data;
}

/* Строка-фильтр PostgREST по владельцу. Вынесено отдельно, чтобы нигде
   не забыть про экранирование. */
export function ownerFilter(userId) {
  return `user_id=eq.${encodeURIComponent(String(userId || ''))}`;
}

/* ===== РОЛИ БЕЗ ОГРАНИЧЕНИЙ ПО API =========================================
   Роль лежит в `profiles.role` и читается ТОЛЬКО здесь, на сервере, под
   service-role: клиент её не присылает и подменить не может. Набор ролей тот
   же, что уже действует в чате (`api/chat.js`) и в генерации картинок.

   Для этих ролей публичный API работает без баланса: проверка перед запросом
   не выполняется, списание идёт нулевой стоимостью. Журнал расхода при этом
   пишется полностью — статистика по токенам остаётся честной.
   ========================================================================= */
export const UNLIMITED_API_ROLES = ['developer', 'admin', 'moderator'];

export function isUnlimitedApiRole(role) {
  return UNLIMITED_API_ROLES.includes(String(role || '').trim().toLowerCase());
}

/* Роль пользователя или пустая строка. Ошибку базы намеренно превращаем в ''
   (fail-closed): сбой чтения профиля не должен раздавать бесплатный API. */
export async function readProfileRole(userId) {
  if (!userId) return '';
  try {
    const rows = await supabaseRest(
      `/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(String(userId))}&limit=1`,
      { method: 'GET' }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return String(row?.role || '').trim().toLowerCase();
  } catch (error) {
    console.error('[auth] не удалось прочитать роль:', String(error?.message || error).slice(0, 200));
    return '';
  }
}
