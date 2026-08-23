/* ============================================================================
   POST /api/payment/webhook — ЕДИНСТВЕННОЕ МЕСТО, ГДЕ НАЧИСЛЯЮТСЯ ДЕНЬГИ.

   ЮKassa присылает уведомление о событии. Обслуживаем оба типа платежей одним
   вебхуком (второй платёжной системы в проекте нет):

     metadata.type = 'subscription' → Pro на 30 дней
     metadata.type = 'api_balance'  → баланс API + сумма платежа

   ПОРЯДОК ПРОВЕРОК — он же порядок защиты от подделки и двойного начисления:

     1. Тело вебхука НЕ является доказательством оплаты. Обычный POST на этот
        адрес может отправить кто угодно. Поэтому платёж перезапрашивается у
        ЮKassa по id (fetchPayment) — и дальше используется ТОЛЬКО ответ API.
     2. Статус должен быть succeeded.
     3. Сумма берётся из ответа ЮKassa в копейках и сверяется с суммой нашей
        внутренней записи (сверка внутри SQL-функции, под блокировкой строки).
     4. Назначение (type) проверяется: платёж за подписку не может начислить
        баланс, и наоборот.
     5. Владелец берётся из НАШЕЙ записи платежа, а не из metadata.
     6. Начисление идёт через SQL-функцию с SELECT ... FOR UPDATE и флагом
        credited. Десять повторных вебхуков = одно начисление.

   Возврат пользователя на return_url не начисляет НИЧЕГО и никогда: этот
   адрес открывается в браузере и подделывается ссылкой.

   Отвечаем 200 почти всегда — иначе ЮKassa будет повторять уведомление
   сутками. Проблемы уходят в логи.
   ============================================================================ */

export const config = { maxDuration: 15 };

import { supabaseRest } from '../../lib/auth.js';
import { fetchPayment, paymentAmountKopecks, PAYMENT_TYPES, yookassaConfigured } from '../../lib/yookassa.js';
import { PRO_PLAN, kopecksToRublesString } from '../../lib/pricing.js';

/* Наша внутренняя запись платежа. Она — источник истины о владельце и сумме. */
async function findInternalPayment(yookassaId) {
  const rows = await supabaseRest(
    `/rest/v1/payments?select=id,user_id,type,amount_kopecks,status,credited&yookassa_payment_id=eq.${encodeURIComponent(yookassaId)}&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function setPaymentStatus(yookassaId, status) {
  try {
    await supabaseRest(`/rest/v1/payments?yookassa_payment_id=eq.${encodeURIComponent(yookassaId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
  } catch (e) {
    console.error('[webhook] не удалось обновить статус платежа', yookassaId, e?.message);
  }
}

/* Журнал событий существовал до этой правки и остаётся: по нему удобно
   разбирать спорные платежи. Начисление от него не зависит. */
async function logEvent({ userId, paymentId, amount, status }) {
  try {
    await supabaseRest('/rest/v1/payment_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([
        {
          user_id: userId || null,
          payment_id: paymentId,
          amount,
          status,
          created_at: new Date().toISOString()
        }
      ])
    });
  } catch (e) { /* логирование не критично */ }
}

/* ============================================================================
   СТАРЫЕ ПЛАТЕЖИ (без внутренней записи).

   Платежи, созданные прежней версией /api/payment/create, лежат только в
   ЮKassa: таблицы payments тогда не было. Если такой платёж оплатят уже после
   деплоя, вебхук обязан его отработать — иначе человек заплатит и не получит
   Pro. Только для этого случая владелец берётся из metadata.

   Здесь срок ставится РОВНО now()+30 дней, а не продлевается: без флага
   credited защиты от повторного вебхука нет, и «продление» начислило бы
   лишние дни при каждом повторе. Установка одной и той же даты идемпотентна.
   ============================================================================ */
async function activateProLegacy(userId) {
  const expiresAt = new Date(Date.now() + PRO_PLAN.periodDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    await supabaseRest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ plan: 'pro', plan_expires_at: expiresAt, updated_at: new Date().toISOString() })
    });
    return true;
  } catch (e) {
    console.error('[webhook] legacy-активация Pro не удалась для', userId, e?.message);
    return false;
  }
}

