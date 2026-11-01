import { requireUser, readAccessProfile, hasProAccess } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { originAllowed } from './origin.js';
import { prepareVideoPrompt } from './ai-tasks.js';
import {
  videoGenConfigured, checkVideoGenAllowance, recordVideoGen, startVideoJob, pollVideoJob,
  storeVideo, signJob, readJobInfo, videoGenErrorText, probeVideoModels, videoModels
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
      return res.status(200).json({ ok: true, status: 'pending', token: signJob(job.job, user.id, { m: job.index, p: prompt.slice(0, 900), a: aspect, r: pro ? 1 : 0 }), aspect, prompt });
    }
    if (action === 'probe') {
      if (!staff) return res.status(403).json({ ok: false, message: 'Только для персонала' });
      return res.status(200).json({ ok: true, models: await probeVideoModels(Boolean(body.pro)) });
    }
    if (action === 'status') {
      const info = readJobInfo(body.token, user.id);
      if (!info) return res.status(400).json({ ok: false, status: 'failed', message: 'Неизвестная задача.' });
      const jobId = String(info.j);
      const st = await pollVideoJob(jobId);
      if (st.status === 'done') {
        const url = await storeVideo(st.bytes, user.id, jobId);
        return res.status(200).json({ ok: true, status: 'done', url });
      }
      if (st.status === 'failed') {
        /* Генерация упала у провайдера («Generated video failed upstream») —
           упавшие задачи не оплачиваются, поэтому сразу запускаем ту же
           сцену на следующей модели; клиент просто ждёт дальше с новым номером. */
        const next = Number(info.m || 0) + 1;
        if (info.p && next < videoModels().length) {
          try {
            const job = await startVideoJob(String(info.p), { pro: Boolean(info.r), aspect: info.a || '16:9', fromIndex: next });
            console.warn('[video-gen] upstream failed, retry on', job.model, '|', String(st.message || '').slice(0, 160));
            return res.status(200).json({ ok: true, status: 'pending', token: signJob(job.job, user.id, { m: job.index, p: info.p, a: info.a, r: info.r }), retried: job.model });
          } catch (e) { st.message = `${st.message} | retry: ${e.message}`; }
        }
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
