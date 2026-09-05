/* ============================================================================
   ПУБЛИЧНЫЙ API-ШЛЮЗ HARMONYAI.

   Адреса (все — через один файл, чтобы не тратить слоты функций Vercel):
     POST /v1/messages               — основной вызов модели, всегда потоком
     POST /v1/messages/count_tokens  — оценка размера запроса в токенах
     GET  /v1/models                 — список доступных моделей

   Формат — Anthropic Messages API: именно его ждут Claude Code, Cline,
   Roo Code, OpenCode и другие клиенты. Перевод в формат апстрима делает
   lib/anthropic-bridge.js.

   ЧТО ГАРАНТИРУЕТ ЭТОТ ФАЙЛ.

   1. АУТЕНТИФИКАЦИЯ ПО КЛЮЧУ. Только `Authorization: Bearer sk-h-...` или
      `x-api-key: sk-h-...`. Ключ ищется по SHA-256 хешу — открытых ключей в
      базе нет. Отозванный ключ не работает.

   2. БАЛАНС ПРОВЕРЯЕТСЯ ДО ОБРАЩЕНИЯ К МОДЕЛИ. Пессимистичная оценка
      стоимости считается по входу и max_tokens; если денег не хватает даже на
      неё, запрос до модели не доходит и возвращается 402.
      Исключение — роли developer / admin / moderator (`lib/auth.js`): для них
      баланс не проверяется и не списывается, журнал расхода пишется нулевой
      стоимостью. Роль берётся из базы, из запроса клиента — никогда.

   3. СПИСАНИЕ — ПО ФАКТУ, ПОСЛЕ ОТВЕТА. Токены берутся из usage апстрима
      (или из серверной оценки, если апстрим их не отдал). Данные клиента о
      расходе не используются нигде и никогда.

   4. НАРУЖУ — ТОЛЬКО ПУБЛИЧНЫЕ ИМЕНА МОДЕЛЕЙ. dynatos / adanatos. Имя модели
      апстрима, его адрес и его ключ не попадают ни в ответ, ни в текст ошибки.

   5. ЭТО НЕ ВТОРАЯ СИСТЕМА АВТОРИЗАЦИИ. Ключи принадлежат пользователям
      Supabase; создаются и отзываются в /api/dashboard через api/account.js.
   ============================================================================ */

import { extractApiKey, looksLikeApiKey, hashApiKey } from '../lib/api-keys.js';
import { supabaseRest, readAccessProfile, hasProAccess, isUnlimitedApiRole } from '../lib/auth.js';
import { resolvePublicModel, PUBLIC_MODEL_IDS, PUBLIC_MODELS } from '../lib/models.js';
import {
  MODEL_PRICING,
  usageCostMicroRubles,
  estimateCostMicroRubles,
  formatMicroRubles
} from '../lib/pricing.js';
import {
  anthropicError,
  anthropicToOpenAI,
  openAIToAnthropic,
  streamOpenAIAsAnthropic,
  writeAnthropicError,
  validateMessagesRequest,
  estimateRequestTokens,
  newMessageId
} from '../lib/anthropic-bridge.js';

const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 120000;

