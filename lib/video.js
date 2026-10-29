/* ============================================================================
   HarmonyAI — онлайн-кинотеатр (только сервер): поиск фильмов, сериалов,
   серий и роликов в VK Видео и YouTube.

   Источники:
     • VK Видео — основной. Метод video.search работает ТОЛЬКО с ключом
       пользователя VK (сервисный ключ приложения не подходит). Ключ один на
       весь сервер:
         – VK_USER_TOKEN — готовый «вечный» ключ (если он у вас есть);
         – или вход через VK ID: VK_ID_CLIENT_ID + кнопка «Подключить VK к
           серверу» в Плагинах (видна только персоналу). Сервер сам продлевает
           ключ refresh-токеном и хранит его зашифрованным в Supabase
           (таблица app_secrets, см. supabase/2026-10-29-video.sql).
     • YouTube — дополнительный, включается ключом YOUTUBE_API_KEY
       (YouTube Data API v3). Без ключа просто не участвует.

   Видео показывается только официальными встраиваемыми плеерами площадок
   (VK video_ext.php, YouTube embed) — права и реклама остаются за ними, мы
   ничего не скачиваем и не перекодируем.

   Разбор названий («2 сезон 5 серия», «S02E05», «LostFilm», «Оригинал»)
   вынесен в чистые функции — их проверяют тесты.
   ============================================================================ */

import crypto from 'node:crypto';

// VK_API_BASE / YOUTUBE_API_BASE — только для стенда с заглушками.
const vkApiBase = () => readEnv('VK_API_BASE') || 'https://api.vk.com/method';
const VK_V = '5.199';
const VKID_TOKEN_URL = 'https://id.vk.com/oauth2/auth';
const ytApiBase = () => readEnv('YOUTUBE_API_BASE') || 'https://www.googleapis.com/youtube/v3';

export function readEnv(name) {
  const v = String(process.env[name] || '').trim();
  return /^(undefined|null|your_key_here)$/i.test(v) ? '' : v;
}

function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })
  ]).finally(() => clearTimeout(t));
}

/* ------------------------------------------------------- разбор названий */

const LTR = 'a-zа-яё0-9';

/* Озвучки: ключ — как показываем, шаблон — как ищем в названии. Порядок важен:
   студии раньше общих слов («Дубляж»), иначе «LostFilm дубляж» станет «Дубляж». */
const VOICES = [
  ['LostFilm', /lost\s*film|лостфильм/i],
  ['AlexFilm', /alex\s*film/i],
  ['HDRezka', /hd\s*rezka|rezka|резка/i],
  ['NewStudio', /new\s*studio/i],
  ['Кубик в Кубе', /кубик\s+в\s+кубе|kubik/i],
  ['Jaskier', /jaskier|яскер/i],
  ['TVShows', /tv\s*shows/i],
  ['BaibaKo', /baibako|байбако/i],
  ['Кураж-Бамбей', /кураж|бамбей/i],
  ['Amedia', /amedia|амедиа/i],
  ['Пифагор', /пифагор|pifagor/i],
  ['Red Head Sound', /red\s*head\s*sound|rhs/i],
  ['ColdFilm', /cold\s*film/i],
  ['Flarrow Films', /flarrow/i],
  ['Гоблин', /гоблин|goblin|пучков/i],
  ['AniLibria', /anilibria|анилибри/i],
  ['AniDub', /anidub|анидаб/i],
  ['Студийная Банда', /студийная\s+банда/i],
  ['Дубляж', /дубляж|дублир|dub(?:bed|bing)?(?![a-z])/i],
  ['Многоголосый', /многоголос/i],
  ['Двухголосый', /двухголос/i],
  ['Одноголосый', /одноголос|авторск/i],
  ['Субтитры', /субтитр|subtitle|\bsub\b/i],
  ['Оригинал', /оригинал|original|\beng(?:lish)?\b|\bvo\b|англ/i]
];

export function detectVoice(title) {
  const t = String(title || '');
  for (const [name, re] of VOICES) if (re.test(t)) return name;
  return '';
}

