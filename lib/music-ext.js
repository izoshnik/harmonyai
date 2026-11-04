/* ============================================================================
   ВТОРОЙ МУЗЫКАЛЬНЫЙ ИСТОЧНИК: Audius + Jamendo (рядом с Яндекс Музыкой).

   Оба каталога легально отдают полный поиск, прослушивание и — где разрешил
   автор — скачивание через открытый API:
     • Audius  — независимые артисты (электроника, хип-хоп, инди). Ключ не
       обязателен (app_name=HarmonyAI); AUDIUS_API_KEY — если выдан план с
       ключом. AUDIUS_API_BASE переопределяет адрес шлюза.
     • Jamendo — ~600 тыс. треков по лицензиям Creative Commons. Нужен
       бесплатный client_id: JAMENDO_CLIENT_ID (devportal.jamendo.com).
   Нет ключа Jamendo — работает один Audius, и наоборот.

   Треки — в том же виде, что у Яндекса (lib/yandex.js normalizeTrack), чтобы
   плеер, очередь, «Моя волна» и плейлисты были общими. Отличия:
     trackId  — «au:<id>» или «jm:<id>»;
     source   — 'audius' | 'jamendo';
     downloadable — автор разрешил скачивание;
     link     — страница трека на сайте сервиса (для «Открыть»).
   Звук отдаёт GET /api/music?ext=<trackId> (редирект на файл сервиса),
   скачивание — GET /api/music?ext=<trackId>&dl=1.
   ========================================================================== */

function env(name) {
  const v = String(process.env[name] || '').trim();
  return /^(undefined|null|your_key_here)$/i.test(v) ? '' : v;
}
const APP = 'HarmonyAI';
const EXT_ID = /^(au|jm):([A-Za-z0-9_-]{1,40})$/;
export function isExtTrackId(id) { return EXT_ID.test(String(id || '')); }
export function extSourcesAvailable() { return { audius: env('AUDIUS_DISABLED') !== '1', jamendo: Boolean(env('JAMENDO_CLIENT_ID')) }; }

async function getJson(url, { headers = {}, timeoutMs = 7000 } = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'HarmonyAI/1.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

/* ------------------------------------------------------------------ Audius */
function audiusBase() { return (env('AUDIUS_API_BASE') || 'https://api.audius.co').replace(/\/+$/, ''); }
function audiusHeaders() {
  const k = env('AUDIUS_API_KEY');
  return k ? { 'x-api-key': k, Authorization: `Bearer ${env('AUDIUS_BEARER_TOKEN') || k}` } : {};
}
function audiusUrl(path, params = {}) {
  const u = new URL(audiusBase() + path);
  u.searchParams.set('app_name', APP);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}
function audiusTrack(t) {
  if (!t || !t.id) return null;
  // Платные/закрытые треки (stream_conditions) и не стримящиеся — пропускаем.
  if (t.is_streamable === false || t.stream_conditions || t.is_delete || t.is_unlisted) return null;
  const art = t.artwork || {};
  return {
    trackId: `au:${t.id}`,
    source: 'audius',
    albumId: null,
    title: String(t.title || 'Без названия'),
    artist: String(t.user?.name || t.user?.handle || ''),
    artistId: t.user?.id ? `au:${t.user.id}` : null,
    album: '',
    genre: String(t.genre || ''),
    cover: art['480x480'] || art['1000x1000'] || art['150x150'] || '',
    duration: Math.round(Number(t.duration) || 0),
    playable: true,
    explicit: false,
    downloadable: Boolean(t.is_downloadable || t.download?.is_downloadable),
    link: t.permalink ? `https://audius.co${t.permalink}` : ''
  };
}
async function audiusSearch(query, limit) {
  const d = await getJson(audiusUrl('/v1/tracks/search', { query, limit }), { headers: audiusHeaders() });
  return (Array.isArray(d?.data) ? d.data : []).map(audiusTrack).filter(Boolean);
}
async function audiusTrending(genre, limit) {
  const d = await getJson(audiusUrl('/v1/tracks/trending', { genre: genre || '', time: 'week', limit }), { headers: audiusHeaders() });
  return (Array.isArray(d?.data) ? d.data : []).map(audiusTrack).filter(Boolean);
}
/* Адрес файла: сервис отвечает редиректом на узел хранения. Берём Location,
   чтобы ключ (если он есть) не попадал в браузер. */
async function audiusFileUrl(id, download) {
  const url = audiusUrl(`/v1/tracks/${encodeURIComponent(id)}/${download ? 'download' : 'stream'}`);
  try {
    const r = await fetch(url, { headers: audiusHeaders(), redirect: 'manual', signal: AbortSignal.timeout(7000) });
    const loc = r.headers.get('location');
    if (loc) return loc;
  } catch (e) { /* ниже — прямой адрес */ }
  return env('AUDIUS_API_KEY') ? '' : url; // без ключа прямой адрес работает и в браузере
}

/* ----------------------------------------------------------------- Jamendo */
const JAMENDO = 'https://api.jamendo.com/v3.0';
function jamendoUrl(path, params = {}) {
  const u = new URL(JAMENDO + path);
  u.searchParams.set('client_id', env('JAMENDO_CLIENT_ID'));
  u.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}
function jamendoTrack(t) {
  if (!t || !t.id || !t.audio) return null;
  return {
    trackId: `jm:${t.id}`,
    source: 'jamendo',
    albumId: null,
    title: String(t.name || 'Без названия'),
    artist: String(t.artist_name || ''),
    artistId: t.artist_id ? `jm:${t.artist_id}` : null,
    album: String(t.album_name || ''),
    genre: String(t.musicinfo?.tags?.genres?.[0] || ''),
    cover: t.album_image || t.image || '',
    duration: Math.round(Number(t.duration) || 0),
    playable: true,
    explicit: false,
    downloadable: t.audiodownload_allowed !== false && Boolean(t.audiodownload),
    link: t.shareurl || `https://www.jamendo.com/track/${t.id}`,
    license: t.license_ccurl || ''
  };
}
async function jamendoTracks(params) {
  if (!env('JAMENDO_CLIENT_ID')) return [];
  const d = await getJson(jamendoUrl('/tracks/', { include: 'musicinfo', audioformat: 'mp32', imagesize: 300, ...params }));
  return (Array.isArray(d?.results) ? d.results : []).map(jamendoTrack).filter(Boolean);
}

/* ---------------------------------------------------------------- общее */
function interleave(lists, max) {
  const out = [], seen = new Set();
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const t = l[i];
      if (!t || out.length >= max) continue;
      const key = (t.artist + '|' + t.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(t);
    }
  }
  return out;
}

