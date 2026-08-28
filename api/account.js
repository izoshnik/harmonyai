/* ============================================================================
   /api/account — ЛИЧНЫЙ КАБИНЕТ API И ОБЩИЕ ССЫЛКИ НА ЧАТЫ.

   Один эндпоинт на все операции кабинета: слоты функций Vercel исчерпаны,
   поэтому действие выбирается полем action, а не отдельным адресом.

   GET  /api/account?action=overview            всё для /api/dashboard одним запросом
   GET  /api/account?action=keys                список ключей (только маски)
   GET  /api/account?action=balance             баланс API
   GET  /api/account?action=payments            история платежей
   GET  /api/account?action=usage               сводка расхода за 30 дней
   GET  /api/account?action=share&token=...     чтение чата по ссылке (без входа)

   POST /api/account  { action:'keys.create', name }     ключ показывается ОДИН раз
   POST /api/account  { action:'keys.rotate', id }       старый ключ мгновенно мёртв
   POST /api/account  { action:'keys.revoke', id }       отзыв без удаления записи
   POST /api/account  { action:'keys.delete', id }       удаление записи
   POST /api/account  { action:'keys.rename', id, name }
   POST /api/account  { action:'share.create', chatId }  ссылка «Поделиться чатом»
   POST /api/account  { action:'share.revoke', chatId }

   ЧТО ГАРАНТИРУЕТСЯ.

   1. ВЛАДЕЛЕЦ — ИЗ ТОКЕНА. user_id берётся только из подписанного access-токена
      Supabase. Поля userId в теле запроса не существует: подделать нечего.

   2. КАЖДЫЙ ЗАПРОС К БАЗЕ ФИЛЬТРУЕТСЯ ПО ВЛАДЕЛЬЦУ. Мы ходим под service-role
      ключом, который RLS обходит, поэтому условие user_id=eq.<свой> стоит в
      каждом запросе — включая PATCH и DELETE. Пользователь A физически не может
      прочитать, отозвать, перевыпустить или удалить ключ пользователя B: строка
      с чужим id просто не попадает в выборку.

   3. ОТКРЫТЫЙ КЛЮЧ НЕ ХРАНИТСЯ. Он возвращается ровно один раз — в ответе на
      создание или перевыпуск. Ни один другой ответ его не содержит и не может
      содержать: в базе только SHA-256 хеш.

   4. БАЛАНС ЗДЕСЬ ТОЛЬКО ЧИТАЕТСЯ. Изменяют его лишь вебхук ЮKassa (начисление)
      и шлюз /v1 (списание) — через SQL-функции. Эндпоинт кабинета не умеет
      прибавлять деньги, даже если очень попросить.

   5. ССЫЛКА-ПОДЕЛИТЬСЯ ДАЁТ ТОЛЬКО ЧТЕНИЕ ОДНОГО ЧАТА. Ни изменить, ни удалить
      исходный чат по токену нельзя — таких действий в этом файле нет. Данные
      аккаунта владельца (email, id, баланс) в ответ не попадают.
   ============================================================================ */

export const config = { maxDuration: 15 };

import { requireUser, supabaseRest, ownerFilter, readProfileRole, isUnlimitedApiRole } from '../lib/auth.js';
import { originAllowed, siteUrl } from '../lib/origin.js';
import {
  generateApiKey,
  maskApiKey,
  generateShareToken
} from '../lib/api-keys.js';
import {
  formatMicroRubles,
  kopecksToRublesString,
  publicPricingTable,
  TOPUP_LIMITS,
  topupMinKopecks,
  topupMaxKopecks
} from '../lib/pricing.js';

const MAX_KEYS_PER_USER = 20;
const KEY_NAME_MAX = 60;

/* ============================================================================
   СЛУЖЕБНОЕ
   ============================================================================ */

function fail(res, status, message) {
  return res.status(status).json({ error: { message, code: status } });
}

function cleanName(value, fallback) {
  const name = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!name) return fallback;
  return name.slice(0, KEY_NAME_MAX);
}

