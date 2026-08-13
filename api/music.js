/* ============================================================================
   HarmonyAI — HTTP-роутер музыкального модуля.

   Единственный публичный вход в Яндекс.Музыку. Всё, что реально ходит в
   Яндекс, живёт в /lib (yandex.js, yandex-auth.js, music-cache.js) и наружу
   не публикуется. Здесь только: разбор действия, получение токена и
   аккуратные коды ошибок для фронтенда.

   Контракт с клиентом (js/music-client.js) — POST { action, userId, ...payload }.

   Типы ошибок, которые понимает index.html:
     music_auth_required — нужно подключить аккаунт Яндекса (401)
     music_disabled      — модуль выключен через env (503)
     music_not_found     — ничего не нашлось (200, НЕ ошибка)

   ТОКЕН НИКОГДА НЕ ПОКИДАЕТ СЕРВЕР.
   ========================================================================== */

import {
  musicEnabled,
  searchTracks,
  getSuggest,
  getTracks,
  getPlaybackUrl,
  prefetchPlaybackUrl,
  getPlaylist,
  searchPlaylist,
  getArtist,
  searchArtist,
  getAlbum,
  searchAlbum,
  getLikedTrackIds,
  getLikedLibrary,
  setLike,
  getAccountStatus,
  YandexError,
} from '../lib/yandex.js';

import {
  resolveToken,
  connectionStatus,
  requestDeviceCode,
  pollDeviceToken,
  connectWithToken,
  disconnectUser,
} from '../lib/yandex-auth.js';

import { cacheDelete } from '../lib/music-cache.js';

export const config = { maxDuration: 30 };

/* ------------------------------------------------------------------ ответы */

function fail(res, status, type, message) {
  return res.status(status).json({ type, error: { message } });
}

/** Пользователю нужно подключить свой аккаунт Яндекса. */
function needAuth(res, message) {
  return fail(
    res,
    401,
    'music_auth_required',
    message || 'Чтобы слушать музыку, подключите аккаунт Яндекса.'
  );
}

/** Единая трансляция ошибок Яндекса в понятный фронтенду ответ. */
function fromYandexError(res, e) {
  if (e instanceof YandexError) {
    if (e.code === 'auth' || e.code === 'no_token' || e.status === 401 || e.status === 403) {
      return needAuth(res, 'Подключение к Яндекс.Музыке истекло. Подключите аккаунт заново.');
    }
    if (e.code === 'not_found' || e.status === 404) {
      return res.status(200).json({ type: 'music_not_found' });
    }
    if (e.code === 'not_playable' || e.status === 451) {
      return fail(
        res,
        451,
        'music_not_playable',
        'Трек недоступен для воспроизведения — нужна подписка Яндекс Плюс на подключённом аккаунте.'
      );
    }
    if (e.code === 'timeout') {
      return fail(res, 504, 'music_timeout', 'Яндекс.Музыка отвечает слишком долго. Попробуйте ещё раз.');
    }
    return fail(res, e.status >= 400 ? e.status : 502, 'music_error', e.message);
  }
  console.error('[music] unexpected:', String(e?.message || e).slice(0, 300));
  return fail(res, 500, 'music_error', 'Музыкальный сервис временно недоступен.');
}

/* ------------------------------------------------------------- нормализация */

/** Только то, что реально можно включить, — остальное лишь путает очередь. */
function playableFirst(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const ok = list.filter((t) => t.playable !== false);
  return ok.length ? ok : list;
}

/**
 * Ссылка на аудио для стартового трека.
 * Никогда не роняет ответ: не получилось — клиент попросит её отдельно.
 */
async function safePlayback(trackId, token) {
  if (!trackId) return null;
  try {
    return await getPlaybackUrl(trackId, { token });
  } catch (e) {
    return null;
  }
}

/** Идентификатор аккаунта Яндекса: из базы, иначе спрашиваем у Яндекса. */
async function ensureUid(resolved) {
  if (resolved.uid) return resolved.uid;
  const status = await getAccountStatus(resolved.token);
  return status?.uid || null;
}

/* ------------------------------------------------------------------ resolve */

