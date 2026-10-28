import { requireUser } from './auth.js';
import { originAllowed } from './origin.js';
import { readChatImages, ocrModels } from './image-read.js';
import { isDevAccountUser } from './dev-account.js';
import { buildMusicTheoryContext } from './music-theory-router.js';

/* /api/util?op=ocr — расшифровка фото тем же способом, что и в чате.
   Аккаунт разработчика может указать модель (сравнение качества чтения) и
   получить заодно расчёт музыкального ядра по расшифровке. */
export async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Forbidden' } });
  const user = await requireUser(req, res);
  if (!user) return;
  const { image = '', text = '', model = '' } = req.body || {};
  if (!/^(data:image\/|https:\/\/)/.test(String(image)) || String(image).length > 6_000_000) return res.status(400).json({ error: { message: 'Нужна картинка' } });
  const dev = isDevAccountUser(user);
  const messages = [{ role: 'user', content: [{ type: 'text', text: String(text || '').slice(0, 500) }, { type: 'image_url', image_url: { url: image } }] }];
  try {
    const reading = await readChatImages(messages, { pro: false, userText: text, totalMs: 55000, models: dev && model ? [String(model)] : null });
    if (!reading) return res.status(200).json({ ok: false, models: ocrModels(false) });
    const out = { ok: true, model: reading.model, type: reading.type, text: reading.text, abc: reading.abc, description: reading.description };
    if (dev) out.theory = buildMusicTheoryContext([text, reading.text, reading.abc].filter(Boolean).join('\n'));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