/* ============================================================================
   СЛУЖЕБНОЕ
   ============================================================================ */

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function upstreamBase() {
  return String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* CORS для API-шлюза шире, чем для страниц сайта: сюда ходят настольные
   клиенты и CLI, у которых Origin вообще нет. Ключ здесь — единственный
   механизм доступа, поэтому «*» не ослабляет защиту: cookie мы не читаем. */
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendError(res, status, message, type) {
  res.status(status).json(anthropicError(status, message, type));
}

/* Какой из трёх адресов запрошен. Vercel переписывает /v1/* в этот файл,
   поэтому путь может прийти и в query (?path=messages), и в самом URL. */
function resolveRoute(req) {
  const fromQuery = String(req.query?.path || '').replace(/^\/+|\/+$/g, '');
  if (fromQuery) return fromQuery.toLowerCase();
  const url = String(req.url || '');
  const pathname = url.split('?')[0];
  const cleaned = pathname.replace(/^\/+|\/+$/g, '');
  return cleaned.replace(/^(?:api\/)?v1\/?/i, '').toLowerCase();
}

/* ============================================================================
   АУТЕНТИФИКАЦИЯ ПО API-КЛЮЧУ.
   Возвращает { userId, keyId } или null. Поиск строго по хешу и строго среди
   неотозванных ключей — оба условия в запросе к базе, а не в JS.
   ============================================================================ */
async function authenticateKey(req) {
  const raw = extractApiKey(req);
  if (!looksLikeApiKey(raw)) return null;
  const hash = hashApiKey(raw);
  const rows = await supabaseRest(
    `/rest/v1/api_keys?select=id,user_id,revoked_at&key_hash=eq.${encodeURIComponent(hash)}&revoked_at=is.null&limit=1`,
    { method: 'GET' }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.user_id) return null;
  return { userId: String(row.user_id), keyId: String(row.id) };
}

/* Текущий баланс в микрорублях. Отсутствие строки = нулевой баланс. */
async function readBalanceMicro(userId) {
  const rows = await supabaseRest(
    `/rest/v1/api_balances?select=balance_micro&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: 'GET' }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return BigInt(row?.balance_micro || 0);
}

/* Списание + запись в журнал одним атомарным вызовом в базе.
   Для ролей без ограничений стоимость принудительно нулевая: строка в журнале
   появляется (токены и запрос видны в кабинете), баланс не меняется.
   Ошибку глотаем намеренно: ответ модели пользователь уже получил, и падать
   после этого нельзя. Пропущенное списание видно в логах и по расхождению
   баланса — это лучше, чем 500 на успешном запросе. */
async function chargeUsage({ userId, keyId, publicModelId, inputTokens, outputTokens, unlimited }) {
  const costMicro = unlimited ? 0n : usageCostMicroRubles(publicModelId, inputTokens, outputTokens);
  if (costMicro == null) return;
  try {
    await supabaseRest('/rest/v1/rpc/debit_api_balance', {
      method: 'POST',
      body: JSON.stringify({
        p_user_id: userId,
        p_api_key_id: keyId,
        p_model: publicModelId,
        p_input_tokens: Math.trunc(Number(inputTokens) || 0),
        p_output_tokens: Math.trunc(Number(outputTokens) || 0),
        p_cost_micro: Number(costMicro)
      })
    });
  } catch (error) {
    console.error('[v1] не удалось списать расход:', String(error?.message || error).slice(0, 200));
  }
}

/* ============================================================================
   GET /v1/models
   Отдаём ТОЛЬКО публичные идентификаторы. Список апстрима не запрашиваем
   вообще: тогда его имена моделей физически не смогут утечь наружу.
   ============================================================================ */
function handleModels(req, res) {
  const data = PUBLIC_MODEL_IDS.map(id => {
    const row = PUBLIC_MODELS[id];
    const pricing = MODEL_PRICING[id];
    return {
      type: 'model',
      id,
      display_name: row.label,
      description: row.description,
      context_window: row.contextWindow,
      max_output_tokens: row.maxOutputTokens,
      pricing: pricing
        ? {
            input_usd_per_million_tokens: pricing.inputUsdPerMillion,
            output_usd_per_million_tokens: pricing.outputUsdPerMillion
          }
        : null,
      // Дата нужна клиентам, которые сортируют список; берём дату релиза шлюза.
      created_at: '2026-08-01T00:00:00Z'
    };
  });
  return res.status(200).json({ data, has_more: false, first_id: data[0]?.id || null, last_id: data[data.length - 1]?.id || null });
}

/* ============================================================================
   POST /v1/messages/count_tokens
   Честная серверная оценка (см. комментарий к estimateRequestTokens в
   lib/anthropic-bridge.js). Апстрим токенизатора не предоставляет, поэтому
   в документации это описано именно как оценка, а не как точный подсчёт.
   ============================================================================ */
function handleCountTokens(req, res, body) {
  if (!body?.model || !Array.isArray(body?.messages) || !body.messages.length) {
    return sendError(res, 400, 'Нужны поля model и messages', 'invalid_request_error');
  }
  const model = resolvePublicModel(body.model);
  if (!model) {
    return sendError(res, 404, `Модель "${String(body.model).slice(0, 64)}" не найдена. Доступны: ${PUBLIC_MODEL_IDS.join(', ')}`, 'not_found_error');
  }
  return res.status(200).json({ input_tokens: estimateRequestTokens(body) });
}

/* ============================================================================
   POST /v1/messages
   ============================================================================ */
async function handleMessages(req, res, body, auth) {
  const validationError = validateMessagesRequest(body);
  if (validationError) return sendError(res, 400, validationError, 'invalid_request_error');

  const model = resolvePublicModel(body.model);
  if (!model) {
    return sendError(
      res,
      404,
      `Модель "${String(body.model).slice(0, 64)}" не найдена. Доступны: ${PUBLIC_MODEL_IDS.join(', ')}`,
      'not_found_error'
    );
  }

  const maxOutput = Math.min(Math.trunc(Number(body.max_tokens) || 0), model.maxOutputTokens);
  if (maxOutput <= 0) {
    return sendError(res, 400, 'Поле max_tokens должно быть положительным', 'invalid_request_error');
  }

  /* ---- ПРОВЕРКА БАЛАНСА ДО ОБРАЩЕНИЯ К МОДЕЛИ ----
     Оценка пессимистичная: весь max_tokens по выходному (дорогому) тарифу.
     Так пользователь не может уйти в существенный минус одним запросом.
     Роль читаем тем же походом в базу, что и баланс (параллельно, без лишней
     задержки): у developer / admin / moderator ограничений по балансу нет. */
  const inputTokensEstimate = estimateRequestTokens(body);
  const [balanceMicro, accessProfile] = await Promise.all([
    readBalanceMicro(auth.userId),
    readAccessProfile(auth.userId)
  ]);
  const unlimited = isUnlimitedApiRole(accessProfile?.role);
  if(model.id==='dynatos'&&!hasProAccess(accessProfile))return sendError(res,403,'Dynatos доступен с активной Pro-подпиской','permission_error');
  const worstCaseMicro = estimateCostMicroRubles(model.id, inputTokensEstimate, maxOutput) || 0n;
  if (!unlimited && (balanceMicro <= 0n || balanceMicro < worstCaseMicro)) {
    return sendError(
      res,
      402,
      `Недостаточно средств на балансе API. Баланс: ${formatMicroRubles(balanceMicro)} ₽, ` +
        `требуется не менее ${formatMicroRubles(worstCaseMicro)} ₽. ` +
        'Пополните баланс в личном кабинете.',
      'invalid_request_error'
    );
  }

  const upstreamKey = readEnv('OPENAI_API_KEY');
  if (!upstreamKey) {
    console.error('[v1] OPENAI_API_KEY не настроен');
    return sendError(res, 503, 'Шлюз временно недоступен', 'overloaded_error');
  }

  const wantStream = body.stream !== false;
  const upstreamBody = anthropicToOpenAI(body, model.internal);
  upstreamBody.max_tokens = maxOutput;
  upstreamBody.stream = wantStream;
  if (wantStream) upstreamBody.stream_options = { include_usage: true };

  let upstream;
  try {
    upstream = await callUpstream(upstreamBody, upstreamKey);
  } catch (error) {
    console.error('[v1] апстрим недоступен:', String(error?.message || error).slice(0, 200));
    return sendError(res, 503, 'Модель временно недоступна, попробуйте ещё раз', 'overloaded_error');
  }

  if (!upstream.ok) {
    // Текст ошибки апстрима наружу не отдаём: он может содержать внутреннее
    // имя модели. Логируем у себя, клиенту — нейтральная формулировка.
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch (e) { detail = ''; }
    console.error('[v1] апстрим ответил', upstream.status, detail);
    const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 503 : 502;
    return sendError(
      res,
      status,
      status === 429
        ? 'Слишком много запросов к модели, попробуйте через несколько секунд'
        : 'Модель вернула ошибку, попробуйте ещё раз',
      status === 429 ? 'rate_limit_error' : 'api_error'
    );
  }

  const messageId = newMessageId();

  /* ---- БЕЗ ПОТОКА ---- */
  if (!wantStream) {
    let data = null;
    try { data = await upstream.json(); } catch (e) { data = null; }
    if (!data) return sendError(res, 502, 'Пустой ответ модели', 'api_error');

    const message = openAIToAnthropic(data, model.id, messageId);
    if (!message.usage.input_tokens) message.usage.input_tokens = inputTokensEstimate;
    await chargeUsage({
      userId: auth.userId,
      keyId: auth.keyId,
      publicModelId: model.id,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      unlimited
    });
    return res.status(200).json(message);
  }

  /* ---- ПОТОК ----
     Заголовки уходят сразу, до первого токена модели: клиент должен увидеть
     соединение живым немедленно. X-Accel-Buffering отключает буферизацию на
     прокси — без него чанки склеиваются и «поток» перестаёт быть потоком. */
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let result = null;
  try {
    result = await streamOpenAIAsAnthropic({
      res,
      upstream,
      publicModelId: model.id,
      messageId,
      inputTokensFallback: inputTokensEstimate
    });
  } catch (error) {
    console.error('[v1] обрыв потока:', String(error?.message || error).slice(0, 200));
    try { writeAnthropicError(res, 503, 'Соединение с моделью прервалось'); } catch (e) {}
  }

  // Списываем то, что реально было израсходовано, даже если поток оборвался
  // на середине: токены апстрим уже потратил.
  if (result?.usage) {
    await chargeUsage({
      userId: auth.userId,
      keyId: auth.keyId,
      publicModelId: model.id,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      unlimited
    });
  }

  return res.end();
}

/* Вызов апстрима с повтором без reasoning_effort: не все модели его принимают,
   и из-за одного необязательного параметра запрос падать не должен. */
async function callUpstream(body, apiKey) {
  const url = `${upstreamBase()}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  const first = await withTimeout(
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }),
    UPSTREAM_TIMEOUT_MS,
    'Апстрим не ответил вовремя'
  );
  if (first.ok || (!body.reasoning_effort && !body.stream_options)) return first;

  let text = '';
  try { text = await first.clone().text(); } catch (e) { text = ''; }
  const low = text.toLowerCase();
  const retry = { ...body };
  let changed = false;
  if (body.reasoning_effort && (low.includes('reasoning') || low.includes('unsupported') || low.includes('unknown'))) {
    delete retry.reasoning_effort;
    changed = true;
  }
  if (body.stream_options && (low.includes('stream_options') || low.includes('unsupported') || low.includes('unknown'))) {
    delete retry.stream_options;
    changed = true;
  }
  if (!changed) return first;

  return withTimeout(
    fetch(url, { method: 'POST', headers, body: JSON.stringify(retry) }),
    UPSTREAM_TIMEOUT_MS,
    'Апстрим не ответил вовремя'
  );
}

