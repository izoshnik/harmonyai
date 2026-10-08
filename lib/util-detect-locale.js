/* ============================================================================
   Задача 7: Автоматическое определение языка по IP
   Возвращает { country, countryCode, city, lang }
   Используется при регистрации для автоустановки языка интерфейса.
   ============================================================================ */
// Карта стран → язык интерфейса
const COUNTRY_LANG = {
  // Русскоязычные
  RU: 'ru', BY: 'ru', KZ: 'ru', UA: 'ru', KG: 'ru', TJ: 'ru', TM: 'ru', UZ: 'ru', MD: 'ru', AM: 'ru', AZ: 'ru', GE: 'ru',
  // Немецкоязычные
  DE: 'de', AT: 'de', CH: 'de', LI: 'de', LU: 'de',
  // Испаноязычные
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', PE: 'es', VE: 'es', CL: 'es', EC: 'es', GT: 'es',
  BO: 'es', CU: 'es', DO: 'es', HN: 'es', PY: 'es', SV: 'es', NI: 'es', CR: 'es', PA: 'es', UY: 'es',
  // Французскоязычные
  FR: 'fr', BE: 'fr', CD: 'fr', CI: 'fr', CM: 'fr', SN: 'fr', MG: 'fr', BF: 'fr', ML: 'fr', NE: 'fr',
  GN: 'fr', BJ: 'fr', TG: 'fr', GA: 'fr', CF: 'fr', CG: 'fr', TD: 'fr', BI: 'fr', RW: 'fr', DJ: 'fr',
  KM: 'fr', SC: 'fr', PM: 'fr', MQ: 'fr', GP: 'fr', GF: 'fr', RE: 'fr', YT: 'fr', PF: 'fr', NC: 'fr', MC: 'fr',
  // Итальяноязычные
  IT: 'it', SM: 'it', VA: 'it',
  // Китайскоязычные
  CN: 'zh', TW: 'zh', HK: 'zh', MO: 'zh', SG: 'zh',
};

const SUPPORTED_LANGS = ['ru', 'en', 'de', 'es', 'fr', 'it', 'zh'];

function langFor(countryCode) {
  const l = COUNTRY_LANG[countryCode] || 'en';
  return SUPPORTED_LANGS.includes(l) ? l : 'en';
}

// Vercel сам кладёт страну посетителя в заголовок — без внешнего запроса.
function headerCountry(req) {
  const c = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ?lite=1 — только язык интерфейса (сайт при первом визите): страна из
  // заголовка Vercel, без медленного внешнего гео-запроса.
  const hc = req.query?.ip ? '' : headerCountry(req);
  if (req.query?.lite && hc) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ countryCode: hc, lang: langFor(hc) });
  }

  // Приоритет: параметр ?ip= (для тестирования), затем реальный IP запроса
  const ip = req.query?.ip || getClientIp(req);

  // Не определяем для локальных IP
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return res.status(200).json({ country: null, countryCode: hc || null, city: null, lang: hc ? langFor(hc) : null });
  }

  try {
    // Бесплатный сервис, не требует API-ключа
    const geoResp = await Promise.race([
      fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city&lang=ru`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Geo lookup timed out')), 5000))
    ]);

    if (!geoResp.ok) {
      return res.status(200).json({ country: null, countryCode: hc || null, city: null, lang: hc ? langFor(hc) : null });
    }

    const geo = await geoResp.json();

    if (geo.status !== 'success') {
      return res.status(200).json({ country: null, countryCode: hc || null, city: null, lang: hc ? langFor(hc) : null });
    }

    const countryCode = String(geo.countryCode || '').toUpperCase() || hc;
    const lang = langFor(countryCode);

    return res.status(200).json({
      country: geo.country || null,
      countryCode: countryCode || null,
      city: geo.city || null,
      lang
    });
  } catch (e) {
    console.warn('[detect-locale] geo lookup failed:', e?.message);
    // Страна неизвестна — lang:null, клиент возьмёт язык браузера
    return res.status(200).json({ country: null, countryCode: hc || null, city: null, lang: hc ? langFor(hc) : null });
  }
}
