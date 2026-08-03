/* ============================================================================
   HarmonyAI — клиент API Яндекс.Музыки (только сервер).

   Порт необходимого минимума MarshalX/yandex-music-api на JS.
   Python-библиотека НЕ используется (запрещено ТЗ). Внешних npm-зависимостей
   тоже нет — только встроенные fetch и node:crypto (Node 20).

   Файл лежит в /lib, А НЕ в /api/lib — иначе Vercel сделал бы из него
   публичный эндпоинт /api/lib/yandex и съел слот из лимита функций.

   ТОКЕН НИКОГДА НЕ ПОКИДАЕТ СЕРВЕР.
   ========================================================================== */

import crypto from 'node:crypto';
import { cacheWrap, cachePrime, TTL } from './music-cache.js';

const API = 'https://api.music.yandex.net';

// Соль для подписи прямой ссылки на аудио. Вынесена в env на случай,
// если Яндекс её сменит — тогда починка без передеплоя кода.
const SIGN_SALT = String(process.env.YANDEX_SIGN_SALT || 'XGRlBW9FXlekgbPrRHuSiA').trim();

const DEFAULT_TIMEOUT_MS = 7000;

/* ---------------------------------------------------------------- базовое */

export function readEnv(name) {
  return String(process.env[name] || '').trim();
}

export function isPlaceholder(v) {
  const s = String(v || '').trim().toLowerCase();
  return !s || s === 'your_token_here' || s.startsWith('<') || s === 'changeme';
}

/** Общий серверный токен (fallback, когда у пользователя нет своего). */
export function sharedToken() {
  const t = readEnv('YANDEX_MUSIC_TOKEN');
  return isPlaceholder(t) ? '' : t;
}

export function musicEnabled() {
  const flag = readEnv('YANDEX_MUSIC_ENABLED').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  return true;
}

function buildHeaders(token) {
  return {
    'Authorization': `OAuth ${token}`,
    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
    'User-Agent': 'Yandex-Music-API',
    'Accept-Language': 'ru',
    'Accept': 'application/json',
  };
}

export class YandexError extends Error {
  constructor(message, status = 0, code = 'yandex_error') {
    super(message);
    this.name = 'YandexError';
    this.status = status;
    this.code = code;
  }
}