/* Идентификаторы приходят от клиента и уходят в строку запроса PostgREST.
   Пропускаем только то, что действительно может быть uuid: иначе значение вида
   `*` или `not.is.null` превратится в фильтр «любая строка». */
function safeUuid(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[0-9a-fA-F-]{32,40}$/.test(id) ? id : '';
}

/* id чата — текст (base62 у новых, chat_<число> у старых). Разрешаем только
   безопасный алфавит, чтобы фильтр нельзя было расширить. */
function safeChatId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
}

function safeShareToken(value) {
  const token = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9]{16,64}$/.test(token) ? token : '';
}

/* Ключ наружу: маска, даты, счётчик. Хеша здесь нет и быть не может. */
function publicKeyRow(row) {
  return {
    id: String(row.id),
    name: row.name || 'API Key',
    masked: maskApiKey(row.key_preview),
    createdAt: row.created_at || null,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
    requestCount: Number(row.request_count || 0)
  };
}

/* ============================================================================
   ЧТЕНИЕ ДАННЫХ КАБИНЕТА
   ============================================================================ */

async function listKeys(userId) {
  const rows = await supabaseRest(
    '/rest/v1/api_keys' +
      '?select=id,name,key_preview,created_at,last_used_at,revoked_at,request_count' +
      `&${ownerFilter(userId)}&order=created_at.desc&limit=100`,
    { method: 'GET' }
  );
  return (Array.isArray(rows) ? rows : []).map(publicKeyRow);
}

async function readBalance(userId) {
  /* Роль спрашиваем рядом с балансом: у developer / admin / moderator расход
     не списывается (см. lib/auth.js и api/v1.js), и кабинет обязан показывать
     это вместо суммы — иначе человек видит «0,00 ₽» и идёт пополнять зря. */
  const [rows, role] = await Promise.all([
    supabaseRest(
      `/rest/v1/api_balances?select=balance_micro,updated_at&${ownerFilter(userId)}&limit=1`,
      { method: 'GET' }
    ),
    readProfileRole(userId)
  ]);
  const row = Array.isArray(rows) ? rows[0] : null;
  const micro = BigInt(row?.balance_micro || 0);
  const unlimited = isUnlimitedApiRole(role);
  return {
    micro: micro.toString(),          // строкой: BigInt не сериализуется в JSON
    rub: formatMicroRubles(micro),    // «500,00»
    positive: unlimited || micro > 0n,
    unlimited,
    role: unlimited ? role : null,
    updatedAt: row?.updated_at || null
  };
}

async function listPayments(userId, limit = 20) {
  const rows = await supabaseRest(
    '/rest/v1/payments' +
      '?select=id,type,amount_kopecks,status,credited,description,created_at,paid_at' +
      `&${ownerFilter(userId)}&order=created_at.desc&limit=${Math.min(50, Math.max(1, limit))}`,
    { method: 'GET' }
  );
  return (Array.isArray(rows) ? rows : []).map(row => ({
    id: String(row.id),
    type: row.type,
    amountRub: kopecksToRublesString(BigInt(row.amount_kopecks || 0)),
    status: row.status,
    credited: Boolean(row.credited),
    description: row.description || '',
    createdAt: row.created_at || null,
    paidAt: row.paid_at || null
  }));
}

async function readUsage(userId, days = 30) {
  let raw = null;
  try {
    raw = await supabaseRest('/rest/v1/rpc/api_usage_summary', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_days: days })
    });
  } catch (error) {
    console.error('[account] сводка расхода недоступна:', String(error?.message || error).slice(0, 200));
    return null;
  }
  const data = Array.isArray(raw) ? raw[0] : raw;
  if (!data) return null;
  const costMicro = BigInt(data.cost_micro || 0);
  return {
    days: Number(data.days || days),
    requests: Number(data.requests || 0),
    inputTokens: Number(data.input_tokens || 0),
    outputTokens: Number(data.output_tokens || 0),
    costRub: formatMicroRubles(costMicro),
    byModel: (Array.isArray(data.by_model) ? data.by_model : []).map(m => ({
      model: m.model,
      requests: Number(m.requests || 0),
      inputTokens: Number(m.input_tokens || 0),
      outputTokens: Number(m.output_tokens || 0),
      costRub: formatMicroRubles(BigInt(m.cost_micro || 0))
    }))
  };
}

