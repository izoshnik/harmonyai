const SCREENSHOT_ORIGIN = 'https://harmonyai.ru';
const MAX_SCREENSHOT_BYTES = 420 * 1024;

export function screenshotTarget(query) {
  const text = String(query || '').trim();
  if (!/^(?:пожалуйста[ ,]+)?(?:сделай|сними|покажи|прикрепи|пришли)\s+(?:мне\s+)?скриншот|^(?:take|capture|show)\s+(?:a\s+)?screenshot/iu.test(text)) return null;
  const link = text.match(/https?:\/\/[^\s<>"»]+/i)?.[0]?.replace(/[.,;!]+$/, '');
  const url = URL.parse(link || SCREENSHOT_ORIGIN);
  if (!url || url.origin !== SCREENSHOT_ORIGIN || url.username || url.password) return { error: 'Снимки доступны для публичных страниц harmonyai.ru.' };
  const pathname = /^\/(?:chat|login|help|about|contacts|subscribe|api)?\/?$/.test(url.pathname) ? url.pathname : null;
  if (!pathname || url.search || url.hash) return { error: 'Для снимка нужна ссылка на публичную страницу HarmonyAI без параметров.' };
  return { url: url.origin + pathname };
}

export async function capturePage(url, token = process.env.SION_BROWSER_TOKEN) {
  if (!token) return { error: 'Браузер для снимков пока не настроен.' };
  const endpoint = new URL('https://production-sfo.browserless.io/screenshot');
  endpoint.searchParams.set('token', token);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, options: { type: 'jpeg', quality: 65 }, gotoOptions: { waitUntil: 'domcontentloaded', timeout: 15000 } }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok || !/^image\/jpeg\b/i.test(response.headers.get('content-type') || '')) throw Error('invalid image response');
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SCREENSHOT_BYTES) throw Error('image too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!size) throw Error('empty image');
    return { url, image: 'data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64') };
  } catch {
    return { error: 'Браузер не вернул снимок страницы. Попробуй ещё раз.' };
  }
}