async function withTimeout(promiseFactory, ms, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promiseFactory(ctrl.signal);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new YandexError(`Таймаут запроса (${label})`, 504, 'timeout');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запрос к api.music.yandex.net.
 * Одна тихая повторка на сетевых сбоях и 5xx — больше нельзя, скорость важнее.
 */
async function ymFetch(path, { token, method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, raw = false } = {}) {
  if (!token) throw new YandexError('Нет токена Яндекс.Музыки', 401, 'no_token');

  const url = path.startsWith('http') ? path : `${API}${path}`;
  const init = { method, headers: buildHeaders(token) };
  if (body) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withTimeout(
        (signal) => fetch(url, { ...init, signal }),
        timeoutMs,
        path
      );

      if (res.status === 401 || res.status === 403) {
        throw new YandexError('Токен Яндекс.Музыки недействителен или нет доступа', res.status, 'auth');
      }
      if (res.status === 404) {
        throw new YandexError('Не найдено', 404, 'not_found');
      }
      if (res.status >= 500) {
        lastErr = new YandexError(`Яндекс ответил ${res.status}`, res.status, 'upstream');
        continue; // ретрай
      }
      if (!res.ok) {
        throw new YandexError(`Яндекс ответил ${res.status}`, res.status, 'upstream');
      }

      if (raw) return await res.text();
      const json = await res.json();
      return json?.result !== undefined ? json.result : json;
    } catch (e) {
      if (e instanceof YandexError && e.code !== 'timeout' && e.code !== 'upstream') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new YandexError('Неизвестная ошибка Яндекс.Музыки', 502, 'upstream');
}

/* ------------------------------------------------------------ нормализация */

function coverUrl(uri, size = '400x400') {
  if (!uri) return null;
  return 'https://' + String(uri).replace('%%', size);
}

function artistNames(track) {
  const list = Array.isArray(track?.artists) ? track.artists : [];
  const names = list.map((a) => a?.name).filter(Boolean);
  return names.length ? names.join(', ') : 'Неизвестный исполнитель';
}

/** Приводит сырой трек Яндекса к компактному виду из ТЗ. */
export function normalizeTrack(track) {
  if (!track) return null;
  const t = track.track || track;   // в плейлистах трек завёрнут в { track: {...} }
  const album = Array.isArray(t.albums) && t.albums[0] ? t.albums[0] : null;
  const id = String(t.id ?? t.trackId ?? '').split(':')[0];
  if (!id) return null;

  return {
    trackId: id,
    albumId: album ? String(album.id) : null,
    title: String(t.title || 'Без названия') + (t.version ? ` (${t.version})` : ''),
    artist: artistNames(t),
    artistId: Array.isArray(t.artists) && t.artists[0] ? String(t.artists[0].id) : null,
    album: album ? String(album.title || '') : '',
    cover: coverUrl(t.coverUri || album?.coverUri),
    duration: Math.round(Number(t.durationMs || 0) / 1000) || 0,
    // available — есть ли трек в каталоге; contentWarning — explicit-метка
    playable: t.available !== false,
    explicit: t.contentWarning === 'explicit',
  };
}

function normalizeArtist(a) {
  if (!a) return null;
  return {
    artistId: String(a.id),
    name: String(a.name || ''),
    cover: coverUrl(a.cover?.uri, '400x400'),
    genres: Array.isArray(a.genres) ? a.genres.slice(0, 3) : [],
  };
}

function normalizeAlbum(a) {
  if (!a) return null;
  return {
    albumId: String(a.id),
    title: String(a.title || ''),
    artist: artistNames(a),
    cover: coverUrl(a.coverUri),
    year: a.year || null,
    trackCount: a.trackCount || 0,
  };
}

function normalizePlaylist(p) {
  if (!p) return null;
  return {
    playlistId: `${p.owner?.uid || p.uid}:${p.kind}`,
    title: String(p.title || ''),
    owner: String(p.owner?.name || p.owner?.login || ''),
    cover: coverUrl(p.ogImage || p.cover?.uri),
    trackCount: p.trackCount || 0,
  };
}

/* --------------------------------------------------------------- методы */

/** Поиск треков. Кэш + SWR — повторный запрос отвечает мгновенно. */
export async function searchTracks(query, { token, limit = 8 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { items: [], bestMatch: null, cached: false };

  const key = `search:track:${q.toLowerCase()}`;
  const { value, cached } = await cacheWrap(
    key,
    async () => {
      const r = await ymFetch(
        `/search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`,
        { token }
      );
      const raw = Array.isArray(r?.tracks?.results) ? r.tracks.results : [];
      const items = raw.map(normalizeTrack).filter(Boolean);
      // best — то, что Яндекс считает точным совпадением
      const best = r?.best?.type === 'track' ? normalizeTrack(r.best.result) : null;
      return { items, best };
    },
    TTL.SEARCH,
    TTL.SEARCH_STALE
  );

  const items = value.items.slice(0, limit);
  // Лучший трек: приоритет best от Яндекса, но только если его можно играть.
  const playable = items.filter((t) => t.playable);
  const bestMatch =
    (value.best && value.best.playable ? value.best : null) || playable[0] || items[0] || null;

  return { items, bestMatch, cached };
}

/** Подсказки поиска (для мгновенного автокомплита). */
export async function getSuggest(part, { token } = {}) {
  const p = String(part || '').trim().slice(0, 100);
  if (!p) return [];
  const { value } = await cacheWrap(
    `suggest:${p.toLowerCase()}`,
    async () => {
      const r = await ymFetch(`/search/suggest?part=${encodeURIComponent(p)}`, { token, timeoutMs: 4000 });
      return Array.isArray(r?.suggestions) ? r.suggestions.slice(0, 8) : [];
    },
    TTL.SUGGEST,
    TTL.SUGGEST_STALE
  );
  return value;
}

/** Метаданные одного или нескольких треков. */
export async function getTracks(ids, { token } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((v) => String(v).trim()).filter(Boolean);
  if (!list.length) return [];
  const key = `tracks:${list.slice().sort().join(',')}`;
  const { value } = await cacheWrap(
    key,
    async () => {
      const r = await ymFetch('/tracks', { token, method: 'POST', body: { 'track-ids': list.join(',') } });
      return (Array.isArray(r) ? r : []).map(normalizeTrack).filter(Boolean);
    },
    TTL.TRACK,
    TTL.TRACK_STALE
  );
  return value;
}

export async function getTrack(trackId, { token } = {}) {
  const list = await getTracks([trackId], { token });
  return list[0] || null;
}

/* ------------------------------------------------------- ссылка на аудио */

function pickBestDownloadInfo(infos, preferCodec) {
  const list = (Array.isArray(infos) ? infos : []).filter((i) => i && i.downloadInfoUrl);
  if (!list.length) return null;
  const wanted = list.filter((i) => String(i.codec).toLowerCase() === String(preferCodec).toLowerCase());
  const pool = wanted.length ? wanted : list;
  // Максимальный битрейт из доступных.
  return pool.slice().sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0];
}

function parseDownloadXml(xml) {
  const pick = (tag) => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return m ? m[1] : '';
  };
  return { host: pick('host'), path: pick('path'), ts: pick('ts'), s: pick('s'), region: pick('region') };
}

