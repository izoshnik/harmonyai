/* ============================================================================
   ПОИСК В ИНТЕРНЕТЕ ДЛЯ ЧАТА — цепочка поисковиков.

   Раньше был только DuckDuckGo (HTML-страница). С серверов Vercel он отвечает
   кодом 202 — страница-заглушка от ботов, ноль результатов, и модель отвечала
   по памяти (устаревшие цифры). Теперь по порядку:
     1. Tavily        — TAVILY_API_KEY (поиск для ИИ, сразу отдаёт текст страниц);
     2. Brave Search  — BRAVE_SEARCH_API_KEY;
     3. DuckDuckGo    — без ключа, если вдруг ответит;
     4. Википедия     — без ключа: хотя бы проверенные справочные факты.
   Первый поисковик, вернувший результаты, побеждает.
   ============================================================================ */

function readEnv(name) {
  const v = String(process.env[name] || '').trim();
  return /^(undefined|null|your_key_here)$/i.test(v) ? '' : v;
}

function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

function strip(html = '') {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/* Поисковый запрос из вопроса: без вежливых слов и просьб, не длиннее 200 символов. */
export function searchQueryFrom(text = '') {
  return String(text || '')
    .replace(/\[ФАЙЛ \d+:[\s\S]*$/, '')
    .replace(/(^|\s)(пожалуйста|плиз|подскажи(те)?|скажи(те)?|расскажи(те)?|найди(те)?|поищи(те)?|в интернете|загугли|погугли|можешь|можно)(?=[\s,.!?]|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

const UA = 'Mozilla/5.0 (compatible; HarmonyAIBot/1.5; +https://harmonyai.ru)';

async function tavily(q, max) {
  const key = readEnv('TAVILY_API_KEY');
  if (!key) return null;
  const r = await withTimeout(fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ api_key: key, query: q, max_results: max, search_depth: 'advanced', include_answer: false, topic: 'general' })
  }), 9000, 'tavily timeout');
  if (!r.ok) { console.warn('[web-search] tavily', r.status); return null; }
  const d = await r.json().catch(() => ({}));
  return (d.results || []).map((x) => ({ url: x.url, title: x.title || x.url, snippet: String(x.content || '').slice(0, 600), content: String(x.raw_content || x.content || '').slice(0, 6000) }));
}

async function brave(q, max) {
  const key = readEnv('BRAVE_SEARCH_API_KEY');
  if (!key) return null;
  const p = new URLSearchParams({ q, count: String(max), safesearch: 'moderate' });
  const r = await withTimeout(fetch(`https://api.search.brave.com/res/v1/web/search?${p}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key }
  }), 8000, 'brave timeout');
  if (!r.ok) { console.warn('[web-search] brave', r.status); return null; }
  const d = await r.json().catch(() => ({}));
  return ((d.web && d.web.results) || []).map((x) => ({
    url: x.url, title: strip(x.title) || x.url,
    snippet: strip([x.description].concat(x.extra_snippets || []).join(' ')).slice(0, 800)
  }));
}

async function duckduckgo(q, max) {
  const r = await withTimeout(fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' }
  }), 6000, 'ddg timeout');
  if (r.status !== 200) return null; // 202 — заглушка от ботов
  const html = await r.text();
  const out = [], seen = new Set();
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    let url = m[1];
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch (e) { /* как есть */ } }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: strip(m[2]) || url, snippet: strip(m[3]) });
  }
  return out;
}

async function wikipedia(q, max) {
  const lang = /[а-яё]/i.test(q) ? 'ru' : 'en';
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const p = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: q, gsrlimit: String(Math.min(3, max)),
    prop: 'extracts|info', exintro: '1', explaintext: '1', exlimit: '3', inprop: 'url', format: 'json', origin: '*'
  });
  const r = await withTimeout(fetch(`${base}?${p}`, { headers: { 'User-Agent': UA + ' (contact: support@harmonyai.ru)' } }), 6000, 'wiki timeout');
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const pages = Object.values((d.query && d.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((x) => ({ url: x.fullurl, title: x.title + ' — Википедия', snippet: String(x.extract || '').slice(0, 600), content: String(x.extract || '').slice(0, 4000) }))
    .filter((x) => x.url && x.snippet && titleInQuery(x.title.replace(/ — Википедия$/, ''), q));
}

/* Википедия ищет по тексту статей и легко подсовывает постороннее («Влад А4»
   на вопрос про MrBeast). Берём статью, только если её название есть в вопросе. */
function titleInQuery(title, q) {
  const hay = ' ' + String(q).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ') + ' ';
  const words = String(title).toLowerCase().replace(/ё/g, 'е').replace(/\([^)]*\)/g, ' ').split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4);
  return words.some((w) => hay.includes(' ' + w) || hay.includes(' ' + w.slice(0, Math.max(4, w.length - 2))));
}

const PROVIDERS = [['tavily', tavily], ['brave', brave], ['duckduckgo', duckduckgo], ['wikipedia', wikipedia]];

/* → { provider, results:[{url,title,snippet,content?}] } */
export async function searchWeb(text, { max = 6 } = {}) {
  const q = searchQueryFrom(text);
  if (!q) return { provider: '', results: [] };
  for (const [name, fn] of PROVIDERS) {
    try {
      const res = await fn(q, max);
      if (res && res.length) return { provider: name, results: res.slice(0, max) };
    } catch (e) {
      console.warn('[web-search]', name, 'failed:', String(e && e.message || e).slice(0, 160));
    }
  }
  return { provider: '', results: [] };
}

export function hasSearchKey() {
  return Boolean(readEnv('TAVILY_API_KEY') || readEnv('BRAVE_SEARCH_API_KEY'));
}