/* Поиск по обоим каталогам сразу. Сбой одного не мешает другому. */
export async function extSearch(query, limit = 8) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!q) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const src = extSourcesAvailable();
  const [au, jm] = await Promise.all([
    src.audius ? audiusSearch(q, n).catch(() => []) : [],
    src.jamendo ? jamendoTracks({ search: q, limit: n }).catch(() => []) : []
  ]);
  return interleave([au, jm], n);
}

/* Жанр Яндекса (или слово из запроса) → жанр Audius и тег Jamendo. */
const GENRES = [
  [/dance|edm/i, 'Dance & EDM', 'dance'],
  [/electron|techno|house|trance|dubstep|drum/i, 'Electronic', 'electronic'],
  [/rap|hip.?hop|trap/i, 'Hip-Hop/Rap', 'hiphop'],
  [/r&b|rnb|soul|funk/i, 'R&B/Soul', 'rnb'],
  [/metal|punk|rock/i, 'Rock', 'rock'],
  [/alternative|indie/i, 'Alternative', 'indie'],
  [/jazz|blues/i, 'Jazz', 'jazz'],
  [/classic|orchestr|piano/i, 'Classical', 'classical'],
  [/ambient|relax|lounge|lo.?fi|chill|sleep/i, 'Lo-Fi', 'chillout'],
  [/folk|country|acoustic/i, 'Folk', 'folk'],
  [/pop|estrada|эстрад/i, 'Pop', 'pop']
];
export function extGenreFor(genre) {
  const g = String(genre || '');
  for (const [re, audius, jamendo] of GENRES) if (re.test(g)) return { audius, jamendo };
  return { audius: '', jamendo: '' };
}

/* Треки для «Моей волны»: популярное за неделю (по жанру, если он известен). */
export async function extWave({ genre = '', limit = 10, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(30, Number(limit) || 10));
  const src = extSourcesAvailable();
  const g = extGenreFor(genre);
  const [au, jm] = await Promise.all([
    src.audius ? audiusTrending(g.audius, n + offset).then((l) => l.slice(offset)).catch(() => []) : [],
    src.jamendo ? jamendoTracks({ order: 'popularity_week', tags: g.jamendo, limit: n, offset }).catch(() => []) : []
  ]);
  const mix = interleave([au, jm], n * 2);
  return mix.sort(() => Math.random() - 0.5).slice(0, n);
}

/* Метаданные по id — для «Найдено в HarmonyAI» и восстановления очереди. */
export async function extTracksByIds(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(isExtTrackId).slice(0, 50);
  const au = list.filter((x) => x.startsWith('au:')).map((x) => x.slice(3));
  const jm = list.filter((x) => x.startsWith('jm:')).map((x) => x.slice(3));
  const [a, j] = await Promise.all([
    au.length ? getJson(audiusUrl('/v1/tracks', { id: au.join(',') }), { headers: audiusHeaders() }).then((d) => (d?.data || []).map(audiusTrack).filter(Boolean)).catch(() => []) : [],
    jm.length && env('JAMENDO_CLIENT_ID') ? jamendoTracks({ id: jm.join('+'), limit: jm.length }).catch(() => []) : []
  ]);
  const byId = new Map([...a, ...j].map((t) => [t.trackId, t]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

/* Адрес аудио (download=true — файл для скачивания; null, если нельзя). */
export async function extFileUrl(trackId, { download = false } = {}) {
  const m = EXT_ID.exec(String(trackId || ''));
  if (!m) return null;
  const [, src, id] = m;
  if (src === 'au') return (await audiusFileUrl(id, download)) || null;
  if (!env('JAMENDO_CLIENT_ID')) return null;
  const d = await getJson(jamendoUrl('/tracks/', { id, audioformat: 'mp32', audiodlformat: 'mp32' })).catch(() => null);
  const r = d?.results?.[0];
  if (!r) return null;
  if (!download) return r.audio || null;
  return r.audiodownload_allowed !== false && r.audiodownload ? r.audiodownload : null;
}
