/* ============================================================================
   HarmonyAI — единый музыкальный эндпоинт.

   Почему ОДИН файл, а не восемь, как предлагало ТЗ:
   в проекте уже 11 serverless-функций, а лимит Vercel Hobby — 12 на деплой.
   Восемь новых файлов сломали бы сборку. Один роутер с action — 12/12.

   Главная оптимизация скорости — action:'resolve'.
   Один HTTP-запрос на фразу «включи believer» возвращает сразу:
     - карточки треков,
     - лучшее совпадение,
     - ГОТОВУЮ ссылку на аудио для него (если успела за бюджет времени).
   Значит нажатие Play не требует сети вообще: звук стартует мгновенно.
   Если ссылка не успела — карточки всё равно уходят сразу, а ссылка
   догревается в фоне (prefetch) и будет готова к моменту клика.

   Токен Яндекса никогда не уходит в браузер.
   ========================================================================== */

import {
  searchTracks, getSuggest, getTrack, getTracks, getPlaybackUrl, prefetchPlaybackUrl,
  getPlaylist, searchPlaylist, getArtist, searchArtist, getAlbum, searchAlbum,
  getLikedTracks, setLike, musicEnabled, YandexError,
} from '../lib/yandex.js';

import {
  resolveToken, connectionStatus, requestDeviceCode, pollDeviceToken,
  connectWithToken, disconnectUser,
} from '../lib/yandex-auth.js';

export const config = { maxDuration: 30 };

/* --------------------------------------------------- защита (как в recognize.js) */

const ALLOWED_HOSTS = ['harmonyai-zeta.vercel.app', 'localhost', '127.0.0.1'];

function originAllowed(req) {
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}

// Музыка — лёгкие запросы, но их много (поиск + прокрутка очереди).
const RL_WINDOW_MS = 60 * 1000, RL_MAX = 90;
const _rl = new Map();

