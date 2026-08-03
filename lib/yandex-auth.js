/* ============================================================================
   HarmonyAI — авторизация в Яндекс.Музыке (только сервер).

   Стратегия «просто для пользователя, сложно для нас»:

     1. OAuth Device Flow — основной путь.
        Пользователь видит код вроде ABCD-1234 и кнопку «Открыть».
        Браузер опрашивает статус, мы получаем токен. Два клика — и всё.

     2. Токен шифруется AES-256-GCM и кладётся в Supabase.
        В базе лежит шифротекст; без MUSIC_ENCRYPTION_KEY он бесполезен.

     3. Общий YANDEX_MUSIC_TOKEN — fallback для тех, кто не подключил свой
        аккаунт. Музыка работает сразу, без экрана входа.

   Кэш расшифрованных токенов в памяти на 5 минут — чтобы каждый запрос
   не ходил в Supabase. Это прямо влияет на скорость ответа.
   ========================================================================== */

import crypto from 'node:crypto';
import { cacheGet, cacheSet, cacheDelete } from './music-cache.js';
import { getAccountStatus, sharedToken, readEnv, isPlaceholder, YandexError } from './yandex.js';

const OAUTH = 'https://oauth.yandex.ru';

// Публичная пара приложения Яндекс.Музыки (та же, что использует MarshalX).
// Переопределяется через env, если заведёте своё приложение в Yandex OAuth.
const CLIENT_ID = readEnv('YANDEX_OAUTH_CLIENT_ID') || '23cabbbdc6cd418abb4b39c32c41195d';
const CLIENT_SECRET = readEnv('YANDEX_OAUTH_CLIENT_SECRET') || '53bc75238f0c4d08a118e51fe9203300';

const TOKEN_CACHE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------- шифрование */

function encryptionKey() {
  const raw = readEnv('MUSIC_ENCRYPTION_KEY');
  if (isPlaceholder(raw)) return null;
  // Любая строка → стабильные 32 байта.
  return crypto.createHash('sha256').update(raw).digest();
}

