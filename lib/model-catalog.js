/* ============================================================================
   КАТАЛОГ БЕСПЛАТНЫХ МОДЕЛЕЙ: NVIDIA NIM, Cerebras, Groq (+ Gemini и OpenRouter)
   ----------------------------------------------------------------------------
   У каждого провайдера свой ключ в Vercel (NVIDIA_API_KEY, CEREBRAS_API_KEY,
   GROQ_API_KEY). Нет ключа — провайдера просто нет в цепочке.

   Имена моделей у провайдеров меняются каждые полгода, жёсткий список ломался
   бы молча. Поэтому сервер раз в час спрашивает у провайдера /models и берёт из
   того, что реально есть у ключа, самые сильные модели по таблице STRENGTH.
   Явный список переопределяет поиск: NIM_MODELS, CEREBRAS_MODELS, GROQ_MODELS
   (через запятую, имена как у провайдера).

   Цепочка Adan идёт ОТ СИЛЬНОЙ МОДЕЛИ К СЛАБОЙ (по таблице ниже), независимо от
   провайдера; платная запасная (deepseek-v4-flash на pro-ai.online) — всегда
   последней. ADAN_CHAIN (через запятую, полные имена с префиксом) задаёт порядок
   вручную.
   ========================================================================== */
import { EXTRA_PROVIDERS, providerForModel, providerFetch, geminiApiKey, geminiChatModel } from './models.js';

function readEnv(name) { return String(process.env[name] || '').trim(); }

/* Сила модели (условные баллы; больше — сильнее). Первое совпадение. Таблица —
   единственное место, где задаётся порядок «от сильной к слабой». */
export const STRENGTH = [
  [/glm-5/i, 95], [/deepseek-v4-pro|deepseek-v4(?![\w.-]*flash)/i, 95], [/kimi-k2/i, 92], [/deepseek-v4[\w.-]*flash/i, 91],
  [/qwen3\.[5-9]/i, 90], [/qwen3-235b/i, 89], [/nemotron-3-ultra/i, 88], [/gemini-3\.[5-9]-flash(?!-lite)/i, 88],
  [/gpt-oss-120b/i, 86], [/glm-4\.[5-9]/i, 85], [/gemini-3\.[5-9]-flash-lite/i, 83], [/nemotron-3\.5-super/i, 81],
  [/inkling(?!-small)/i, 79], [/llama-4-maverick/i, 76], [/gemma-4-31b/i, 75], [/qwen3-32b/i, 73],
  [/gemma-4-26b/i, 71], [/llama-3\.3-70b/i, 65], [/nemotron-3\.5-lightning/i, 62], [/gpt-oss-20b/i, 60]
];
export function strengthOf(name) {
  const n = String(name || '');
  for (const [re, score] of STRENGTH) if (re.test(n)) return score;
  return 50;
}
// Не чат-модели (эмбеддинги, модерация, распознавание речи и т.п.) в цепочку не попадают.
const NOT_CHAT = /embed|rerank|guard|safety|whisper|tts|speech|audio|vision-only|reward|retriever|parse|ocr|clip|-base\b|instruct-base/i;
const PER_PROVIDER = 3; // сколько лучших моделей брать у одного провайдера

/* ---------------------------------------------------------------- кэш /models */
const cache = {}; // provider → { at, ids: [] }
const CACHE_MS = 60 * 60 * 1000, FAIL_MS = 5 * 60 * 1000;
let warming = null;

function providerKey(p) { return readEnv(EXTRA_PROVIDERS[p].env); }
export function configuredExtraProviders() { return Object.keys(EXTRA_PROVIDERS).filter((p) => providerKey(p)); }

async function fetchIds(p) {
  const pr = providerForModel(`${p}:probe`);
  const r = await providerFetch(pr, '/models', { method: 'GET', signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${p} /models ${r.status}`);
  const d = await r.json().catch(() => ({}));
  return (Array.isArray(d?.data) ? d.data : []).map((m) => String(m?.id || '')).filter(Boolean);
}

/* Обновить список моделей провайдеров (не чаще раза в час). Не бросает. */
export function warmCatalog() {
  const now = Date.now();
  const stale = configuredExtraProviders().filter((p) => !explicitList(p).length && (!cache[p] || now - cache[p].at > (cache[p].ids.length ? CACHE_MS : FAIL_MS)));
  if (!stale.length) return Promise.resolve();
  if (warming) return warming;
  warming = Promise.all(stale.map(async (p) => {
    try { cache[p] = { at: Date.now(), ids: await fetchIds(p) }; }
    catch (e) { cache[p] = { at: Date.now(), ids: [] }; console.warn('[catalog]', e.message); }
  })).finally(() => { warming = null; });
  return warming;
}
/* Подождать каталог не дольше ms (первый запрос на холодном сервере). */
export async function warmCatalogFor(ms = 700) {
  await Promise.race([warmCatalog(), new Promise((r) => setTimeout(r, ms))]);
}

function explicitList(p) {
  return readEnv(`${p.toUpperCase()}_MODELS`).split(',').map((x) => x.trim()).filter(Boolean);
}

/* Лучшие модели одного провайдера: «nim:z-ai/glm-5.2», … */
export function providerModels(p) {
  if (!providerKey(p)) return [];
  const explicit = explicitList(p);
  if (explicit.length) return explicit.map((id) => `${p}:${id}`);
  const ids = cache[p]?.ids || [];
  return ids
    .filter((id) => !NOT_CHAT.test(id) && strengthOf(id) >= 60)
    .sort((a, b) => strengthOf(b) - strengthOf(a) || a.length - b.length)
    .filter((id, i, arr) => arr.findIndex((x) => strengthOf(x) === strengthOf(id)) === i) // одна модель на «ступень»
    .slice(0, PER_PROVIDER)
    .map((id) => `${p}:${id}`);
}

/* Бесплатная часть цепочки Adan, от сильной к слабой.
   openRouterFree — модели OpenRouter (:free) из настроек чата. */
export function rankedFreeChain(openRouterFree = []) {
  const manual = readEnv('ADAN_CHAIN').split(',').map((x) => x.trim()).filter(Boolean);
  if (manual.length) return manual;
  const all = [
    ...configuredExtraProviders().flatMap(providerModels),
    ...(geminiApiKey() ? [geminiChatModel()] : []),
    ...openRouterFree
  ];
  const seen = new Set();
  return all
    .filter((m) => (seen.has(m) ? false : seen.add(m)))
    .map((m, i) => ({ m, s: strengthOf(m.replace(/^\w+:/, '')), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

/* Быстрые модели для служебных задач (JSON, заголовки): Groq и Cerebras отвечают за доли секунды. */
export function fastUtilityModels() {
  return ['groq', 'cerebras'].flatMap((p) => providerModels(p).slice(0, 1));
}

/* Для тестов: подставить список моделей провайдера. */
export function __setCatalog(p, ids) { cache[p] = { at: Date.now(), ids }; }
