/* ============================================================================
   НАБЛЮДЕНИЕ ЗА СЕРВИСОМ: журнал запросов, ошибки с кодами, себестоимость.

   • logRequest(row)  — одна строка в hm_request_log на каждый запрос к модели
     (чат, API, картинки, видео…). Из неё панель /management считает токены,
     задержки, запасные модели и деньги.
   • reportError(ctx) — пишет ошибку в hm_error_log и возвращает уникальный
     код (16 символов: буквы и цифры). Пользователь видит только
     «Ошибка сервиса № <код>», техническая причина остаётся в панели.
   • estimateCostUsd  — оценка себестоимости по тарифам провайдеров.

   Учёт никогда не ломает ответ: любые сбои записи глотаются, запись идёт
   с коротким таймаутом. Если миграция supabase/2026-11-02-admin.sql ещё не
   выполнена (таблицы нет), попытки записи замирают на 10 минут.
   ============================================================================ */
import { randomBytes } from 'node:crypto';
import { supabaseRest } from './auth.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/* Код ошибки: 16 символов без похожих (0/O, 1/l/I) — его диктуют в поддержку. */
export function newErrorCode(len = 16) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const ERROR_CODE_RE = /Ошибка сервиса № ([A-Za-z0-9]{8,24})/;
export function serviceErrorText(code) {
  return `Ошибка сервиса № ${code}`;
}

/* ---------------------------------------------------------------- тарифы
   USD за 1 млн токенов [вход, выход] — оценка по открытым ценам OpenRouter
   на ноябрь 2026 (pro-ai.online своих цен не публикует). Точные цифры можно
   задать переменной HM_COST_PRICES: {"glm-5.3-flash":[0.03,0.09],"image:gpt-image-2":0.04}.
   Поштучные услуги (картинка, видео) — ключ «тип:модель», цена за штуку. */
const DEFAULT_PRICES = {
  'glm-5.3-flash': [0.0285, 0.0923],
  'z-ai/glm-5.3-flash': [0.0285, 0.0923],
  'deepseek-v4-flash': [0.091, 0.182],
  'deepseek/deepseek-v4-flash': [0.091, 0.182],
  'deepseek-v4-flash-0731': [0.119, 0.238],
  'nvidia/nemotron-3.5-super-vl': [0.15, 0.5],
  'gemini-3.8-flash': [0.825, 4.125],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-2.5-flash': [0.3, 2.5],
  'image:gpt-image-2': 0.04,
  'image:@cf/black-forest-labs/flux-1-schnell': 0,
  // Просмотр видео Gemini: ключ на бесплатном уровне — 0, если платный — задайте цену.
  'video_watch:gemini': 0
};

let priceCache = null;
function prices() {
  if (priceCache) return priceCache;
  let extra = {};
  try { extra = JSON.parse(String(process.env.HM_COST_PRICES || '{}')) || {}; } catch (e) { extra = {}; }
  priceCache = { ...DEFAULT_PRICES, ...extra };
  return priceCache;
}

/* Модели :free у OpenRouter бесплатны; остальное — по таблице. Неизвестная
   модель → 0 (лучше недосчитать, чем выдумать), панель покажет её отдельно. */