function rateLimited(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  const ip = String(fwd.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const rec = _rl.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    _rl.set(ip, { start: now, count: 1 });
    if (_rl.size > 5000) for (const [k, v] of _rl) if (now - v.start > RL_WINDOW_MS) _rl.delete(k);
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

/* ------------------------------------------------------------------ утилиты */

/** Гонка с таймаутом: не даём одному медленному шагу задержать весь ответ. */
function raceBudget(promise, ms, fallback = null) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

/* ------------------------------------------------------------------ handler */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Ответы музыки не кэшируем на CDN — внутри подписанные ссылки.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: { message: 'Источник запроса не разрешён' } });
  }
  if (rateLimited(req)) {
    return res.status(429).json({ error: { message: 'Слишком много запросов, подождите минуту' } });
  }
  if (!musicEnabled()) {
    return res.status(503).json({
      type: 'music_disabled',
      error: { message: 'Музыкальный модуль временно отключён' },
    });
  }

  const body = readBody(req);
  const action = String(body.action || '').trim();
  const userId = body.userId ? String(body.userId) : null;

  try {
    /* ---------------------------------------------------------- авторизация */

    if (action === 'status') {
      const st = await connectionStatus(userId);
      return res.status(200).json({ type: 'music_status', ...st });
    }

    if (action === 'auth_start') {
      // deviceCode — не токен доступа, а одноразовый идентификатор сессии,
      // бесполезный без подтверждения человеком на странице Яндекса.
      const d = await requestDeviceCode();
      return res.status(200).json({ type: 'music_auth_start', ...d });
    }

    if (action === 'auth_poll') {
      const r = await pollDeviceToken(String(body.deviceCode || ''), userId);
      return res.status(200).json({ type: 'music_auth_poll', ...r });
    }

    if (action === 'auth_token') {
      const r = await connectWithToken(String(body.token || ''), userId);
      return res.status(200).json({ type: 'music_auth_token', ...r });
    }

    if (action === 'auth_disconnect') {
      const r = await disconnectUser(userId);
      return res.status(200).json({ type: 'music_auth_disconnect', ...r });
    }

    /* ------------------------------------------ всё остальное требует токена */

    const auth = await resolveToken(userId);
    if (!auth.token) {
      return res.status(401).json({
        type: 'music_auth_required',
        error: { message: 'Подключите Яндекс.Музыку, чтобы слушать треки' },
      });
    }
    const token = auth.token;

    // Бюджет на попытку сразу приложить ссылку на аудио к ответу.
    const URL_BUDGET_MS = 1400;

    /** Общий хвост для коллекций: берём первый играбельный трек и греем ссылку. */
    async function withFirstPlayback(tracks) {
      const first = tracks.find((t) => t.playable) || tracks[0] || null;
      if (!first) return { first: null, playback: null };
      const playback = await raceBudget(getPlaybackUrl(first.trackId, { token }), URL_BUDGET_MS);
      if (!playback) prefetchPlaybackUrl(first.trackId, { token });
      const next = tracks.find((t) => t.playable && t.trackId !== first.trackId);
      if (next) prefetchPlaybackUrl(next.trackId, { token });
      return { first, playback };
    }

    /* ------------------------------------------------------------------ resolve */
    /* Самый быстрый путь: фраза -> готовая к воспроизведению очередь. */

    if (action === 'resolve') {
      const kind = String(body.kind || 'track');
      const query = String(body.query || '').trim();
      if (!query) return res.status(400).json({ error: { message: 'Пустой запрос' } });

      if (kind === 'playlist' || kind === 'album' || kind === 'artist') {
        let entity = null;
        if (kind === 'playlist') entity = await searchPlaylist(query, { token });
        if (kind === 'album') entity = await searchAlbum(query, { token });
        if (kind === 'artist') entity = await searchArtist(query, { token });

        const tracks = Array.isArray(entity?.tracks) ? entity.tracks : [];
        if (!entity || !tracks.length) {
          return res.status(200).json({ type: 'music_not_found', query, kind });
        }

        const { first, playback } = await withFirstPlayback(tracks);
        return res.status(200).json({
          type: 'music_collection',
          kind,
          query,
          collection: {
            title: entity.title || entity.name || '',
            subtitle: entity.artist || entity.owner || 'Популярное',
            cover: entity.cover || null,
            count: tracks.length,
          },
          items: tracks.slice(0, 100),
          bestMatch: first,
          playback,
        });
      }

      // kind === 'track'
      const { items, bestMatch, cached } = await searchTracks(query, { token, limit: 8 });
      if (!items.length) {
        return res.status(200).json({ type: 'music_not_found', query, kind: 'track' });
      }

      let playback = null;
      if (bestMatch && bestMatch.playable) {
        playback = await raceBudget(getPlaybackUrl(bestMatch.trackId, { token }), URL_BUDGET_MS);
        if (!playback) prefetchPlaybackUrl(bestMatch.trackId, { token });
        const next = items.find((t) => t.playable && t.trackId !== bestMatch.trackId);
        if (next) prefetchPlaybackUrl(next.trackId, { token });
      }

      return res.status(200).json({
        type: 'music_search_result', query, items, bestMatch, playback, cached,
      });
    }

    /* ------------------------------------------------------------------ поиск */

    if (action === 'search') {
      const query = String(body.query || '').trim();
      const limit = Number(body.limit) || 8;
      const r = await searchTracks(query, { token, limit });
      if (r.bestMatch && r.bestMatch.playable) {
        prefetchPlaybackUrl(r.bestMatch.trackId, { token });
      }
      return res.status(200).json({
        type: 'music_search_result', query,
        items: r.items, bestMatch: r.bestMatch, cached: r.cached,
      });
    }

    if (action === 'suggest') {
      const items = await getSuggest(String(body.part || ''), { token });
      return res.status(200).json({ type: 'music_suggest', items });
    }

    /* ----------------------------------------------------------------- треки */

    if (action === 'track') {
      const track = await getTrack(String(body.trackId || ''), { token });
      if (!track) return res.status(404).json({ error: { message: 'Трек не найден' } });
      prefetchPlaybackUrl(track.trackId, { token });
      return res.status(200).json({ type: 'music_track', track });
    }

    if (action === 'tracks') {
      const ids = Array.isArray(body.trackIds) ? body.trackIds.slice(0, 50) : [];
      const items = await getTracks(ids, { token });
      return res.status(200).json({ type: 'music_tracks', items });
    }

    if (action === 'play') {
      const trackId = String(body.trackId || '');
      const playback = await getPlaybackUrl(trackId, { token, preferCodec: body.codec || 'mp3' });
      // Прогрев следующего трека — кнопка «следующий» сработает без паузы.
      if (body.nextTrackId) prefetchPlaybackUrl(String(body.nextTrackId), { token });
      return res.status(200).json({ type: 'music_playback', trackId, ...playback });
    }

    // Чистый префетч: клиент говорит «скоро понадобится», отвечаем мгновенно.
    if (action === 'prefetch') {
      const ids = Array.isArray(body.trackIds) ? body.trackIds.slice(0, 3) : [];
      for (const id of ids) prefetchPlaybackUrl(String(id), { token });
      return res.status(200).json({ type: 'music_prefetch', queued: ids.length });
    }

    /* ------------------------------------------------------------- коллекции */

    if (action === 'playlist') {
      const pl = body.playlistId
        ? await getPlaylist(String(body.playlistId), { token })
        : await searchPlaylist(String(body.query || ''), { token });
      if (!pl) return res.status(404).json({ error: { message: 'Плейлист не найден' } });
      return res.status(200).json({ type: 'music_collection', kind: 'playlist', ...pl });
    }

    if (action === 'artist') {
      const ar = body.artistId
        ? await getArtist(String(body.artistId), { token })
        : await searchArtist(String(body.query || ''), { token });
      if (!ar) return res.status(404).json({ error: { message: 'Исполнитель не найден' } });
      return res.status(200).json({ type: 'music_collection', kind: 'artist', ...ar });
    }

    if (action === 'album') {
      const al = body.albumId
        ? await getAlbum(String(body.albumId), { token })
        : await searchAlbum(String(body.query || ''), { token });
      if (!al) return res.status(404).json({ error: { message: 'Альбом не найден' } });
      return res.status(200).json({ type: 'music_collection', kind: 'album', ...al });
    }

    /* -------------------------------------------------------------- избранное */

    if (action === 'liked') {
      if (!auth.uid) return res.status(200).json({ type: 'music_tracks', items: [] });
      const items = await getLikedTracks(auth.uid, { token });
      return res.status(200).json({ type: 'music_tracks', items });
    }

    if (action === 'like') {
      if (!auth.uid) {
        return res.status(400).json({
          error: { message: 'Лайки доступны только со своим аккаунтом Яндекса' },
        });
      }
      const r = await setLike(auth.uid, String(body.trackId || ''), body.like !== false, { token });
      return res.status(200).json({ type: 'music_like', ...r });
    }

    return res.status(400).json({ error: { message: 'Неизвестное действие: ' + action } });

  } catch (e) {
    const status = e instanceof YandexError ? (e.status || 502) : 500;
    const code = e instanceof YandexError ? e.code : 'internal';
    // Лог без токенов и подписанных ссылок.
    console.error('[music]', action, code, String(e && e.message || e).slice(0, 300));
    return res.status(status).json({
      type: 'music_error', code,
      error: { message: String(e && e.message || 'Ошибка музыкального модуля') },
    });
  }
}
