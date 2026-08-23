/* ============================================================================
   ЮKASSA: ОДНА ИНТЕГРАЦИЯ НА ВСЕ ТИПЫ ПЛАТЕЖЕЙ.

   Магазин, shopId и секретный ключ — те же, что были у Pro-подписки. Второй
   платёжной системы, второго магазина и второго вебхука в проекте нет и быть
   не должно: пополнение баланса API отличается от подписки ровно одним полем
   metadata.type, а всё остальное общее.

   Секретный ключ живёт только здесь и в переменных окружения. На клиент он не
   уходит никогда — фронтенд знает только сумму и confirmation_url.

   ДЕНЬГИ. Наружу в ЮKassa сумма уходит строкой «299.00» — так требует их API.
   Внутри мы её никогда не парсим во float: строка ↔ копейки переводится
   функциями из lib/pricing.js на целых числах.
   ============================================================================ */

import { kopecksToRublesString, rublesStringToKopecks } from './pricing.js';

const API_BASE = 'https://api.yookassa.ru/v3';
const REQUEST_TIMEOUT_MS = 12000;

/* Типы платежей. Оба обслуживаются одним /api/payment/create и одним
   /api/payment/webhook — различаются только полем type. */
export const PAYMENT_TYPES = {
  SUBSCRIPTION: 'subscription',
  API_BALANCE: 'api_balance'
};

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

export function yookassaConfigured() {
  return Boolean(readEnv('YOOKASSA_SHOP_ID') && readEnv('YOOKASSA_SECRET_KEY'));
}

function authHeader() {
  const shopId = readEnv('YOOKASSA_SHOP_ID');
  const secret = readEnv('YOOKASSA_SECRET_KEY');
  if (!shopId || !secret) throw new Error('Платёжный сервис не настроен');
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ============================================================================
   СОЗДАНИЕ ПЛАТЕЖА.
   amountKopecks — BigInt в копейках; строку для ЮKassa делаем из него, а не
   принимаем от вызывающего, чтобы сумма в запросе и сумма в нашей базе не
   могли разойтись.

   idempotenceKey обязателен и должен быть СЛУЧАЙНЫМ (см. generateIdempotenceKey
   в lib/api-keys.js). Если собрать его из userId + времени, два быстрых клика
   дадут один ключ, и второй платёж молча склеится с первым.
   ============================================================================ */
export async function createPayment({
  amountKopecks,
  description,
  returnUrl,
  metadata,
  idempotenceKey,
  receiptEmail = ''
}) {
  const valueString = kopecksToRublesString(amountKopecks);

  const body = {
    amount: { value: valueString, currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    description: String(description || 'Оплата HarmonyAI').slice(0, 128),
    metadata: metadata || {}
  };

  /* Чек нужен по 54-ФЗ, если магазин работает с онлайн-кассой. Отправляем
     только когда знаем email — иначе ЮKassa отклонит неполный чек. */
  if (receiptEmail) {
    body.receipt = {
      customer: { email: String(receiptEmail).slice(0, 128) },
      items: [
        {
          description: body.description,
          quantity: '1',
          amount: { value: valueString, currency: 'RUB' },
          vat_code: 1
        }
      ]
    };
  }

  const response = await withTimeout(
    fetch(`${API_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(),
        'Idempotence-Key': String(idempotenceKey)
      },
      body: JSON.stringify(body)
    }),
    REQUEST_TIMEOUT_MS,
    'Платёжный сервис не ответил вовремя'
  );

  let data = null;
  try { data = await response.json(); } catch (e) { data = null; }

  if (!response.ok || !data?.confirmation?.confirmation_url) {
    const detail = data?.description || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return {
    id: String(data.id),
    status: String(data.status || 'pending'),
    confirmationUrl: String(data.confirmation.confirmation_url),
    amountKopecks: rublesStringToKopecks(data.amount?.value || valueString)
  };
}

/* ============================================================================
   ПОВТОРНЫЙ ЗАПРОС ПЛАТЕЖА.
   Единственный источник истины о статусе оплаты. Тело вебхука подделывается
   обычным POST-запросом, поэтому начислять что-либо по нему нельзя — только
   по ответу этого запроса.
   ============================================================================ */
export async function fetchPayment(paymentId) {
  const response = await withTimeout(
    fetch(`${API_BASE}/payments/${encodeURIComponent(String(paymentId))}`, {
      headers: { Authorization: authHeader() }
    }),
    REQUEST_TIMEOUT_MS,
    'Платёжный сервис не ответил вовремя'
  );
  if (!response.ok) return null;
  try { return await response.json(); } catch (e) { return null; }
}

/* Сумма платежа в копейках — целым числом, без parseFloat. */
export function paymentAmountKopecks(payment) {
  return rublesStringToKopecks(payment?.amount?.value || '');
}
