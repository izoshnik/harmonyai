/* ============================================================================
   POST /api/payment/create

   Один эндпоинт на ДВА типа оплаты — это расширение существующей интеграции,
   а не вторая платёжная система:

     { type: 'subscription' }                 → Pro на 30 дней, цена 299 ₽
     { type: 'api_balance', amount: 500 }     → пополнение баланса API

   Ответ: { confirmationUrl, paymentId } — фронтенд просто уходит по ссылке.

   ЧТО ЗДЕСЬ ПРИНЦИПИАЛЬНО.

   1. userId НИКОГДА не берётся из тела запроса. Он приходит из подписанного
      access-токена Supabase (заголовок Authorization). Раньше тело с чужим
      userId позволяло оплатить подписку другому аккаунту.

   2. Сумму решает СЕРВЕР. Для подписки она вообще не приходит от клиента, для
      пополнения клиент присылает только рубли — и они проверяются по лимитам
      из lib/pricing.js. Никаких «кредитов», «токенов» и коэффициентов от
      клиента.

   3. Ключ идемпотентности — случайный (см. lib/api-keys.js). Два клика в одну
      секунду создадут два разных платежа, а не склеятся в один.

   4. Ничего не начисляется здесь. Баланс и Pro включает только вебхук, после
      повторной проверки платежа у ЮKassa.
   ============================================================================ */

export const config = { maxDuration: 15 };

import { requireUser, supabaseRest } from '../../lib/auth.js';
import { originAllowed, siteUrl } from '../../lib/origin.js';
import { generateIdempotenceKey } from '../../lib/api-keys.js';
import {
  proPriceKopecks,
  validateTopupAmount,
  kopecksToRublesString,
  PRO_PLAN
} from '../../lib/pricing.js';
import { createPayment, yookassaConfigured, PAYMENT_TYPES } from '../../lib/yookassa.js';

/* Внутренняя запись платежа. Создаётся ДО обращения к ЮKassa и связывается с
   их payment_id сразу после ответа — иначе вебхук не найдёт, что начислять. */
async function insertPayment({ userId, type, amountKopecks, description }) {
  const rows = await supabaseRest('/rest/v1/payments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      {
        user_id: userId,
        type,
        amount_kopecks: Number(amountKopecks),
        currency: 'RUB',
        status: 'pending',
        credited: false,
        description
      }
    ])
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw new Error('Не удалось создать запись платежа');
  return String(row.id);
}

async function attachYookassaId(internalId, yookassaId) {
  await supabaseRest(`/rest/v1/payments?id=eq.${encodeURIComponent(internalId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ yookassa_payment_id: yookassaId, updated_at: new Date().toISOString() })
  });
}

/* Платёж создан в ЮKassa, но привязать его к нашей записи не удалось —
   помечаем запись как проваленную, чтобы она не висела в «ожидании» вечно.
   Начислить по ней ничего нельзя: вебхук ищет строго по yookassa_payment_id. */
async function markFailed(internalId) {
  try {
    await supabaseRest(`/rest/v1/payments?id=eq.${encodeURIComponent(internalId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'failed', updated_at: new Date().toISOString() })
    });
  } catch (e) { /* уже залогировано выше */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-supabase-authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Forbidden' });

  if (!yookassaConfigured()) {
    console.error('[payment/create] YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены');
    return res.status(503).json({ error: 'Платёжный сервис временно недоступен' });
  }

  // Деньги — только с подтверждённой личностью. Токен обязателен, без вариантов.
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const type = String(body.type || PAYMENT_TYPES.SUBSCRIPTION).trim().toLowerCase();

    let amountKopecks;
    let description;
    let returnUrl;

    if (type === PAYMENT_TYPES.API_BALANCE) {
      const check = validateTopupAmount(body.amount);
      if (!check.ok) return res.status(400).json({ error: check.error });
      amountKopecks = check.kopecks;
      description = `Пополнение баланса API HarmonyAI на ${kopecksToRublesString(amountKopecks)} ₽`;
      returnUrl = siteUrl() + '/api/dashboard?topup=1';
    } else if (type === PAYMENT_TYPES.SUBSCRIPTION) {
      // Цена подписки живёт в lib/pricing.js и не приходит от клиента.
      amountKopecks = proPriceKopecks();
      description = PRO_PLAN.description;
      returnUrl = siteUrl() + '/subscribe?success=1';
    } else {
      return res.status(400).json({ error: 'Неизвестный тип платежа' });
    }

    const internalId = await insertPayment({
      userId: user.id,
      type,
      amountKopecks,
      description
    });

    let payment;
    try {
      payment = await createPayment({
        amountKopecks,
        description,
        returnUrl,
        // userId дублируем в metadata для совместимости со старыми платежами:
        // вебхук раньше читал именно это поле. Доверять ему нельзя — вебхук
        // берёт владельца из нашей записи по internalPaymentId.
        metadata: { type, userId: user.id, internalPaymentId: internalId },
        idempotenceKey: generateIdempotenceKey(),
        receiptEmail: user.email || String(body.email || '')
      });
    } catch (error) {
      console.error('[payment/create] ЮKassa вернула ошибку:', String(error?.message || error).slice(0, 300));
      await markFailed(internalId);
      return res.status(502).json({ error: 'Не удалось создать платёж, попробуйте ещё раз' });
    }

    try {
      await attachYookassaId(internalId, payment.id);
    } catch (error) {
      console.error('[payment/create] не удалось связать платёж', payment.id, 'с записью', internalId, error?.message);
      await markFailed(internalId);
      return res.status(500).json({ error: 'Платёж создан некорректно, попробуйте ещё раз' });
    }

    return res.status(200).json({
      confirmationUrl: payment.confirmationUrl,
      paymentId: payment.id,
      amountRub: kopecksToRublesString(amountKopecks)
    });
  } catch (error) {
    console.error('[payment/create]', String(error?.message || error).slice(0, 300));
    return res.status(500).json({ error: 'Внутренняя ошибка' });
  }
}
