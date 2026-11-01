import { requireUser, readAccessProfile, hasProAccess } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { originAllowed } from './origin.js';
import { prepareVideoPrompt } from './ai-tasks.js';
import {
  videoGenConfigured, checkVideoGenAllowance, recordVideoGen, startVideoJob, pollVideoJob,
  storeVideo, signJob, readJob, videoGenErrorText, probeVideoModels
} from './video-gen.js';

/* /api/util?op=video-gen — генерация видео по описанию (см. lib/video-gen.js).
   action:
     start  {prompt}  — проверка лимита и описания, задача в очередь → {token} или сразу {url};
     status {token}   — опрос: {status:'pending'} | {status:'done', url} | {status:'failed', message}. */
export async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const action = String(body.action || 'start');
  const profile = isDevAccountUser(user) ? { role: 'developer' } : await readAccessProfile(user.id);
  const role = String(profile?.role || '').toLowerCase();
  const staff = ['developer', 'admin'].includes(role);
  const pro = hasProAccess(profile);
  try {
    if (action === 'start') {
      if (!videoGenConfigured()) return res.status(200).json({ ok: false, error: 'not_configured', message: 'Генерация видео пока не подключена.' });
      const text = String(body.prompt || '').slice(0, 1500);
      if (!text.trim()) return res.status(400).json({ ok: false, message: 'Опишите, какое видео нужно.' });
      const allowance = await checkVideoGenAllowance(user.id, { pro, staff });
      if (!allowance.ok) return res.status(429).json({ ok: false, error: 'limit', ...allowance });
      const prep = await prepareVideoPrompt(text);
      if (prep && !prep.allowed) return res.status(200).json({ ok: false, error: 'rejected', message: 'Такое видео я сделать не могу' + (prep.reason ? `: ${prep.reason}` : '.') });
      const prompt = (prep && prep.prompt) || text;
      const aspect = (prep && prep.aspect) || (/вертикал|сторис|tiktok|тикток|reels|shorts|9:16/i.test(text) ? '9:16' : '16:9');
      const job = await startVideoJob(prompt, { pro, aspect });
      await recordVideoGen(user.id);
      return res.status(200).json({ ok: true, status: 'pending', token: signJob(job.job, user.id), aspect, prompt });
    }
    if (action === 'probe') {
      if (!staff) return res.status(403).json({ ok: false, message: 'Только для персонала' });
      return res.status(200).json({ ok: true, models: await probeVideoModels(Boolean(body.pro)) });
    }
    if (action === 'status') {
      const jobId = readJob(body.token, user.id);
      if (!jobId) return res.status(400).json({ ok: false, status: 'failed', message: 'Неизвестная задача.' });
      const st = await pollVideoJob(jobId);
      if (st.status === 'done') {
        const url = await storeVideo(st.bytes, user.id, jobId);
        return res.status(200).json({ ok: true, status: 'done', url });
      }
      if (st.status === 'failed') {
        return res.status(200).json({ ok: false, status: 'failed', message: 'Не получилось создать видео. Попробуйте описать иначе.', ...(staff ? { detail: st.message } : {}) });
      }
      return res.status(200).json({ ok: true, status: 'pending' });
    }
    return res.status(400).json({ ok: false, message: 'Unknown action' });
  } catch (e) {
    console.warn('[video-gen]', action, String(e.message).slice(0, 300));
    return res.status(200).json({ ok: false, status: 'failed', error: 'error', message: videoGenErrorText(e), ...(staff ? { detail: String(e.message).slice(0, 300) } : {}) });
  }
}