/* ============================================================================
   ТОЧКА ВХОДА
   ============================================================================ */
export default async function handler(req, res) {
  applyCors(res);
  // Версию протокола отдаём всегда — клиенты Anthropic её проверяют.
  res.setHeader('anthropic-version', ANTHROPIC_VERSION);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const route = resolveRoute(req);

  if (route === 'models' || route.startsWith('models/')) {
    if (req.method !== 'GET') return sendError(res, 405, 'Метод не поддерживается', 'invalid_request_error');
    return handleModels(req, res);
  }

  if (route !== 'messages' && route !== 'messages/count_tokens') {
    return sendError(res, 404, `Адрес /v1/${route} не существует. Доступны: /v1/messages, /v1/messages/count_tokens, /v1/models`, 'not_found_error');
  }

  if (req.method !== 'POST') {
    return sendError(res, 405, 'Метод не поддерживается', 'invalid_request_error');
  }

  if (!readEnv('SUPABASE_URL') || !readEnv('SUPABASE_SERVICE_ROLE_KEY')) {
    console.error('[v1] Supabase не настроен');
    return sendError(res, 503, 'Шлюз временно недоступен', 'overloaded_error');
  }

  /* Ключ проверяем до разбора тела: незачем читать мегабайтный запрос от
     клиента, который не аутентифицирован. */
  let auth = null;
  try {
    auth = await authenticateKey(req);
  } catch (error) {
    console.error('[v1] ошибка проверки ключа:', String(error?.message || error).slice(0, 200));
    return sendError(res, 503, 'Шлюз временно недоступен', 'overloaded_error');
  }
  if (!auth) {
    return sendError(
      res,
      401,
      'Неверный или отозванный API-ключ. Передайте его в заголовке Authorization: Bearer sk-h-...',
      'authentication_error'
    );
  }

  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Тело запроса должно быть корректным JSON', 'invalid_request_error');

  if (route === 'messages/count_tokens') return handleCountTokens(req, res, body);

  try {
    return await handleMessages(req, res, body, auth);
  } catch (error) {
    console.error('[v1] необработанная ошибка:', String(error?.message || error).slice(0, 300));
    if (res.headersSent) {
      try { writeAnthropicError(res, 500, 'Внутренняя ошибка шлюза'); } catch (e) {}
      return res.end();
    }
    return sendError(res, 500, 'Внутренняя ошибка шлюза', 'api_error');
  }
}

/* Vercel разбирает JSON сам, но при нестандартном content-type или при вызове
   из CLI тело приходит потоком. Поддерживаем оба варианта. */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}