/* Pro показываем рядом с балансом, но это независимые вещи: баланс API не
   зависит от подписки, а подписка не даёт баланса. */
async function readPlan(userId) {
  try {
    const rows = await supabaseRest(
      `/rest/v1/profiles?select=plan,plan_expires_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
      { method: 'GET' }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const expires = row?.plan_expires_at ? new Date(row.plan_expires_at).getTime() : 0;
    const active = row?.plan === 'pro' && (!expires || expires > Date.now());
    return { plan: active ? 'pro' : 'free', expiresAt: row?.plan_expires_at || null };
  } catch (e) {
    return { plan: 'free', expiresAt: null };
  }
}

/* ============================================================================
   ОПЕРАЦИИ С КЛЮЧАМИ
   ============================================================================ */

async function createKey(userId, name) {
  const existing = await supabaseRest(
    `/rest/v1/api_keys?select=id&${ownerFilter(userId)}&revoked_at=is.null&limit=${MAX_KEYS_PER_USER + 1}`,
    { method: 'GET' }
  );
  if (Array.isArray(existing) && existing.length >= MAX_KEYS_PER_USER) {
    return { error: `Достигнут предел в ${MAX_KEYS_PER_USER} активных ключей. Удалите ненужные.` };
  }

  const generated = generateApiKey();
  const rows = await supabaseRest('/rest/v1/api_keys', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      {
        user_id: userId,
        name: cleanName(name, 'API Key'),
        key_hash: generated.hash,
        key_preview: generated.preview
      }
    ])
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) return { error: 'Не удалось создать ключ' };

  /* generated.key возвращается здесь ЕДИНСТВЕННЫЙ раз за всю жизнь ключа. */
  return { key: generated.key, item: publicKeyRow(row) };
}

/* Перевыпуск: старая строка помечается отозванной (её хеш больше не проходит
   аутентификацию — в /v1 стоит фильтр revoked_at=is.null), затем создаётся
   новая. Запись об отозванном ключе остаётся: по ней видно, что и когда было
   перевыпущено, а журнал расхода по старому ключу не теряет привязку. */
async function rotateKey(userId, keyId, res) {
  const id = safeUuid(keyId);
  if (!id) return fail(res, 400, 'Некорректный идентификатор ключа');

  const rows = await supabaseRest(
    `/rest/v1/api_keys?select=id,name&id=eq.${encodeURIComponent(id)}&${ownerFilter(userId)}&revoked_at=is.null&limit=1`,
    { method: 'GET' }
  );
  const current = Array.isArray(rows) ? rows[0] : null;
  if (!current) return fail(res, 404, 'Ключ не найден');

  await supabaseRest(
    `/rest/v1/api_keys?id=eq.${encodeURIComponent(id)}&${ownerFilter(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() })
    }
  );

  const created = await createKey(userId, current.name);
  if (created.error) return fail(res, 400, created.error);
  return res.status(200).json({ ok: true, key: created.key, item: created.item, revokedId: id });
}

/* ============================================================================
   ССЫЛКА «ПОДЕЛИТЬСЯ ЧАТОМ»
   ============================================================================ */

