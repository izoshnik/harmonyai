import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { extractMemoryFacts } from './ai-tasks.js';
import { logRequest, estimateTokens } from './observe.js';
import { utilityModel } from './models.js';

/* /api/util?op=memory — автоматическая память (см. extractMemoryFacts).
   Сервер только решает, ЧТО запомнить; записывает клиент своим токеном
   (js/hm-memory.js → user_memories под RLS), поэтому здесь нет доступа
   к чужим данным. Сбой → {save:[],forget:[]}: чат от этого не зависит. */
const budget = new Map();
export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  // Не больше 30 разборов в минуту на пользователя.
  const now = Date.now();
  const rec = budget.get(user.id) || { at: now, n: 0 };
  if (now - rec.at > 60000) { rec.at = now; rec.n = 0; }
  rec.n += 1; budget.set(user.id, rec);
  if (budget.size > 5000) budget.delete(budget.keys().next().value);
  if (rec.n > 30) return res.status(200).json({ ok: true, save: [], forget: [] });
  const body = req.body || {};
  const facts = (Array.isArray(body.facts) ? body.facts : []).map((f) => String(f || '').slice(0, 300)).slice(0, 40);
  const started = Date.now();
  const out = await extractMemoryFacts({ message: String(body.message || ''), reply: String(body.reply || ''), facts }).catch(() => null);
  logRequest({ userId: user.id, source: 'memory', model: 'memory', upstream: utilityModel(['MEMORY_MODEL', 'AGENT_MODEL']), ok: Boolean(out), status: 200,
    latencyMs: Date.now() - started, inputTokens: estimateTokens(String(body.message || '').length + facts.join('').length + 1500), outputTokens: 60 }).catch(() => {});
  return res.status(200).json({ ok: true, save: out?.save || [], forget: out?.forget || [] });
}
