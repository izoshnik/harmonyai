/* ===== ЕДИНЫЙ СПИСОК РАЗРЕШЁННЫХ ИСТОЧНИКОВ =====
   Раньше массив ALLOWED_HOSTS был скопирован в четыре функции, и при появлении
   нового домена (harmonyai.ru + api.harmonyai.ru) пришлось бы править каждую.
   Теперь список один. Логика проверки не изменилась: запрос без Origin/Referer
   пропускаем (мобильные webview их не присылают), same-origin — всегда разрешён,
   иначе хост должен совпасть с записью в списке или быть её поддоменом. */

export const ALLOWED_HOSTS = [
  'harmonyai.ru',
  'api.harmonyai.ru',
  'harmonyai-zeta.vercel.app',
  'localhost',
  '127.0.0.1'
];

export function originAllowed(req) {
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    const selfHost = String(req.headers.host || '').split(':')[0];
    if (selfHost && host === selfHost) return true; // same-origin всегда разрешён
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

/* Адрес сайта для return_url и ссылок в письмах/документации. */
export function siteUrl() {
  const raw = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  return raw || 'https://harmonyai.ru';
}

/* Публичный адрес API-шлюза (для документации и /v1/models). */
export function apiUrl() {
  const raw = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return raw || 'https://api.harmonyai.ru';
}
