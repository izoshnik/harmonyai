import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { decideAgentAction } from './ai-tasks.js';

/* /api/util?op=agent — решение «что сделать» по сообщению (см. decideAgentAction).
   Fail-open: при любой ошибке отвечаем action:"chat", и сообщение уходит
   в обычный чат — пользователь не остаётся без ответа. */
export async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const { message = '', history = [], context = {} } = req.body || {};
    const out = await decideAgentAction({ message, history, context });
    return res.status(200).json(out || { action: 'chat', reply: '', decided: false });
  } catch (e) {
    return res.status(200).json({ action: 'chat', reply: '', decided: false });
  }
}