export function voiceLang(voice) {
  return voice === 'Оригинал' || voice === 'Субтитры' ? 'en' : (voice ? 'ru' : '');
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 5000 ? n : 0; }

/* Сезон и серия из названия: «2 сезон 5 серия», «Сезон 2 Серия 5», «S02E05»,
   «2x05», «5 серия 2 сезона», «серия 5». */
export function parseEpisode(title) {
  const t = String(title || '').toLowerCase().replace(/ё/g, 'е');
  let season = 0, episode = 0, m;
  if ((m = t.match(/(?:^|[^a-z0-9])s(\d{1,2})\s*[ .-]?\s*e(\d{1,4})(?![0-9])/i))) { season = num(m[1]); episode = num(m[2]); }
  else if ((m = t.match(/(?:^|[^0-9])(\d{1,2})\s*[xх]\s*(\d{1,3})(?![0-9])/))) { season = num(m[1]); episode = num(m[2]); }
  if (!season && (m = t.match(new RegExp('(\\d{1,2})\\s*(?:-?й\\s*)?сезон(?![' + LTR + '])|сезон\\s*№?\\s*(\\d{1,2})')))) season = num(m[1] || m[2]);
  // «Серия 12» раньше «12 серия»: в «Сезон 1 Серия 12» число перед словом — это сезон.
  if (!episode && (m = t.match(/(?:серия|эпизод|episode|ep\.?)\s*№?\s*(\d{1,4})(?![0-9])(?!\s*(?:-?[йя]\s*)?сезон)/))) episode = num(m[1]);
  if (!episode && (m = t.match(new RegExp('(\\d{1,4})\\s*(?:-?я\\s*)?(?:серия|эпизод)(?![' + LTR + '])')))) episode = num(m[1]);
  return { season, episode };
}

/* «Чистое» название для сравнения: без сезонов, серий, озвучек, качества и мусора. */
export function baseTitle(title) {
  return String(title || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/(?:^|[^a-z0-9])s\d{1,2}\s*e\d{1,4}/gi, ' ')
    .replace(/\d{1,2}\s*[xх]\s*\d{1,3}/g, ' ')
    .replace(new RegExp('\\d{1,4}\\s*(?:-?[йя]\\s*)?(?:сезон\\w*|серия|эпизод)|(?:сезон\\w*|серия|эпизод|episode)\\s*№?\\s*\\d{1,4}', 'g'), ' ')
    .replace(/\b(?:2160|1440|1080|720|480|360)p?\b|\b(?:4k|hd|fullhd|uhd|hdr)\b/gi, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* Похоже ли название ролика на искомое: все значимые слова запроса на месте. */
export function titleMatches(title, wanted) {
  const words = baseTitle(wanted).split(' ').filter(w => w.length > 1 || /\d/.test(w));
  if (!words.length) return true;
  const hay = ' ' + baseTitle(title) + ' ';
  const hit = words.filter(w => hay.includes(' ' + w + ' ') || (w.length > 4 && hay.includes(' ' + w.slice(0, -2)))).length;
  return hit / words.length >= 0.75;
}

export function fmtQuery({ title = '', year = 0, season = 0, episode = 0, voice = '', kind = '' } = {}) {
  const parts = [String(title || '').trim()];
  if (season) parts.push(season + ' сезон');
  if (episode) parts.push(episode + ' серия');
  if (!season && !episode && year && (kind === 'movie' || kind === 'cartoon')) parts.push(String(year));
  if (voice && voice !== 'Дубляж' && voice !== 'Оригинал') parts.push(voice);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------- хранение ключей */

function encKey() {
  const raw = readEnv('VIDEO_ENCRYPTION_KEY') || readEnv('MUSIC_ENCRYPTION_KEY');
  return raw ? crypto.createHash('sha256').update('video:' + raw).digest() : null;
}
function seal(plain) {
  const key = encKey();
  if (!key) throw new Error('MUSIC_ENCRYPTION_KEY не настроен');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function unseal(packed) {
  const key = encKey();
  const p = String(packed || '').split('.');
  if (!key || p.length !== 4 || p[0] !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p[1], 'base64url'));
    d.setAuthTag(Buffer.from(p[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64url')), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}

async function sb(path, init = {}) {
  const base = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return null;
  const r = await withTimeout(fetch(base + path, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  }), 8000, 'supabase timeout');
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
  return r.status === 204 ? null : r.json().catch(() => null);
}

const SECRET_NAME = 'vk_video_server';
async function loadVkSecret() {
  const rows = await sb(`/rest/v1/app_secrets?name=eq.${SECRET_NAME}&select=value_enc,updated_at&limit=1`);
  const raw = rows && rows[0] ? unseal(rows[0].value_enc) : '';
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function saveVkSecret(obj) {
  await sb('/rest/v1/app_secrets?on_conflict=name', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ name: SECRET_NAME, value_enc: seal(JSON.stringify(obj)), updated_at: new Date().toISOString() })
  });
}

/* ---------------------------------------------------------- ключ VK */

let vkCache = { token: '', until: 0 };
let vkRefreshing = null;

async function vkidPost(params) {
  const body = new URLSearchParams(params);
  const r = await withTimeout(fetch(VKID_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  }), 10000, 'vkid timeout');
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const err = new Error(data.error_description || data.error || ('VK ID ' + r.status));
    err.code = data.error || 'vkid_error';
    throw err;
  }
  return data;
}

function tokenRecord(data, prev = {}) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token || '',
    device_id: data.device_id || prev.device_id || '',
    user_id: data.user_id || prev.user_id || '',
    expires_at: Date.now() + Math.max(300, Number(data.expires_in) || 3600) * 1000
  };
}

