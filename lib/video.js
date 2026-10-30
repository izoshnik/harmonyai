/* ============================================================================
   HarmonyAI — онлайн-кинотеатр (только сервер): поиск фильмов, сериалов,
   серий и роликов на Rutube и YouTube.

   Источники:
     • Rutube — основной, без ключа: открытый поиск rutube.ru/api/search/video
       (параметр client=wdp обязателен — без него русские запросы пустые).
       Показ — официальным плеером rutube.ru/play/embed.
     • YouTube — дополнительный, включается ключом YOUTUBE_API_KEY
       (YouTube Data API v3). Без ключа просто не участвует.
   (VK Видео отключено: VK ID не выдаёт сайтам доступ к поиску видео.)

   Мы ничего не скачиваем и не перекодируем: права и реклама остаются за
   площадками. Платный, скрытый, удалённый и 18+ контент отбрасываем.

   Разбор названий («2 сезон 5 серия», «S02E05», «LostFilm», «Оригинал»)
   вынесен в чистые функции — их проверяют тесты.
   ============================================================================ */


// RUTUBE_API_BASE / YOUTUBE_API_BASE — только для стенда с заглушками.
const rutubeApiBase = () => readEnv('RUTUBE_API_BASE') || 'https://rutube.ru/api';
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

export function videoStatus() {
  return { rutube: true, youtube: Boolean(readEnv('YOUTUBE_API_KEY')) };
}

/* ---------------------------------------------------------- Rutube */

export function mapRutubeItem(v) {
  if (!v || !v.id || v.is_deleted || v.is_hidden || v.is_adult || v.is_paid || v.is_locked || v.is_audio || v.is_livestream || v.product_id) return null;
  if (v.action_reason && v.action_reason.id) return null; // заблокировано правообладателем и т.п.
  const title = String(v.title || '').trim();
  const { season, episode } = parseEpisode(title);
  const voice = detectVoice(title + ' ' + String(v.description || '').slice(0, 200));
  return {
    source: 'rt',
    id: String(v.id),
    title,
    description: String(v.description || '').slice(0, 400),
    duration: Number(v.duration) || 0,
    image: String(v.thumbnail_url || ''),
    embed: String(v.embed_url || ('https://rutube.ru/play/embed/' + v.id)),
    views: Number(v.hits) || 0,
    date: Date.parse(v.publication_ts || v.created_ts || '') / 1000 || 0,
    channel: String((v.author && v.author.name) || v.feed_name || ''),
    official: Boolean(v.is_official),
    season, episode, voice, lang: voiceLang(voice)
  };
}

export async function rutubeSearch(q, { pages = 1 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const p = new URLSearchParams({ query: q, client: 'wdp', page: String(page) });
    const r = await withTimeout(fetch(`${rutubeApiBase()}/search/video/?${p}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; HarmonyAI/1.0; +https://harmonyai.ru)' }
    }), 9000, 'rutube timeout');
    if (!r.ok) { if (page === 1) { const e = new Error('Rutube ' + r.status); e.code = 'rutube_error'; throw e; } break; }
    const d = await r.json().catch(() => ({}));
    (d.results || []).forEach((v) => { const it = mapRutubeItem(v); if (it) out.push(it); });
    if (!d.has_next) break;
  }
  return out;
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
  if (item.source === 'rt') s += 2;
  if (item.official) s += 4;
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

/* Главный поиск: по разбору запроса (intent) ищем на Rutube и YouTube параллельно.
   sources — какие площадки можно трогать ({rutube, youtube}); через «@» пользователь
   может выбрать одну. */
export async function findVideos(rawIntent, { sources = {} } = {}) {
  const useRt = sources.rutube !== false;
  const useYt = sources.youtube !== false && Boolean(readEnv('YOUTUBE_API_KEY'));
  const intent = normalizeIntent(rawIntent);
  if (!intent.title && !intent.query) return { ok: false, error: 'empty', intent, items: [] };
  const long = intent.kind === 'movie' || intent.kind === 'cartoon';
  const ruQuery = intent.query && intent.kind === 'video' ? intent.query : fmtQuery(intent);
  const serial = intent.kind === 'series' || intent.kind === 'episode' || intent.kind === 'anime';
  const listQuery = serial ? fmtQuery({ title: intent.title, season: intent.season || 1, voice: intent.voice }) : '';
  const enTitle = intent.title_en || '';
  const none = Promise.resolve([]);

  const [rtMain, rtList, yt, ytEn, rtEn] = await Promise.all([
    useRt ? rutubeSearch(ruQuery, { pages: serial ? 2 : 1 }).catch(e => ({ error: e })) : none,
    useRt && listQuery && listQuery !== ruQuery ? rutubeSearch(listQuery, { pages: 2 }).catch(() => []) : none,
    useYt ? ytSearch(ruQuery, { long }).catch(() => []) : none,
    useYt && enTitle ? ytSearch(fmtQuery({ ...intent, title: enTitle, voice: '' }), { long, lang: 'en', count: 6 }).catch(() => []) : none,
    // Оригинальная озвучка — чтобы в «Дубляже» был английский вариант.
    useRt && enTitle && intent.kind !== 'video' ? rutubeSearch(fmtQuery({ ...intent, title: enTitle, voice: '' })).catch(() => []) : none
  ]);
  const rtError = rtMain && rtMain.error ? rtMain.error : null;
  const seen = new Set();
  const all = [];
  for (const it of [].concat(Array.isArray(rtMain) ? rtMain : [], rtList, yt, ytEn, rtEn.map(x => ({ ...x, lang: x.lang || 'en', voice: x.voice || 'Оригинал' })))) {
    const k = it.source + ':' + it.id;
    if (seen.has(k)) continue;
    seen.add(k);
    it._score = scoreItem(it, intent);
    all.push(it);
  }
  all.sort((a, b) => b._score - a._score);
  const best = all[0] || null;
  if (!best) {
    return { ok: false, intent, items: [], error: rtError && !useYt ? 'rutube_error' : 'not_found', youtube: useYt, sources: { rutube: useRt, youtube: useYt } };
  }
  const episodes = serial ? collectEpisodes(all, intent) : [];
  const voices = intent.kind === 'video' ? [] : collectVoices(all, best, intent);
  return {
    ok: true, intent,
    best: strip(best),
    items: all.slice(0, 12).map(strip),
    episodes: episodes.map(strip),
    voices: voices.map(v => ({ voice: v.voice, lang: v.lang, item: strip(v.item) })),
    youtube: useYt,
    sources: { rutube: useRt, youtube: useYt }
  };
}
