/* ============================================================================
   POST /api/payment/webhook
   ЮKassa шлёт уведомление о событии (payment.succeeded и т.д.).
   При успешной оплате: обновляем profiles → plan='pro', plan_expires_at=+30 дней.
   Верификация: повторно запрашиваем платёж у ЮKassa по payment.id (не доверяем телу).
   ============================================================================ */

export const config = { maxDuration: 15 };

function readEnv(n) { return String(process.env[n] || '').trim(); }

function yookassaAuth() {
  const shopId = readEnv('YOOKASSA_SHOP_ID');
  const secret = readEnv('YOOKASSA_SECRET_KEY');
  if (!shopId || !secret) throw new Error('YooKassa credentials not configured');
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

async function verifyPayment(paymentId) {
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers: { 'Authorization': yookassaAuth() }
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function activatePro(userId) {
  const base = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key || !userId) return false;

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ plan: 'pro', plan_expires_at: expiresAt, updated_at: new Date().toISOString() })
    }
  );
  return res.ok;
}

async function logPayment({ userId, paymentId, amount, status }) {
  const base = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return;
  try {
    await fetch(`${base}/rest/v1/payment_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify([{ user_id: userId, payment_id: paymentId, amount, status, created_at: new Date().toISOString() }])
    });
  } catch { /* логирование не критично */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).end();
  }

  // Нас интересует только успешная оплата
  if (event?.event !== 'payment.succeeded') {
    return res.status(200).end(); // другие события — игнорируем, отвечаем 200
  }

  const paymentId = event?.object?.id;
  if (!paymentId) return res.status(400).end();

  try {
    // Верифицируем платёж напрямую у ЮKassa — не доверяем данным из тела webhook
    const payment = await verifyPayment(paymentId);
    if (!payment || payment.status !== 'succeeded') {
      console.warn('[webhook] payment not succeeded:', paymentId, payment?.status);
      return res.status(200).end(); // отвечаем 200 чтобы ЮKassa не ретраила
    }

    const userId = payment.metadata?.userId;
    const amount = payment.amount?.value;

    if (!userId) {
      console.warn('[webhook] no userId in payment metadata:', paymentId);
      return res.status(200).end();
    }

    const ok = await activatePro(userId);
    await logPayment({ userId, paymentId, amount, status: ok ? 'activated' : 'activation_failed' });

    if (!ok) {
      console.error('[webhook] failed to activate Pro for userId:', userId);
    }

    return res.status(200).end();
  } catch (e) {
    console.error('[webhook] error:', e);
    // Всегда 200 — иначе ЮKassa будет ретраить
    return res.status(200).end();
  }
}