/* Ключ VK для video.search. null — видео из VK недоступно (не настроено). */
export async function vkToken() {
  const fixed = readEnv('VK_USER_TOKEN');
  if (fixed) return fixed;
  if (vkCache.token && Date.now() < vkCache.until) return vkCache.token;
  if (vkRefreshing) return vkRefreshing;
  vkRefreshing = (async () => {
    try {
      const rec = await loadVkSecret().catch(() => null);
      if (!rec || !rec.access_token) return null;
      if (Date.now() < (rec.expires_at || 0) - 120000) {
        vkCache = { token: rec.access_token, until: Math.min(rec.expires_at - 120000, Date.now() + 10 * 60 * 1000) };
        return rec.access_token;
      }
      const clientId = readEnv('VK_ID_CLIENT_ID');
      if (!clientId || !rec.refresh_token) return null;
      const data = await vkidPost({
        grant_type: 'refresh_token', refresh_token: rec.refresh_token, client_id: clientId,
        device_id: rec.device_id || '', state: crypto.randomBytes(12).toString('hex')
      });
      const next = tokenRecord(data, rec);
      await saveVkSecret(next).catch((e) => console.warn('[video] save refreshed token failed', e.message));
      vkCache = { token: next.access_token, until: next.expires_at - 120000 };
      return next.access_token;
    } catch (e) {
      console.warn('[video] vk token unavailable:', e.message);
      return null;
    } finally { vkRefreshing = null; }
  })();
  return vkRefreshing;
}

/* Обмен кода VK ID (PKCE) на ключи — кнопка «Подключить VK к серверу». */
export async function vkConnect({ code, codeVerifier, deviceId, redirectUri, state }) {
  const clientId = readEnv('VK_ID_CLIENT_ID');
  if (!clientId) throw new Error('VK_ID_CLIENT_ID не задан в Vercel');
  const data = await vkidPost({
    grant_type: 'authorization_code', code, code_verifier: codeVerifier, client_id: clientId,
    device_id: deviceId, redirect_uri: redirectUri, state: state || crypto.randomBytes(12).toString('hex')
  });
  const rec = tokenRecord({ ...data, device_id: deviceId });
  await saveVkSecret(rec);
  vkCache = { token: rec.access_token, until: rec.expires_at - 120000 };
  // Проверяем, что ключ правда ищет видео.
  const probe = await vkCall('video.search', { q: 'музыка', count: 1 }, rec.access_token).catch((e) => ({ error: e.message }));
  return { ok: !probe.error, userId: rec.user_id, error: probe.error || '' };
}