async function createShare(userId, chatIdRaw, res) {
  const chatId = safeChatId(chatIdRaw);
  if (!chatId) return fail(res, 400, 'Некорректный идентификатор чата');

  /* Владение проверяем на сервере, а не на фронтенде: id чата в URL можно
     подменить руками. Фильтр по user_id обязателен — без него service-role
     ключ отдал бы чужой чат. */
  const chats = await supabaseRest(
    `/rest/v1/chats?select=id,title&id=eq.${encodeURIComponent(chatId)}&${ownerFilter(userId)}&limit=1`,
    { method: 'GET' }
  );
  const chat = Array.isArray(chats) ? chats[0] : null;
  if (!chat) return fail(res, 404, 'Чат не найден');

  const existing = await supabaseRest(
    `/rest/v1/chat_shares?select=id,token,revoked_at&chat_id=eq.${encodeURIComponent(chatId)}&limit=1`,
    { method: 'GET' }
  );
  const row = Array.isArray(existing) ? existing[0] : null;

  /* Одна активная ссылка на чат: повторное «Поделиться» отдаёт ту же ссылку,
     иначе у пользователя расползаются копии, которые он не может отозвать. */
  if (row && !row.revoked_at && String(row.token || '')) {
    return res.status(200).json({ ok: true, token: row.token, url: shareUrl(chatId, row.token), reused: true });
  }

  const token = generateShareToken();

  if (row) {
    await supabaseRest(`/rest/v1/chat_shares?id=eq.${encodeURIComponent(row.id)}&owner_user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ token, revoked_at: null, view_count: 0 })
    });
  } else {
    await supabaseRest('/rest/v1/chat_shares', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ chat_id: chatId, owner_user_id: userId, token }])
    });
  }

  return res.status(200).json({ ok: true, token, url: shareUrl(chatId, token), reused: false });
}

function shareUrl(chatId, token) {
  return `${siteUrl()}/chat/${encodeURIComponent(chatId)}?share=${encodeURIComponent(token)}`;
}

async function revokeShare(userId, chatIdRaw, res) {
  const chatId = safeChatId(chatIdRaw);
  if (!chatId) return fail(res, 400, 'Некорректный идентификатор чата');
  await supabaseRest(
    `/rest/v1/chat_shares?chat_id=eq.${encodeURIComponent(chatId)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() })
    }
  );
  return res.status(200).json({ ok: true });
}

/* ============================================================================
   ЧТЕНИЕ ЧАТА ПО ССЫЛКЕ — ЕДИНСТВЕННОЕ ДЕЙСТВИЕ БЕЗ ВХОДА В АККАУНТ.

   Отдаём только заголовок и переписку. Ни владельца, ни его email, ни id
   аккаунта, ни баланс — ничего из этого в ответе нет. Право на запись токен
   не даёт: изменяющих операций с исходным чатом в файле не существует.
   ============================================================================ */
async function readShare(tokenRaw, res) {
  const token = safeShareToken(tokenRaw);
  if (!token) return fail(res, 400, 'Некорректная ссылка');

  const shares = await supabaseRest(
    `/rest/v1/chat_shares?select=id,chat_id,owner_user_id,created_at&token=eq.${encodeURIComponent(token)}&revoked_at=is.null&limit=1`,
    { method: 'GET' }
  );
  const share = Array.isArray(shares) ? shares[0] : null;
  if (!share) return fail(res, 404, 'Ссылка недействительна или отозвана');

  const chats = await supabaseRest(
    '/rest/v1/chats?select=id,title,history,updated_at' +
      `&id=eq.${encodeURIComponent(share.chat_id)}` +
      `&user_id=eq.${encodeURIComponent(share.owner_user_id)}&limit=1`,
    { method: 'GET' }
  );
  const chat = Array.isArray(chats) ? chats[0] : null;
  if (!chat) return fail(res, 404, 'Чат больше не доступен');

  /* Счётчик просмотров — не критичная операция, ошибку глотаем. */
  supabaseRest(`/rest/v1/rpc/bump_share_view`, {
    method: 'POST',
    body: JSON.stringify({ p_share_id: share.id })
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    chat: {
      id: chat.id,
      title: chat.title || 'Общий чат',
      history: Array.isArray(chat.history) ? chat.history : [],
      updatedAt: chat.updated_at || null
    },
    sharedAt: share.created_at || null,
    readOnly: true
  });
}

