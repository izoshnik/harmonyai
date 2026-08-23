/* ============================================================================
  

   Зачем: лимит Vercel Hobby — 12 serverless-функций, и он был исчерпан полностью.
   Чтобы освободить слоты под реальный API-шлюз (/v1/*) и панель аккаунта,
   четыре маленьких fail-open эндпоинта переехали сюда одним диспетчером:

     /api/intent         -> ?op=intent
     /api/music-intent   -> ?op=music-intent
     /api/title          -> ?op=title
     /api/detect-locale  -> ?op=detect-locale

   Старые URL продолжают работать через rewrites в vercel.json, поэтому клиент
   не меняли ни в одном месте. Логика самих классификаторов не изменилась —
   она целиком переехала в lib/util-*.js.

   Fail-open сохранён: неизвестный op отдаёт 404 JSON-ом, а любая ошибка внутри
   обработчика по-прежнему приводит к безопасному дефолту, а не к 500.
   ============================================================================ */

export const config = {
  maxDuration: 30
};

import { handler as intentHandler } from '../lib/util-intent.js';
import { handler as musicIntentHandler } from '../lib/util-music-intent.js';
import { handler as titleHandler } from '../lib/util-title.js';
import { handler as detectLocaleHandler } from '../lib/util-detect-locale.js';

const OPS = {
  'intent': intentHandler,
  'music-intent': musicIntentHandler,
  'title': titleHandler,
  'detect-locale': detectLocaleHandler
};

/* Определяем операцию: сначала ?op=, затем — по хвосту пути.
   Хвост нужен на случай, если запрос пришёл прямым путём /api/util/title
   или rewrite почему-то не подставил query. */
function resolveOp(req) {
  const fromQuery = String(req.query?.op || '').trim().toLowerCase();
  if (fromQuery) return fromQuery;
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const tail = path.split('/').pop() || '';
  const low = tail.toLowerCase();
  return low === 'util' ? '' : low;
}

export default async function handler(req, res) {
  const op = resolveOp(req);
  const fn = OPS[op];

  if (!fn) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(404).json({ error: { message: 'Unknown util op' } });
  }

  return fn(req, res);
}