export async function videoStatus() {
  let vk = Boolean(readEnv('VK_USER_TOKEN'));
  if (!vk) { try { const rec = await loadVkSecret(); vk = Boolean(rec && rec.access_token); } catch (e) { vk = false; } }
  return {
    vk,
    youtube: Boolean(readEnv('YOUTUBE_API_KEY')),
    vkid: { clientId: readEnv('VK_ID_CLIENT_ID') || '', fixedToken: Boolean(readEnv('VK_USER_TOKEN')) }
  };
}

/* ---------------------------------------------------------- VK Видео */

async function vkCall(method, params, token) {
  const tk = token || await vkToken();
  if (!tk) { const e = new Error('VK не подключён'); e.code = 'vk_not_configured'; throw e; }
  const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), access_token: tk, v: VK_V });
  const r = await withTimeout(fetch(`${vkApiBase()}/${method}`, { method: 'POST', body }), 9000, 'vk timeout');
  const data = await r.json().catch(() => ({}));
  if (data.error) {
    const e = new Error(data.error.error_msg || 'VK error');
    e.code = 'vk_' + data.error.error_code;
    if ([5, 27, 28].includes(Number(data.error.error_code))) vkCache = { token: '', until: 0 };
    throw e;
  }
  return data.response;
}

function bestImage(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => (b.width || 0) - (a.width || 0));
  const pick = arr.find(x => (x.width || 0) <= 800) || arr[arr.length - 1] || arr[0];
  return pick ? pick.url : '';
}

export function mapVkItem(v) {
  if (!v || !v.player || v.content_restricted || v.is_private) return null;
  const { season, episode } = parseEpisode(v.title);
  const voice = detectVoice(v.title + ' ' + String(v.description || '').slice(0, 200));
  let embed = String(v.player);
  if (!/video_e(?:xt|mbed)\.php/.test(embed)) return null; // внешний плеер (YouTube внутри VK) — пропускаем
  embed = embed.replace(/^http:/, 'https:');
  return {
    source: 'vk',
    id: `${v.owner_id}_${v.id}`,
    title: String(v.title || '').trim(),
    description: String(v.description || '').slice(0, 400),
    duration: Number(v.duration) || 0,
    image: bestImage(v.image) || bestImage(v.first_frame),
    embed,
    views: Number(v.views) || 0,
    date: Number(v.date) || 0,
    height: Number(v.height) || 0,
    season, episode, voice, lang: voiceLang(voice)
  };
}

export async function vkSearch(q, { count = 30, long = false, offset = 0 } = {}) {
  const res = await vkCall('video.search', {
    q, count, offset, sort: 2, adult: 0, ...(long ? { filters: 'long' } : {})
  });
  return (res && Array.isArray(res.items) ? res.items : []).map(mapVkItem).filter(Boolean);
}

/* ---------------------------------------------------------- YouTube */