/**
 * Прямая ссылка на аудио.
 *
 * Два шага:
 *   1) /tracks/{id}/download-info  → список вариантов с downloadInfoUrl
 *   2) GET downloadInfoUrl (XML)  → host/path/ts/s, дальше считаем md5-подпись
 *
 * Ссылка живёт минуты — кэшируем коротко и без stale.
 */
export async function getPlaybackUrl(trackId, { token, preferCodec = 'mp3' } = {}) {
  const id = String(trackId || '').trim();
  if (!id) throw new YandexError('Не указан trackId', 400, 'bad_request');

  const key = `play:${id}:${preferCodec}`;
  const { value } = await cacheWrap(
    key,
    async () => {
      const infos = await ymFetch(`/tracks/${encodeURIComponent(id)}/download-info`, { token });
      const chosen = pickBestDownloadInfo(infos, preferCodec);
      if (!chosen) {
        throw new YandexError(
          'Трек недоступен для воспроизведения (нужна подписка Яндекс Плюс или трек не в каталоге)',
          451, 'not_playable'
        );
      }

      const xml = await ymFetch(chosen.downloadInfoUrl, { token, raw: true, timeoutMs: 6000 });
      const { host, path, ts, s } = parseDownloadXml(xml);
      if (!host || !path || !ts || !s) {
        throw new YandexError('Не удалось разобрать ответ download-info', 502, 'bad_download_info');
      }

      const sign = crypto.createHash('md5').update(SIGN_SALT + path.slice(1) + s).digest('hex');
      const url = `https://${host}/get-mp3/${sign}/${ts}${path}`;

      return {
        url,
        codec: chosen.codec || 'mp3',
        bitrate: chosen.bitrateInKbps || 0,
        gain: chosen.gain === true,
        // Подпись живёт ограниченно; отдаём клиенту горизонт для самообновления.
        expiresIn: Math.round(TTL.PLAYBACK / 1000),
      };
    },
    TTL.PLAYBACK,
    TTL.PLAYBACK_STALE
  );

  return value;
}

/**
 * Префетч ссылки без ожидания.
 * Вызывается сразу после поиска для bestMatch: пока пользователь смотрит
 * на карточку, ссылка уже греется — нажатие Play срабатывает мгновенно.
 */
export function prefetchPlaybackUrl(trackId, { token, preferCodec = 'mp3' } = {}) {
  const id = String(trackId || '').trim();
  if (!id || !token) return;
  cachePrime(
    `play:${id}:${preferCodec}`,
    () => getPlaybackUrlUncached(id, { token, preferCodec }),
    TTL.PLAYBACK,
    TTL.PLAYBACK_STALE
  );
}

// Внутренняя версия без кэша — чтобы cachePrime не ушёл в рекурсию.
async function getPlaybackUrlUncached(id, { token, preferCodec }) {
  const infos = await ymFetch(`/tracks/${encodeURIComponent(id)}/download-info`, { token });
  const chosen = pickBestDownloadInfo(infos, preferCodec);
  if (!chosen) throw new YandexError('Трек недоступен', 451, 'not_playable');
  const xml = await ymFetch(chosen.downloadInfoUrl, { token, raw: true, timeoutMs: 6000 });
  const { host, path, ts, s } = parseDownloadXml(xml);
  if (!host || !path || !ts || !s) throw new YandexError('Плохой download-info', 502, 'bad_download_info');
  const sign = crypto.createHash('md5').update(SIGN_SALT + path.slice(1) + s).digest('hex');
  return {
    url: `https://${host}/get-mp3/${sign}/${ts}${path}`,
    codec: chosen.codec || 'mp3',
    bitrate: chosen.bitrateInKbps || 0,
    gain: chosen.gain === true,
    expiresIn: Math.round(TTL.PLAYBACK / 1000),
  };
}

/* ------------------------------------------------------ плейлисты / артисты */

/** Плейлист по идентификатору вида "uid:kind". */
export async function getPlaylist(playlistId, { token } = {}) {
  const [uid, kind] = String(playlistId || '').split(':');
  if (!uid || !kind) throw new YandexError('Неверный playlistId', 400, 'bad_request');

  const { value } = await cacheWrap(
    `playlist:${uid}:${kind}`,
    async () => {
      const r = await ymFetch(`/users/${encodeURIComponent(uid)}/playlists/${encodeURIComponent(kind)}`, { token });
      const meta = normalizePlaylist(r);
      const tracks = (Array.isArray(r?.tracks) ? r.tracks : []).map(normalizeTrack).filter(Boolean);
      return { ...meta, tracks };
    },
    TTL.ENTITY,
    TTL.ENTITY_STALE
  );
  return value;
}