/**
 * Главный сценарий «включи X»: один запрос — треки + готовая ссылка на старт.
 * kind: track | playlist | album | artist
 */
async function doResolve(kind, query, token) {
  const q = String(query || '').trim();
  if (!q) return { type: 'music_not_found' };

  if (kind === 'playlist') {
    const pl = await searchPlaylist(q, { token });
    if (!pl || !pl.tracks?.length) return { type: 'music_not_found' };
    const items = playableFirst(pl.tracks).slice(0, 60);
    const bestMatch = items[0] || null;
    return {
      items,
      bestMatch,
      collection: {
        type: 'playlist',
        title: pl.title,
        subtitle: pl.owner ? `Плейлист · ${pl.owner}` : 'Плейлист',
        cover: pl.cover,
        trackCount: items.length,
      },
      playback: await safePlayback(bestMatch?.trackId, token),
    };
  }

  if (kind === 'album') {
    const al = await searchAlbum(q, { token });
    if (!al || !al.tracks?.length) return { type: 'music_not_found' };
    const items = playableFirst(al.tracks).slice(0, 60);
    const bestMatch = items[0] || null;
    return {
      items,
      bestMatch,
      collection: {
        type: 'album',
        title: al.title,
        subtitle: al.year ? `${al.artist} · ${al.year}` : al.artist,
        cover: al.cover,
        trackCount: items.length,
      },
      playback: await safePlayback(bestMatch?.trackId, token),
    };
  }

  if (kind === 'artist') {
    const ar = await searchArtist(q, { token });
    if (!ar || !ar.tracks?.length) return { type: 'music_not_found' };
    const items = playableFirst(ar.tracks).slice(0, 40);
    const bestMatch = items[0] || null;
    return {
      items,
      bestMatch,
      collection: {
        type: 'artist',
        title: ar.name,
        subtitle: 'Популярные треки',
        cover: ar.cover,
        trackCount: items.length,
      },
      playback: await safePlayback(bestMatch?.trackId, token),
    };
  }

  // kind === 'track' (и всё неизвестное)
  const { items, bestMatch } = await searchTracks(q, { token, limit: 10 });
  if (!items.length || !bestMatch) return { type: 'music_not_found' };

  /* ОДИН трек — самый подходящий.
     Раньше отдавался весь список из 10 позиций: в карточке была куча
     почти одинаковых версий одной песни, а очередь плеера листала их
     насквозь при любом сбое. Коллекций (альбом/артист/плейлист) это не
     касается — там список и есть смысл запроса. */
  return {
    items: [bestMatch],
    bestMatch,
    collection: null,
    playback: await safePlayback(bestMatch.trackId, token),
  };
}