/* ============================================================================
   ТОЧКА ВХОДА
   ============================================================================ */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-supabase-authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!originAllowed(req)) return fail(res, 403, 'Запрос отклонён');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(req.query?.action || body.action || '').trim().toLowerCase();

  try {
    /* ---- Публичные действия (без входа) ---- */
    if (action === 'share' && req.method === 'GET') {
      return await readShare(req.query?.token, res);
    }
    if (action === 'pricing' && req.method === 'GET') {
      // Тарифы и лимиты для страниц /api и /api/dashboard. Секретов нет.
      return res.status(200).json({
        ok: true,
        pricing: publicPricingTable(),
        topup: {
          minRub: kopecksToRublesString(topupMinKopecks()),
          maxRub: kopecksToRublesString(topupMaxKopecks()),
          presets: TOPUP_LIMITS.presetRubles
        }
      });
    }

    /* ---- Дальше всё требует подтверждённого токена ---- */
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      if (action === 'keys') return res.status(200).json({ ok: true, keys: await listKeys(user.id) });
      if (action === 'balance') return res.status(200).json({ ok: true, balance: await readBalance(user.id) });
      if (action === 'payments') return res.status(200).json({ ok: true, payments: await listPayments(user.id) });
      if (action === 'usage') return res.status(200).json({ ok: true, usage: await readUsage(user.id) });

      if (action === 'overview' || !action) {
        /* Один запрос вместо пяти: /api/dashboard рисуется сразу целиком.
           Параллельно — потому что запросы независимы. */
        const [keys, balance, payments, usage, plan] = await Promise.all([
          listKeys(user.id),
          readBalance(user.id),
          listPayments(user.id),
          readUsage(user.id),
          readPlan(user.id)
        ]);
        return res.status(200).json({
          ok: true,
          email: user.email,
          plan,
          balance,
          keys,
          payments,
          usage,
          pricing: publicPricingTable(),
          topup: {
            minRub: kopecksToRublesString(topupMinKopecks()),
            maxRub: kopecksToRublesString(topupMaxKopecks()),
            presets: TOPUP_LIMITS.presetRubles
          }
        });
      }

      return fail(res, 400, 'Неизвестное действие');
    }

    if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается');

    switch (action) {
      case 'keys.create': {
        const created = await createKey(user.id, body.name);
        if (created.error) return fail(res, 400, created.error);
        return res.status(200).json({ ok: true, key: created.key, item: created.item });
      }

      case 'keys.rotate':
        return await rotateKey(user.id, body.id, res);

      case 'keys.revoke': {
        const id = safeUuid(body.id);
        if (!id) return fail(res, 400, 'Некорректный идентификатор ключа');
        await supabaseRest(
          `/rest/v1/api_keys?id=eq.${encodeURIComponent(id)}&${ownerFilter(user.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ revoked_at: new Date().toISOString() })
          }
        );
        return res.status(200).json({ ok: true });
      }

      case 'keys.delete': {
        const id = safeUuid(body.id);
        if (!id) return fail(res, 400, 'Некорректный идентификатор ключа');
        /* Фильтр по владельцу стоит и в DELETE: без него чужую строку можно
           было бы удалить, подставив её id. Журнал расхода не пострадает —
           api_usage.api_key_id объявлен как on delete set null. */
        await supabaseRest(
          `/rest/v1/api_keys?id=eq.${encodeURIComponent(id)}&${ownerFilter(user.id)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
        );
        return res.status(200).json({ ok: true });
      }

      case 'keys.rename': {
        const id = safeUuid(body.id);
        if (!id) return fail(res, 400, 'Некорректный идентификатор ключа');
        await supabaseRest(
          `/rest/v1/api_keys?id=eq.${encodeURIComponent(id)}&${ownerFilter(user.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ name: cleanName(body.name, 'API Key') })
          }
        );
        return res.status(200).json({ ok: true });
      }

      case 'share.create':
        return await createShare(user.id, body.chatId, res);

      case 'share.revoke':
        return await revokeShare(user.id, body.chatId, res);

      default:
        return fail(res, 400, 'Неизвестное действие');
    }
  } catch (error) {
    console.error('[account]', action, String(error?.message || error).slice(0, 300));
    if (res.headersSent) return res.end();
    return fail(res, 500, 'Внутренняя ошибка');
  }
}