/* Ответ RPC приходит либо объектом, либо массивом из одного объекта. */
function rpcResult(raw) {
  if (Array.isArray(raw)) return raw[0] || null;
  return raw && typeof raw === 'object' ? raw : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).end();
  }

  const eventName = String(event?.event || '');
  const paymentId = String(event?.object?.id || '');
  if (!paymentId) return res.status(200).end();

  if (!yookassaConfigured()) {
    console.error('[webhook] ЮKassa не настроена, платёж', paymentId, 'не обработан');
    return res.status(200).end();
  }

  try {
    /* Отмена — просто отмечаем у себя, начислять нечего. */
    if (eventName === 'payment.canceled') {
      await setPaymentStatus(paymentId, 'canceled');
      await logEvent({ userId: null, paymentId, amount: event?.object?.amount?.value, status: 'canceled' });
      return res.status(200).end();
    }

    if (eventName !== 'payment.succeeded') return res.status(200).end();

    /* --- ПРОВЕРКА 1: платёж перезапрашиваем у ЮKassa --- */
    const payment = await fetchPayment(paymentId);
    if (!payment) {
      console.error('[webhook] ЮKassa не подтвердила платёж', paymentId);
      return res.status(200).end();
    }

    /* --- ПРОВЕРКА 2: статус --- */
    if (payment.status !== 'succeeded') {
      console.warn('[webhook] платёж', paymentId, 'в статусе', payment.status, '— начисление не производится');
      return res.status(200).end();
    }

    /* --- ПРОВЕРКА 3: сумма в копейках, без float --- */
    const amountKopecks = paymentAmountKopecks(payment);
    if (amountKopecks == null || amountKopecks <= 0n) {
      console.error('[webhook] некорректная сумма платежа', paymentId, payment.amount?.value);
      return res.status(200).end();
    }

    /* --- ПРОВЕРКА 4: назначение --- */
    const metaType = String(payment.metadata?.type || PAYMENT_TYPES.SUBSCRIPTION).trim().toLowerCase();

    /* --- ПРОВЕРКА 5: владелец — из нашей записи --- */
    const internal = await findInternalPayment(paymentId);

    /* ---------- ПОПОЛНЕНИЕ БАЛАНСА API ---------- */
    if (metaType === PAYMENT_TYPES.API_BALANCE) {
      if (!internal) {
        // Пополнений баланса до этой правки не существовало: записи нет →
        // платёж не наш. Начислять по одному metadata нельзя.
        console.error('[webhook] пополнение', paymentId, 'без внутренней записи — начисление отклонено');
        await logEvent({ userId: payment.metadata?.userId || null, paymentId, amount: payment.amount?.value, status: 'orphan_topup' });
        return res.status(200).end();
      }

      const raw = await supabaseRest('/rest/v1/rpc/credit_api_balance', {
        method: 'POST',
        body: JSON.stringify({
          p_yookassa_payment_id: paymentId,
          p_amount_kopecks: Number(amountKopecks)
        })
      });
      const result = rpcResult(raw);

      if (!result?.ok) {
        console.error('[webhook] начисление баланса отклонено:', paymentId, result?.reason || 'unknown', JSON.stringify(result || {}));
        await logEvent({ userId: internal.user_id, paymentId, amount: payment.amount?.value, status: 'topup_rejected:' + (result?.reason || 'unknown') });
        return res.status(200).end();
      }

      if (result.already_credited) {
        // Нормальная ситуация: ЮKassa повторила уведомление. Ничего не делаем.
        console.log('[webhook] повторное уведомление о пополнении', paymentId, '— уже начислено');
        return res.status(200).end();
      }

      console.log('[webhook] баланс пополнен:', paymentId, kopecksToRublesString(amountKopecks), '₽');
      await logEvent({ userId: internal.user_id, paymentId, amount: payment.amount?.value, status: 'topup_credited' });
      return res.status(200).end();
    }

    /* ---------- PRO-ПОДПИСКА ---------- */
    if (metaType !== PAYMENT_TYPES.SUBSCRIPTION) {
      console.error('[webhook] неизвестное назначение платежа', paymentId, metaType);
      return res.status(200).end();
    }

    if (!internal) {
      // Платёж создан прежней версией эндпоинта — обрабатываем по-старому.
      const legacyUserId = String(payment.metadata?.userId || '');
      if (!legacyUserId) {
        console.error('[webhook] платёж', paymentId, 'без записи и без userId в metadata');
        return res.status(200).end();
      }
      const ok = await activateProLegacy(legacyUserId);
      await logEvent({ userId: legacyUserId, paymentId, amount: payment.amount?.value, status: ok ? 'activated_legacy' : 'activation_failed' });
      return res.status(200).end();
    }

    const raw = await supabaseRest('/rest/v1/rpc/credit_subscription', {
      method: 'POST',
      body: JSON.stringify({
        p_yookassa_payment_id: paymentId,
        p_amount_kopecks: Number(amountKopecks),
        p_period_days: PRO_PLAN.periodDays
      })
    });
    const result = rpcResult(raw);

    if (!result?.ok) {
      console.error('[webhook] активация Pro отклонена:', paymentId, result?.reason || 'unknown', JSON.stringify(result || {}));
      await logEvent({ userId: internal.user_id, paymentId, amount: payment.amount?.value, status: 'activation_rejected:' + (result?.reason || 'unknown') });
      return res.status(200).end();
    }

    if (result.already_credited) {
      console.log('[webhook] повторное уведомление о подписке', paymentId, '— Pro уже активирован');
      return res.status(200).end();
    }

    console.log('[webhook] Pro активирован до', result.plan_expires_at, 'по платежу', paymentId);
    await logEvent({ userId: internal.user_id, paymentId, amount: payment.amount?.value, status: 'activated' });
    return res.status(200).end();
  } catch (error) {
    console.error('[webhook]', String(error?.message || error).slice(0, 300));
    // Всегда 200: иначе ЮKassa начнёт повторять уведомление по расписанию.
    return res.status(200).end();
  }
}