function isoDur(s) {
  const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function decodeEntities(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export async function ytSearch(q, { count = 12, long = false, lang = 'ru' } = {}) {
  const key = readEnv('YOUTUBE_API_KEY');
  if (!key) return [];
  const p = new URLSearchParams({
    part: 'snippet', q, type: 'video', maxResults: String(Math.min(25, count)), videoEmbeddable: 'true',
    safeSearch: 'moderate', relevanceLanguage: lang === 'en' ? 'en' : 'ru', key
  });
  if (long) p.set('videoDuration', 'long');
  const r = await withTimeout(fetch(`${ytApiBase()}/search?${p}`), 9000, 'yt timeout');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.warn('[video] youtube', r.status, JSON.stringify(data.error || {}).slice(0, 160)); return []; }
  const ids = (data.items || []).map(x => x.id && x.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const d = await withTimeout(fetch(`${ytApiBase()}/videos?${new URLSearchParams({ part: 'contentDetails,statistics', id: ids.join(','), key })}`), 9000, 'yt timeout')
    .then(x => x.json()).catch(() => ({}));
  const extra = {};
  (d.items || []).forEach(x => { extra[x.id] = x; });
  return (data.items || []).map((x) => {
    const id = x.id && x.id.videoId;
    if (!id) return null;
    const s = x.snippet || {};
    const title = decodeEntities(s.title);
    const { season, episode } = parseEpisode(title);
    const voice = detectVoice(title);
    const th = s.thumbnails || {};
    return {
      source: 'yt', id, title,
      description: decodeEntities(s.description).slice(0, 400),
      duration: isoDur(extra[id]?.contentDetails?.duration),
      image: (th.high || th.medium || th.default || {}).url || '',
      embed: `https://www.youtube.com/embed/${id}`,
      views: Number(extra[id]?.statistics?.viewCount) || 0,
      date: Date.parse(s.publishedAt || '') / 1000 || 0,
      channel: decodeEntities(s.channelTitle),
      captions: extra[id]?.contentDetails?.caption === 'true',
      season, episode, voice, lang: voice ? voiceLang(voice) : (lang === 'en' ? 'en' : '')
    };
  }).filter(Boolean);
}

/* ---------------------------------------------------------- подбор */

const KINDS = new Set(['movie', 'series', 'episode', 'cartoon', 'anime', 'video', 'trailer']);

export function normalizeIntent(raw = {}) {
  const kind = KINDS.has(raw.kind) ? raw.kind : 'video';
  const season = num(raw.season), episode = num(raw.episode);
  return {
    kind: episode && kind !== 'video' && kind !== 'trailer' ? 'episode' : kind,
    title: String(raw.title || raw.query || '').trim().slice(0, 120),
    title_en: String(raw.title_en || '').trim().slice(0, 120),
    franchise: String(raw.franchise || '').trim().slice(0, 80),
    year: num(raw.year) > 1880 ? num(raw.year) : 0,
    season: season || (episode ? 1 : 0),
    episode,
    voice: String(raw.voice || '').trim().slice(0, 40),
    query: String(raw.query || '').trim().slice(0, 160)
  };
}

function longEnough(item, kind) {
  if (kind === 'movie' || kind === 'cartoon') return item.duration >= 40 * 60 || !item.duration;
  if (kind === 'episode' || kind === 'series' || kind === 'anime') return item.duration >= 8 * 60 || !item.duration;
  return true;
}

function sameVoice(a, b) {
  if (!b) return true;
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  return x === y || (y === 'оригинал' && voiceLang(a) === 'en') || (y === 'english' && voiceLang(a) === 'en');
}

/* Оценка ролика: совпадение названия, нужная серия, озвучка, длительность, просмотры. */
export function scoreItem(item, intent) {
  let s = 0;
  if (titleMatches(item.title, intent.title) || (intent.title_en && titleMatches(item.title, intent.title_en))) s += 40;
  if (intent.episode) {
    if (item.episode === intent.episode && (!intent.season || !item.season || item.season === intent.season)) s += 50;
    else if (item.episode) s -= 30;
  }
  if (intent.season && item.season && item.season !== intent.season) s -= 20;
  if (intent.voice) s += sameVoice(item.voice, intent.voice) ? 15 : -5;
  else if (item.lang === 'en') s -= 6; // по умолчанию — русская озвучка
  if (!longEnough(item, intent.kind)) s -= 35;
  if (intent.kind === 'trailer') s += /трейлер|trailer|тизер/i.test(item.title) ? 25 : -10;
  else if (/трейлер|trailer|тизер|обзор|реакция|reaction|разбор|shorts/i.test(item.title)) s -= 25;
  if (intent.year && new RegExp('(?:^|\\D)' + intent.year + '(?:\\D|$)').test(item.title)) s += 6;
  s += Math.min(12, Math.log10((item.views || 0) + 1) * 2);
  if (item.source === 'vk') s += 2;
  return s;
}

/* Серии одного сезона: по одной на номер (лучшая по оценке). */
export function collectEpisodes(items, intent) {
  const by = new Map();
  for (const it of items) {
    if (!it.episode || !titleMatches(it.title, intent.title)) continue;
    if (intent.season && it.season && it.season !== intent.season) continue;
    const prev = by.get(it.episode);
    if (!prev || it._score > prev._score) by.set(it.episode, it);
  }
  return [...by.values()].sort((a, b) => a.episode - b.episode).slice(0, 60);
}

/* Варианты озвучки той же серии/фильма. */
export function collectVoices(items, best, intent) {
  const out = new Map();
  for (const it of items) {
    if (!titleMatches(it.title, intent.title) && !(intent.title_en && titleMatches(it.title, intent.title_en))) continue;
    if (best.episode && it.episode !== best.episode) continue;
    if (!longEnough(it, intent.kind)) continue;
    const key = it.voice || (it.lang === 'en' ? 'Оригинал' : 'Без пометки');
    const prev = out.get(key);
    if (!prev || it._score > prev._score) out.set(key, it);
  }
  return [...out.entries()].map(([voice, item]) => ({ voice, lang: voiceLang(voice) || 'ru', item }));
}

function strip(it) { if (!it) return it; const { _score, ...rest } = it; return rest; }

/* Главный поиск: по разбору запроса (intent) ищем в VK и YouTube параллельно. */
export async function findVideos(rawIntent, { allowYoutube = true } = {}) {
  const intent = normalizeIntent(rawIntent);
  if (!intent.title && !intent.query) return { ok: false, error: 'empty', intent, items: [] };
  const long = intent.kind === 'movie' || intent.kind === 'cartoon';
  const ruQuery = intent.query && intent.kind === 'video' ? intent.query : fmtQuery(intent);
  const listQuery = (intent.kind === 'series' || intent.kind === 'episode' || intent.kind === 'anime')
    ? fmtQuery({ title: intent.title, season: intent.season || 1, voice: intent.voice }) : '';
  const enTitle = intent.title_en || '';

  const jobs = [
    vkSearch(ruQuery, { count: 40, long }).catch(e => ({ error: e })),
    listQuery && listQuery !== ruQuery ? vkSearch(listQuery, { count: 80 }).catch(() => []) : Promise.resolve([]),
    allowYoutube ? ytSearch(ruQuery, { long }).catch(() => []) : Promise.resolve([]),
    allowYoutube && enTitle ? ytSearch(fmtQuery({ ...intent, title: enTitle, voice: '' }), { long, lang: 'en', count: 6 }).catch(() => []) : Promise.resolve([]),
    // Оригинальная озвучка из VK — чтобы в «Дубляже» был английский вариант.
    enTitle && intent.kind !== 'video' ? vkSearch(fmtQuery({ ...intent, title: enTitle, voice: '' }), { count: 15, long }).catch(() => []) : Promise.resolve([])
  ];
  const [vkMain, vkList, yt, ytEn, vkEn] = await Promise.all(jobs);
  const vkError = vkMain && vkMain.error ? vkMain.error : null;
  const seen = new Set();
  const all = [];
  for (const it of [].concat(Array.isArray(vkMain) ? vkMain : [], vkList, yt, ytEn, vkEn.map(x => ({ ...x, lang: x.lang || 'en', voice: x.voice || 'Оригинал' })))) {
    const k = it.source + ':' + it.id;
    if (seen.has(k)) continue;
    seen.add(k);
    it._score = scoreItem(it, intent);
    all.push(it);
  }
  all.sort((a, b) => b._score - a._score);
  const best = all[0] || null;
  if (!best) {
    return {
      ok: false, intent, items: [],
      error: vkError ? (vkError.code === 'vk_not_configured' ? 'vk_not_configured' : 'vk_error') : 'not_found',
      youtube: Boolean(readEnv('YOUTUBE_API_KEY'))
    };
  }
  const episodes = (intent.kind === 'series' || intent.kind === 'episode' || intent.kind === 'anime') ? collectEpisodes(all, intent) : [];
  const voices = intent.kind === 'video' ? [] : collectVoices(all, best, intent);
  return {
    ok: true, intent,
    best: strip(best),
    items: all.slice(0, 12).map(strip),
    episodes: episodes.map(strip),
    voices: voices.map(v => ({ voice: v.voice, lang: v.lang, item: strip(v.item) })),
    youtube: Boolean(readEnv('YOUTUBE_API_KEY'))
  };
}
