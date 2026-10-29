import { requireUser, readAccessProfile } from './auth.js';
import { originAllowed } from './origin.js';
import { isDevAccountUser } from './dev-account.js';
import { decideVideoIntent } from './ai-tasks.js';
import { findVideos, videoStatus, vkConnect, vkSearch, ytSearch } from './video.js';

/* /api/util?op=video — онлайн-кинотеатр (см. lib/video.js).
   action:
     status     — что подключено (VK, YouTube, вход VK ID для персонала);
     find       — ИИ разбирает сообщение и сразу ищет видео: один запрос
                  вместо двух, пользователь не ждёт лишний круг;
     search     — поиск по готовому разбору (смена озвучки, серии);
     vk-connect — персонал подключает VK к серверу (обмен кода VK ID). */
const STAFF = ['developer', 'admin', 'moderator'];

async function isStaff(user) {
  if (isDevAccountUser(user)) return true;
  const p = await readAccessProfile(user.id);
  return STAFF.includes(String(p?.role || '').toLowerCase());
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
      const st = await videoStatus();
      return res.status(200).json({ ok: true, ...st, staff: await isStaff(user).catch(() => false) });
    }
    if (action === 'find') {
      const intent = await decideVideoIntent({ message: body.message, history: body.history });
      if (!intent) return res.status(200).json({ ok: false, decided: false, is_video: false });
      if (!intent.is_video) return res.status(200).json({ ok: false, decided: true, is_video: false });
      const found = await findVideos(intent, { allowYoutube: body.youtube !== false });
      return res.status(200).json({ ...found, decided: true, is_video: true, reply: intent.reply, want_answer: intent.want_answer, answer_request: intent.answer_request });
    }
    if (action === 'search') {
      const found = await findVideos(body.intent || {}, { allowYoutube: body.youtube !== false });
      return res.status(200).json(found);
    }
    if (action === 'raw') {
      // Простой поиск по строке — для списка «Другие варианты».
      const q = String(body.q || '').slice(0, 160);
      const [vk, yt] = await Promise.all([vkSearch(q, { count: 20 }).catch(() => []), body.youtube === false ? [] : ytSearch(q).catch(() => [])]);
      return res.status(200).json({ ok: true, items: vk.concat(yt).slice(0, 30) });
    }
    if (action === 'vk-connect') {
      if (!(await isStaff(user))) return res.status(403).json({ ok: false, error: { message: 'Подключать VK к серверу может только персонал' } });
      const out = await vkConnect({
        code: String(body.code || ''), codeVerifier: String(body.code_verifier || ''),
        deviceId: String(body.device_id || ''), redirectUri: String(body.redirect_uri || ''), state: String(body.state || '')
      });
      return res.status(200).json(out);
    }
    return res.status(400).json({ ok: false, error: { message: 'Unknown action' } });
  } catch (e) {
    console.warn('[video]', action, e.message);
    return res.status(200).json({ ok: false, error: e.code || 'error', message: String(e.message || '').slice(0, 200) });
  }
}