/** Поиск плейлиста по названию + сразу его треки («включи плейлист relax»). */
export async function searchPlaylist(query, { token } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return null;

  const { value } = await cacheWrap(
    `search:playlist:${q.toLowerCase()}`,
    async () => {
      const r = await ymFetch(
        `/search?text=${encodeURIComponent(q)}&type=playlist&page=0&nocorrect=false`,
        { token }
      );
      const first = Array.isArray(r?.playlists?.results) ? r.playlists.results[0] : null;
      return first ? normalizePlaylist(first) : null;
    },
    TTL.SEARCH,
    TTL.SEARCH_STALE
  );

  if (!value) return null;
  return await getPlaylist(value.playlistId, { token });
}

/** Артист + его популярные треки. */
export async function getArtist(artistId, { token } = {}) {
  const id = String(artistId || '').trim();
  if (!id) throw new YandexError('Не указан artistId', 400, 'bad_request');

  const { value } = await cacheWrap(
    `artist:${id}`,
    async () => {
      const r = await ymFetch(`/artists/${encodeURIComponent(id)}/brief-info`, { token });
      const meta = normalizeArtist(r?.artist);
      const tracks = (Array.isArray(r?.popularTracks) ? r.popularTracks : [])
        .map(normalizeTrack).filter(Boolean).slice(0, 20);
      return { ...meta, tracks };
    },
    TTL.ENTITY,
    TTL.ENTITY_STALE
  );
  return value;
}

/** Поиск артиста по имени («найди ариана гранде»). */
export async function searchArtist(query, { token } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return null;
  const { value } = await cacheWrap(
    `search:artist:${q.toLowerCase()}`,
    async () => {
      const r = await ymFetch(
        `/search?text=${encodeURIComponent(q)}&type=artist&page=0&nocorrect=false`,
        { token }
      );
      const first = Array.isArray(r?.artists?.results) ? r.artists.results[0] : null;
      return first ? normalizeArtist(first) : null;
    },
    TTL.SEARCH,
    TTL.SEARCH_STALE
  );
  if (!value) return null;
  return await getArtist(value.artistId, { token });
}

/** Альбом с треками. */
export async function getAlbum(albumId, { token } = {}) {
  const id = String(albumId || '').trim();
  if (!id) throw new YandexError('Не указан albumId', 400, 'bad_request');
  const { value } = await cacheWrap(
    `album:${id}`,
    async () => {
      const r = await ymFetch(`/albums/${encodeURIComponent(id)}/with-tracks`, { token });
      const meta = normalizeAlbum(r);
      const volumes = Array.isArray(r?.volumes) ? r.volumes : [];
      const tracks = volumes.flat().map(normalizeTrack).filter(Boolean);
      return { ...meta, tracks };
    },
    TTL.ENTITY,
    TTL.ENTITY_STALE
  );
  return value;
}

/** Поиск альбома по названию («поставь альбом evolve»). */
export async function searchAlbum(query, { token } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return null;
  const { value } = await cacheWrap(
    `search:album:${q.toLowerCase()}`,
    async () => {
      const r = await ymFetch(
        `/search?text=${encodeURIComponent(q)}&type=album&page=0&nocorrect=false`,
        { token }
      );
      const first = Array.isArray(r?.albums?.results) ? r.albums.results[0] : null;
      return first ? normalizeAlbum(first) : null;
    },
    TTL.SEARCH,
    TTL.SEARCH_STALE
  );
  if (!value) return null;
  return await getAlbum(value.albumId, { token });
}

/** Проверка токена: кто мы и есть ли Плюс. */
export async function getAccountStatus(token) {
  const r = await ymFetch('/account/status', { token, timeoutMs: 5000 });
  return {
    uid: r?.account?.uid ? String(r.account.uid) : null,
    login: r?.account?.login || null,
    displayName: r?.account?.fullName || r?.account?.displayName || null,
    hasPlus: Boolean(r?.plus?.hasPlus),
    subscribed: Boolean(r?.subscription?.hadAnySubscription),
  };
}

/** Лайкнутые треки пользователя. */
export async function getLikedTracks(uid, { token, limit = 30 } = {}) {
  if (!uid) return [];
  const r = await ymFetch(`/users/${encodeURIComponent(uid)}/likes/tracks`, { token });
  const ids = (Array.isArray(r?.library?.tracks) ? r.library.tracks : [])
    .slice(0, limit)
    .map((t) => String(t.id));
  if (!ids.length) return [];
  return await getTracks(ids, { token });
}

/** Поставить/снять лайк. */
export async function setLike(uid, trackId, like, { token } = {}) {
  if (!uid) throw new YandexError('Нужна авторизация', 401, 'auth');
  const action = like ? 'add-multiple' : 'remove';
  await ymFetch(`/users/${encodeURIComponent(uid)}/likes/tracks/${action}`, {
    token, method: 'POST', body: { 'track-ids': String(trackId) },
  });
  return { ok: true, liked: Boolean(like) };
}
