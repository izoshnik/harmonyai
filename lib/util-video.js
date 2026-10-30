import { requireUser, readAccessProfile } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { diagnoseGemini } from './video-watch.js';
import { originAllowed } from './origin.js';
import { decideVideoIntent } from './ai-tasks.js';
import { findVideos, videoStatus, rutubeSearch, ytSearch } from './video.js';

/* /api/util?op=video — онлайн-кинотеатр (см. lib/video.js).
   action:
     status     — что подключено (Rutube, YouTube);
     find       — ИИ разбирает сообщение и сразу ищет видео: один запрос
                  вместо двух, пользователь не ждёт лишний круг;
     search     — поиск по готовому разбору (смена озвучки, серии);
   body.sources = {rutube, youtube} — площадки, выбранные через «@». */
function srcOf(body) {
  const s = body && body.sources && typeof body.sources === 'object' ? body.sources : {};
  return { rutube: s.rutube !== false, youtube: s.youtube !== false };
}

const VIDEO_ASK = /(найди|включи|покажи|поставь|открой|хочу\s+(посмотреть|глянуть)|давай)[^.?!]{0,60}(видео|ролик|клип|фильм|сериал|серию|мульт|трейлер|youtube|ютуб|rutube|рутуб)/i;
function looksLikeVideoAsk(text) { return VIDEO_ASK.test(String(text || '')); }
function fallbackIntent(text) {
  const q = String(text || '')
    .replace(/(найди|включи|покажи|поставь|открой|пожалуйста|хочу\s+посмотреть|на\s+(youtube|ютубе?)|на\s+рутуб\w*|в\s+rutube|rutube|рутуб\w*|видео|ролик)/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  return { is_video: true, kind: 'video', title: '', title_en: '', franchise: '', year: 0, season: 0, episode: 0, voice: '', query: q, want_answer: false, answer_request: '', reply: '' };
}

export async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const action = String(body.action || 'find');
  try {
    if (action === 'status') {
      return res.status(200).json({ ok: true, ...videoStatus() });
    }
    if (action === 'find') {
      let intent = await decideVideoIntent({ message: body.message, history: body.history });
      // ИИ не ответил (таймаут, сбой) — при явной просьбе найти видео ищем по самой фразе.
      if (!intent && looksLikeVideoAsk(body.message)) intent = fallbackIntent(body.message);
      // Площадку выбрали через «@» — это точно поиск видео, даже если ИИ решил иначе.
      if (body.forced && (!intent || !intent.is_video)) intent = fallbackIntent(body.message);
      if (!intent) return res.status(200).json({ ok: false, decided: false, is_video: false });
      if (!intent.is_video) return res.status(200).json({ ok: false, decided: true, is_video: false });
      const found = await findVideos(intent, { sources: srcOf(body) });
      return res.status(200).json({ ...found, decided: true, is_video: true, reply: intent.reply, want_answer: intent.want_answer, answer_request: intent.answer_request });
    }
    if (action === 'search') {
      const found = await findVideos(body.intent || {}, { sources: srcOf(body) });
      return res.status(200).json(found);
    }
    if (action === 'raw') {
      // Простой поиск по строке — для списка «Другие варианты».
      const q = String(body.q || '').slice(0, 160);
      const src = srcOf(body);
      const [rt, yt] = await Promise.all([src.rutube === false ? [] : rutubeSearch(q).catch(() => []), src.youtube === false ? [] : ytSearch(q).catch(() => [])]);
      return res.status(200).json({ ok: true, items: rt.concat(yt).slice(0, 30) });
    }
    if (action === 'watch-check') {
      // Диагностика просмотра видео (ключ Gemini, модели) — только персоналу.
      const role = isDevAccountUser(user) ? 'developer' : String((await readAccessProfile(user.id))?.role || '').toLowerCase();
      if (!['developer', 'admin', 'moderator'].includes(role)) return res.status(403).json({ ok: false, error: { message: 'Только для персонала' } });
      return res.status(200).json({ ok: true, ...(await diagnoseGemini()) });
    }
    return res.status(400).json({ ok: false, error: { message: 'Unknown action' } });
  } catch (e) {
    console.warn('[video]', action, e.message);
    return res.status(200).json({ ok: false, error: e.code || 'error', message: String(e.message || '').slice(0, 200) });
  }
}
