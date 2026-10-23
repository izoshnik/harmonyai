import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { summarizeUserProfile } from './ai-tasks.js';

/* ============================================================================
   СВОДКА «О ВАС» ДЛЯ ПЕРСОНАЛИЗАЦИИ.
   Клиент присылает прежнюю сводку, свои последние сообщения и сохранённые
   факты памяти; возвращаем обновлённую сводку. Только для вошедших и не
   чаще RL_MAX раз в час на аккаунт — это фоновая задача, а не диалог.
   ============================================================================ */
const RL_WINDOW_MS = 60 * 60 * 1000;
const RL_MAX = 12;
const _rl = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const rec = _rl.get(userId);
  if (!rec || now - rec.start > RL_WINDOW_MS) { _rl.set(userId, { start: now, count: 1 }); return false; }
  rec.count += 1;
  return rec.count > RL_MAX;
}

export async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  if (rateLimited(user.id)) return res.status(429).json({ error: { message: 'Слишком часто' } });
  const { previous = '', messages = [], facts = [] } = req.body || {};
  const out = await summarizeUserProfile({ previous, messages, facts });
  if (!out) return res.status(200).json({ summary: String(previous || ''), changed: false, error: 'unavailable' });
  return res.status(200).json(out);
}
