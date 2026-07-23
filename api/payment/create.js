/* ============================================================================
   POST /api/payment/create
   Тело: { userId, email? }
   Ответ: { confirmationUrl }  — редиректим пользователя на страницу ЮKassa.
   ============================================================================ */

export const config = { maxDuration: 15 };

const ALLOWED_HOSTS = ['harmonyai-zeta.vercel.app', 'localhost', '127.0.0.1'];
function originAllowed(req) {
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

function readEnv(n) { return String(process.env[n] || '').trim(); }

function yookassaAuth() {
  const shopId = readEnv('YOOKASSA_SHOP_ID');
  const secret = readEnv('YOOKASSA_SECRET_KEY');
  if (!shopId || !secret) throw new Error('YooKassa credentials not configured');
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const { userId, email = '' } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const idempotenceKey = `${userId}-${Date.now()}`;
    const returnUrl = (readEnv('SITE_URL') || 'https://harmonyai-zeta.vercel.app') + '/subscribe?success=1&uid=' + encodeURIComponent(userId);

    const body = {
      amount: { value: '299.00', currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: returnUrl },
      capture: true,
      description: 'HarmonyAI Pro — подписка на 1 месяц',
      metadata: { userId },
      ...(email ? { receipt: { customer: { email }, items: [{ description: 'HarmonyAI Pro', quantity: '1', amount: { value: '299.00', currency: 'RUB' }, vat_code: 1 }] } } : {})
    };

    const ykRes = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': yookassaAuth(),
        'Idempotence-Key': idempotenceKey
      },
      body: JSON.stringify(body)
    });

    const data = await ykRes.json().catch(() => null);

    if (!ykRes.ok || !data?.confirmation?.confirmation_url) {
      console.error('[payment/create] YooKassa error:', data);
      return res.status(502).json({ error: data?.description || 'Ошибка платёжного сервиса' });
    }

    return res.status(200).json({ confirmationUrl: data.confirmation.confirmation_url, paymentId: data.id });
  } catch (e) {
    console.error('[payment/create]', e);
    return res.status(500).json({ error: e?.message || 'Внутренняя ошибка' });
  }
}
