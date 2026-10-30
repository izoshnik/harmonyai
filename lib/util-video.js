import { requireUser, readAccessProfile } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { diagnoseGemini } from './video-watch.js';
import { originAllowed } from './origin.js';
import { providerForModel } from './models.js';
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
    if (action === 'chat-check') {
      // Диагностика бесплатных моделей Adan: кто отвечает, кто упёрся в лимит.
      const role = isDevAccountUser(user) ? 'developer' : String((await readAccessProfile(user.id))?.role || '').toLowerCase();
      if (!['developer', 'admin', 'moderator'].includes(role)) return res.status(403).json({ ok: false, error: { message: 'Только для персонала' } });
      return res.status(200).json({ ok: true, ...(await checkChatModels()) });
    }
    return res.status(400).json({ ok: false, error: { message: 'Unknown action' } });
  } catch (e) {
    console.warn('[video]', action, e.message);
    return res.status(200).json({ ok: false, error: e.code || 'error', message: String(e.message || '').slice(0, 200) });
  }
}

const ADAN_FALLBACK = ['thinkingmachines/inkling:free', 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-lightning:free', 'deepseek-v4-flash-0731'];
async function checkChatModels() {
  const env = String(process.env.ADAN_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const list = [...new Set((env.length ? env : ADAN_FALLBACK).concat(['google/gemma-4-26b-a4b-it:free', 'thinkingmachines/inkling-small:free']))];
  const tests = await Promise.all(list.map(async (m) => {
    const pr = providerForModel(m);
    const t0 = Date.now();
    if (!pr.apiKey) return { model: m, error: 'no key' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const body = { model: m, messages: [{ role: 'user', content: 'Ответь одним словом: привет' }], max_tokens: 30, stream: false };
      if (pr.openrouter) body.reasoning = { enabled: false };
      const r = await fetch(`${pr.baseUrl}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pr.apiKey}`, ...(pr.headers || {}) }, body: JSON.stringify(body) });
      const t = await r.text();
      return { model: m, status: r.status, ms: Date.now() - t0, body: t.slice(0, 300) };
    } catch (e) { return { model: m, error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - t0 }; }
    finally { clearTimeout(timer); }
  }));
  let credits = null;
  try {
    const k = providerForModel('x/y').apiKey;
    if (k) { const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${k}` } }); credits = (await r.text()).slice(0, 400); }
  } catch (e) { credits = e.message; }
  return { adanEnv: env, tests, openrouterKey: credits };
}
