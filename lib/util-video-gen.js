import { requireUser, readAccessProfile, hasProAccess } from './auth.js';
import { isDevAccountUser } from './dev-account.js';
import { originAllowed } from './origin.js';
import { logRequest, reportError, serviceErrorText, isBlockedProfile, BLOCKED_MESSAGE } from './observe.js';
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
  const plan = staff ? 'staff' : (pro ? 'pro' : 'free');
  if (isBlockedProfile(profile)) return res.status(403).json({ ok: false, status: 'failed', message: BLOCKED_MESSAGE });
  // Сбой сервиса → код; причина и история моделей — в панели управления.
  const failCode = async (message, detail) => {
    const code = await reportError({ source: 'video_gen', status: 502, message, detail, userId: user.id, userText: String(body.prompt || ''), allowText: profile?.settings?.ai_training !== false });
    await logRequest({ userId: user.id, source: 'video_gen', plan, model: 'video', upstream: detail?.model || null, provider: 'closerouter', ok: false, status: 502, errorCode: code });
    return code;
  };
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
      return res.status(200).json({ ok: true, status: 'pending', token: signJob(job.job, user.id, { m: job.index, p: prompt.slice(0, 900), a: aspect, r: pro ? 1 : 0, c: Number(job.cost) || 0, t: Date.now() }), aspect, prompt });
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
        // Оплачивается только готовый ролик: стоимость — из котировки при запуске.
        await logRequest({ userId: user.id, source: 'video_gen', plan, model: 'video', upstream: videoModels()[Number(info.m || 0)] || null, provider: 'closerouter',
          ok: true, status: 200, costUsd: Number(info.c) || 0, latencyMs: info.t ? Date.now() - Number(info.t) : null, tried: Array.isArray(info.e) ? info.e.map((x) => String(x).split(':')[0]) : null });
        return res.status(200).json({ ok: true, status: 'done', url });
      }
      if (st.status === 'failed') {
        /* Генерация упала у провайдера («Generated video failed upstream») —
           упавшие задачи не оплачиваются, поэтому сразу запускаем ту же
           сцену на следующей модели; клиент просто ждёт дальше с новым номером. */
        const list = videoModels();
        const idx = Number(info.m || 0);
        // История сбоев по моделям — в подписанном номере задачи, для разбора персоналом.
        const errs = (Array.isArray(info.e) ? info.e : []).concat(`${list[idx] || idx}: ${st.raw || st.message}`).slice(-4).map((x) => String(x).slice(0, 220));
        console.warn('[video-gen] upstream failed |', errs[errs.length - 1]);
        const next = idx + 1;
        // Отказ по правилам контента — другая модель того же провайдера откажет так же.
        if (!st.policy && info.p && next < list.length) {
          try {
            const job = await startVideoJob(String(info.p), { pro: Boolean(info.r), aspect: info.a || '16:9', fromIndex: next });
            return res.status(200).json({ ok: true, status: 'pending', token: signJob(job.job, user.id, { m: job.index, p: info.p, a: info.a, r: info.r, e: errs, c: Number(job.cost) || 0, t: info.t }), retried: job.model });
          } catch (e) { errs.push(`retry: ${e.message}`.slice(0, 220)); }
        }
        if (st.policy) {
          return res.status(200).json({ ok: false, status: 'failed', message: 'Сервис видео отклонил эту сцену по своим правилам (часто — реалистичные люди). Попробуйте другой сюжет или стиль: мультяшный, 3D, аниме.' });
        }
        const code = await failCode('video failed upstream on all models', { model: list[idx] || null, errors: errs, prompt: String(info.p || '').slice(0, 300) });
        return res.status(200).json({ ok: false, status: 'failed', code, message: serviceErrorText(code) + '. Попробуйте описать сцену иначе или повторите позже.' });
      }
      return res.status(200).json({ ok: true, status: 'pending' });
    }
    return res.status(400).json({ ok: false, message: 'Unknown action' });
  } catch (e) {
    console.warn('[video-gen]', action, String(e.message).slice(0, 300));
    // 400 — сервис не принял описание: это подсказка пользователю, а не сбой.
    if (Number(e?.status) === 400) return res.status(200).json({ ok: false, status: 'failed', error: 'error', message: videoGenErrorText(e) });
    const code = await failCode(`${action}: ${Number(e?.status) || ''} ${String(e?.message || '').slice(0, 600)}`, { action, status: Number(e?.status) || null });
    return res.status(200).json({ ok: false, status: 'failed', error: 'error', code, message: serviceErrorText(code) + '. Попробуйте ещё раз чуть позже.' });
  }
}