/* ------------------------------------------------------------------ handler */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', 'Method not allowed');
  }

  // Главный рубильник: пока модуль не настроен — 503, фронтенд молча живёт как раньше.
  if (!musicEnabled()) {
    return fail(res, 503, 'music_disabled', 'Музыкальный модуль сейчас отключён.');
  }

  const body = req.body || {};
  const action = String(body.action || '').trim();
  const userId = body.userId ? String(body.userId) : null;

  if (!action) return fail(res, 400, 'bad_request', 'Не указано действие');

  try {
    /* ---------------------------------------------------- авторизация
       Эти действия работают БЕЗ токена — они его как раз и получают. */

    if (action === 'status') {
      return res.status(200).json(await connectionStatus(userId));
    }

    if (action === 'auth_start') {
      return res.status(200).json(await requestDeviceCode());
    }

    if (action === 'auth_poll') {
      return res.status(200).json(await pollDeviceToken(body.deviceCode, userId));
    }

    if (action === 'auth_token') {
      return res.status(200).json(await connectWithToken(body.token, userId));
    }

    if (action === 'auth_disconnect') {
      if (userId) cacheDelete(`ymtoken:${userId}`);
      return res.status(200).json(await disconnectUser(userId));
    }

    /* ------------------------------------------------- всё остальное
       Дальше нужен рабочий токен: личный либо общий серверный. */

    const resolved = await resolveToken(userId);
    if (!resolved.token) return needAuth(res);
    const token = resolved.token;

    switch (action) {
      case 'resolve': {
        const data = await doResolve(body.kind || 'track', body.query, token);
        return res.status(200).json(data);
      }

      case 'search': {
        const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 30);
        const r = await searchTracks(body.query, { token, limit });
        if (!r.items.length) return res.status(200).json({ type: 'music_not_found' });
        return res.status(200).json({ items: r.items, bestMatch: r.bestMatch });
      }

      case 'suggest': {
        return res.status(200).json({ items: await getSuggest(body.part, { token }) });
      }

      case 'tracks': {
        return res.status(200).json({ items: await getTracks(body.trackIds || [], { token }) });
      }

      case 'play': {
        const trackId = String(body.trackId || '').trim();
        if (!trackId) return fail(res, 400, 'bad_request', 'Не указан trackId');
        const info = await getPlaybackUrl(trackId, { token });
        // Следующий трек греем в фоне — переход «далее» будет без паузы.
        if (body.nextTrackId) prefetchPlaybackUrl(String(body.nextTrackId), { token });
        return res.status(200).json(info);
      }

      case 'prefetch': {
        const ids = Array.isArray(body.trackIds) ? body.trackIds.slice(0, 3) : [];
        for (const id of ids) prefetchPlaybackUrl(String(id), { token });
        return res.status(200).json({ ok: true, warmed: ids.length });
      }

      /* --------------------------------------------- коллекции по id */

      case 'playlist':
        return res.status(200).json(await getPlaylist(body.playlistId, { token }));

      case 'album':
        return res.status(200).json(await getAlbum(body.albumId, { token }));

      case 'artist':
        return res.status(200).json(await getArtist(body.artistId, { token }));

      /* -------------------------------------------------------- лайки */

      case 'liked_ids': {
        // Лайки всегда принадлежат конкретному человеку. На общем токене
        // отдаём пустой список, а не чужое избранное.
        if (resolved.source !== 'user') return res.status(200).json({ ids: [], personal: false });
        const uid = await ensureUid(resolved);
        if (!uid) return res.status(200).json({ ids: [], personal: false });
        return res.status(200).json({ ids: await getLikedTrackIds(uid, { token }), personal: true });
      }

      /* Полный список «Мне нравится» для экрана плейлистов. */
      case 'liked_tracks': {
        // Тот же принцип, что и у liked_ids: на общем токене чужое избранное
        // показывать нельзя — отдаём пусто с пометкой personal:false.
        if (resolved.source !== 'user') {
          return res.status(200).json({ items: [], total: 0, personal: false });
        }
        const uid = await ensureUid(resolved);
        if (!uid) return res.status(200).json({ items: [], total: 0, personal: false });
        const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 300);
        const lib = await getLikedLibrary(uid, { token, limit });
        return res.status(200).json({ items: lib.items, total: lib.total, personal: true });
      }

      case 'like': {
        const trackId = String(body.trackId || '').trim();
        if (!trackId) return fail(res, 400, 'bad_request', 'Не указан trackId');

        // Лайк должен попасть в избранное ПОЛЬЗОВАТЕЛЯ, а не общего аккаунта.
        // Поэтому на общем токене честно просим подключить свой.
        if (resolved.source !== 'user') {
          return needAuth(
            res,
            'Чтобы лайк появился в вашей Яндекс.Музыке, подключите свой аккаунт Яндекса.'
          );
        }

        const uid = await ensureUid(resolved);
        if (!uid) return needAuth(res, 'Не удалось определить аккаунт Яндекса. Подключите его заново.');

        const like = body.like !== false;
        const out = await setLike(uid, trackId, like, { token });
        // Список избранного изменился — сбрасываем кэш, иначе сердечко
        // будет расходиться с приложением Яндекс.Музыки.
        cacheDelete(`likes:${uid}`);
        return res.status(200).json(out);
      }

      default:
        return fail(res, 400, 'bad_request', `Неизвестное действие: ${action}`);
    }
  } catch (e) {
    return fromYandexError(res, e);
  }
}