export function canStoreUserTokens() {
  return Boolean(encryptionKey() && readEnv('SUPABASE_URL') && readEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

function encryptToken(plain) {
  const key = encryptionKey();
  if (!key) throw new YandexError('MUSIC_ENCRYPTION_KEY не настроен', 500, 'no_key');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Формат: v1.<iv>.<tag>.<ciphertext>, всё в base64url
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

function decryptToken(packed) {
  const key = encryptionKey();
  if (!key) return '';
  const parts = String(packed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

/* ---------------------------------------------------------------- Supabase */

async function supabaseRequest(path, options = {}) {
  const baseUrl = readEnv('SUPABASE_URL');
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceKey) return null;

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(() => null);
}

/* ------------------------------------------------------- токены пользователей */

async function loadUserTokenRow(userId) {
  if (!userId) return null;
  const rows = await supabaseRequest(
    `/rest/v1/music_accounts?user_id=eq.${encodeURIComponent(userId)}&select=user_id,token_enc,yandex_uid,yandex_login,has_plus,updated_at&limit=1`
  );
  return rows?.[0] || null;
}

async function saveUserToken(userId, token, status) {
  const payload = {
    user_id: userId,
    token_enc: encryptToken(token),
    yandex_uid: status?.uid || null,
    yandex_login: status?.login || null,
    has_plus: Boolean(status?.hasPlus),
    updated_at: new Date().toISOString(),
  };
  await supabaseRequest('/rest/v1/music_accounts?on_conflict=user_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(payload),
  });
  cacheDelete(`ymtoken:${userId}`);
}

export async function disconnectUser(userId) {
  if (!userId) return { ok: false };
  await supabaseRequest(`/rest/v1/music_accounts?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  cacheDelete(`ymtoken:${userId}`);
  return { ok: true };
}

/**
 * Главная функция: каким токеном работать для этого пользователя.
 * Сначала личный, потом общий.
 *
 * @returns {{ token:string, source:'user'|'shared'|'none', uid:string|null, hasPlus:boolean }}
 */
export async function resolveToken(userId) {
  if (userId) {
    const cacheKey = `ymtoken:${userId}`;
    const hit = cacheGet(cacheKey);
    if (hit.hit) return hit.value;

    try {
      const row = await loadUserTokenRow(userId);
      if (row?.token_enc) {
        const token = decryptToken(row.token_enc);
        if (token) {
          const resolved = {
            token,
            source: 'user',
            uid: row.yandex_uid || null,
            hasPlus: Boolean(row.has_plus),
          };
          cacheSet(cacheKey, resolved, TOKEN_CACHE_MS);
          return resolved;
        }
      }
    } catch (e) {
      // База недоступна — молча уходим на общий токен, музыку не ломаем.
    }
  }

  const shared = sharedToken();
  if (shared) return { token: shared, source: 'shared', uid: null, hasPlus: true };
  return { token: '', source: 'none', uid: null, hasPlus: false };
}

/** Статус подключения для UI. Токен наружу НЕ отдаётся. */
export async function connectionStatus(userId) {
  const resolved = await resolveToken(userId);
  return {
    connected: resolved.source === 'user',
    fallback: resolved.source === 'shared',
    available: resolved.source !== 'none',
    canConnect: canStoreUserTokens(),
    uid: resolved.uid,
    hasPlus: resolved.hasPlus,
  };
}

/* ----------------------------------------------------------- Device Flow */

/**
 * Шаг 1. Запросить код устройства.
 * Возвращает короткий код для пользователя и URL, куда его ввести.
 */
export async function requestDeviceCode() {
  const deviceId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  const res = await fetch(`${OAUTH}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_id: deviceId,
      device_name: 'HarmonyAI',
      scope: 'music:content music:read music:write',
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new YandexError(
      data.error_description || data.error || 'Не удалось получить код авторизации',
      res.status || 502,
      'device_code_failed'
    );
  }

  return {
    deviceCode: data.device_code,      // секретный, хранится только в сессии обмена
    userCode: data.user_code,          // то, что видит человек
    verificationUrl: data.verification_url || 'https://ya.ru/device',
    interval: Number(data.interval || 5),
    expiresIn: Number(data.expires_in || 300),
  };
}

/**
 * Шаг 2. Одна попытка обменять device_code на токен.
 *
 * Важно: опрос делает БРАУЗЕР (короткие запросы раз в 5 с), а не сервер
 * в цикле — иначе функция висела бы минутами и упёрлась в таймаут Vercel.
 *
 * @returns {{ status:'pending'|'ok'|'denied'|'expired' }}
 */
export async function pollDeviceToken(deviceCode, userId) {
  if (!deviceCode) throw new YandexError('Нет device_code', 400, 'bad_request');

  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'device_code',
      code: deviceCode,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (res.ok && data.access_token) {
    return await finalizeToken(data.access_token, userId);
  }

  const err = String(data.error || '');
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending', slowDown: true };
  if (err === 'access_denied') return { status: 'denied' };
  if (err === 'expired_token' || err === 'invalid_grant') return { status: 'expired' };

  return { status: 'pending' };
}

/**
 * Ручной путь: пользователь вставил токен сам.
 * Нужен для случаев, когда Device Flow недоступен.
 */
export async function connectWithToken(token, userId) {
  const t = String(token || '').trim();
  if (t.length < 20) throw new YandexError('Токен выглядит некорректным', 400, 'bad_token');
  return await finalizeToken(t, userId);
}

/** Проверяем токен у Яндекса и сохраняем. */
async function finalizeToken(token, userId) {
  let status = null;
  try {
    status = await getAccountStatus(token);
  } catch (e) {
    throw new YandexError('Токен получен, но Яндекс.Музыка его не приняла', 401, 'auth');
  }

  if (userId && canStoreUserTokens()) {
    try {
      await saveUserToken(userId, token, status);
    } catch (e) {
      // Не смогли сохранить — сообщаем честно, но не теряем сессию.
      return {
        status: 'ok',
        persisted: false,
        login: status.login,
        hasPlus: status.hasPlus,
        warning: 'Не удалось сохранить подключение — проверьте таблицу music_accounts',
      };
    }
  }

  return {
    status: 'ok',
    persisted: Boolean(userId && canStoreUserTokens()),
    login: status.login,
    displayName: status.displayName,
    hasPlus: status.hasPlus,
  };
}