export function estimateCostUsd({ upstream = '', inputTokens = 0, outputTokens = 0, unit = '' } = {}) {
  const name = String(upstream || '').trim();
  if (!name || /:free$/i.test(name)) return 0;
  const table = prices();
  if (unit) {
    const p = table[`${unit}:${name}`];
    return typeof p === 'number' ? p : 0;
  }
  const p = table[name] || table[name.replace(/^[^/]+\//, '')];
  if (!Array.isArray(p)) return 0;
  return (Number(inputTokens) || 0) / 1e6 * p[0] + (Number(outputTokens) || 0) / 1e6 * p[1];
}

export function providerOf(model = '') {
  const m = String(model || '');
  if (!m) return null;
  if (/gemini/i.test(m)) return 'gemini';
  if (/^@cf\//.test(m)) return 'cloudflare';
  if (/seedance|grok-imagine|v1-lite/i.test(m)) return 'closerouter';
  if (m.includes('/') || /:free$/i.test(m)) return 'openrouter';
  return 'pro-ai';
}

export const estimateTokens = (chars) => Math.max(0, Math.ceil((Number(chars) || 0) / 4));

/* ---------------------------------------------------------------- запись */
const pausedUntil = { hm_request_log: 0, hm_error_log: 0 };
async function insert(table, row, timeoutMs = 1500) {
  if (Date.now() < (pausedUntil[table] || 0)) return false;
  try {
    await supabaseRest(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(row),
      timeoutMs
    });
    return true;
  } catch (e) {
    // 42P01 / PGRST205 — таблицы нет: миграция не выполнена.
    if (e?.code === '42P01' || e?.code === 'PGRST205' || e?.status === 404) pausedUntil[table] = Date.now() + 10 * 60 * 1000;
    console.warn(`[observe] ${table} insert failed:`, e?.code || e?.status || String(e?.message || e).slice(0, 120));
    return false;
  }
}

const clampInt = (n) => Math.max(0, Math.min(2147483647, Math.round(Number(n) || 0)));

export async function logRequest(row = {}) {
  const upstream = row.upstream || null;
  const inputTokens = clampInt(row.inputTokens);
  const outputTokens = clampInt(row.outputTokens);
  const cost = row.costUsd != null ? Number(row.costUsd) || 0
    : estimateCostUsd({ upstream, inputTokens, outputTokens, unit: row.unit || '' });
  return insert('hm_request_log', {
    user_id: row.userId || null,
    source: String(row.source || 'chat').slice(0, 40),
    plan: row.plan || null,
    model: row.model ? String(row.model).slice(0, 80) : null,
    upstream: upstream ? String(upstream).slice(0, 120) : null,
    provider: row.provider || providerOf(upstream),
    ok: row.ok !== false,
    status: row.status != null ? Number(row.status) || null : null,
    latency_ms: row.latencyMs != null ? clampInt(row.latencyMs) : null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.max(0, Math.round(cost * 1e6) / 1e6),
    charged_micro: clampInt(row.chargedMicro),
    tried: Array.isArray(row.tried) && row.tried.length ? row.tried.slice(0, 12).map((m) => String(m).slice(0, 120)) : null,
    think: row.think == null ? null : Boolean(row.think),
    effort: row.effort ? String(row.effort).slice(0, 20) : null,
    search: row.search == null ? null : Boolean(row.search),
    error_code: row.errorCode || null
  });
}

/* Вид ошибки — для группировки в панели. */
export function classifyError(status, message = '') {
  const m = String(message || '').toLowerCase();
  const s = Number(status) || 0;
  if (/timed? ?out|timeout|слишком долго|deadline|aborted/.test(m) || s === 504) return 'timeout';
  if (/overload|перегруж|high load|нагрузк|503|unavailable|недоступн/.test(m) || s === 503) return 'unavailable';
  if (/quota|limit|rate|429|лимит|квот/.test(m) || s === 429) return 'quota';
  if (/network|fetch failed|econn|socket|сеть|соединени/.test(m)) return 'network';
  if (/policy|safety|moderation|запрещ/.test(m)) return 'policy';
  if (s >= 500 || !s) return 'internal';
  return 'request';
}

/* Записывает ошибку и возвращает код. Ждём запись не дольше 1,5 с: код
   должен существовать в базе к моменту, когда пользователь его пришлёт. */
export async function reportError({ source = 'chat', status = 500, kind = '', message = '', detail = null, userId = null, userText = '', allowText = true, code = '' } = {}) {
  const c = code && /^[A-Za-z0-9]{8,24}$/.test(code) ? code : newErrorCode();
  await insert('hm_error_log', {
    code: c,
    user_id: userId || null,
    source: String(source || 'chat').slice(0, 40),
    status: Number(status) || null,
    kind: kind || classifyError(status, message),
    message: String(message || '').slice(0, 2000),
    detail: detail && typeof detail === 'object' ? detail : null,
    user_text: allowText && userText ? String(userText).slice(0, 200) : null
  });
  return c;
}

/* Можно ли сохранять текст сообщения: только если пользователь не выключил
   «Использовать мои чаты для улучшения сервиса» (profiles.settings.ai_training). */
export function allowsTextLogging(profile) {
  return profile?.settings?.ai_training !== false;
}

/* Заблокирован ли аккаунт (profiles.blocked_at, панель → «Заблокировать»). */
export function isBlockedProfile(profile) {
  return Boolean(profile && profile.blocked_at);
}
export const BLOCKED_MESSAGE = 'Аккаунт заблокирован администрацией. Если это ошибка — напишите в поддержку: harmonyai.ru/contacts';
