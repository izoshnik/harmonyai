import { hasProAccess, requireUser } from '../lib/auth.js';
export const config = {
  maxDuration: 60
};

import { PRO_IMAGE_MODEL, FREE_IMAGE_MODEL, UTILITY_MODEL, envModel, utilityEndpoint, utilityModel, providerBaseUrl } from '../lib/models.js';

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderValue(value = '') {
  const low = String(value || '').trim().toLowerCase();
  return !low || low === 'undefined' || low === 'null' || low === 'your_key_here';
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compactErrorValue(value, limit = 500) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return normalizeText(text).slice(0, limit);
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || 'Request timed out')), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* ---------- Supabase ---------- */

function buildSupabaseHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

async function supabaseRequest(path, init = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const headers = { ...buildSupabaseHeaders(), ...(init.headers || {}) };
  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, { ...init, headers }),
    8000,
    'Supabase request timed out'
  );
  let data = null;
  try { data = await response.json(); } catch (e) { data = null; }
  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || data?.error || `Supabase error ${response.status}`);
  }
  return data;
}

async function fetchProfile(userId) {
  if (!userId) return null;
  const rows = await supabaseRequest(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,plan,plan_expires_at&limit=1`
  );
  return rows?.[0] || null;
}

/* ---------- Проверка: является ли пользователь Pro ---------- */

function isProUser(profile){return hasProAccess(profile);
}

/* ---------- Учёт использования ---------- */

async function insertUsageEvent(userId) {
  if (!userId) return;
  try {
    await supabaseRequest('/rest/v1/usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: userId,
        model: 'image',
        tokens: 1,
        messages: 1,
        created_at: new Date().toISOString()
      }])
    });
  } catch (e) {
    console.warn('[generate-image] usage insert failed:', compactErrorValue(e?.message, 200));
  }
}

async function countUsageSince(userId, sinceIso) {
  const rows = await supabaseRequest(
    `/rest/v1/usage_events?select=messages&user_id=eq.${encodeURIComponent(userId)}&model=eq.image&created_at=gte.${encodeURIComponent(sinceIso)}&limit=100000`
  );
  return (rows || []).reduce((sum, r) => sum + (r.messages || 0), 0);
}

function startOfTodayIso() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function startOfWeekIso() {
  const d = new Date(); const day = d.getDay() || 7;
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (day - 1));
  return d.toISOString();
}
function startOfMonthIso() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1);
  return d.toISOString();
}

const GUEST_BUST = { windowMs: 10 * 60 * 1000, max: 3 };
const guestBurst = new Map();

function guestBurstAllowed() {
  const now = Date.now();
  const arr = (guestBurst.get('g') || []).filter((t) => now - t < GUEST_BUST.windowMs);
  if (arr.length >= GUEST_BUST.max) { guestBurst.set('g', arr); return false; }
  arr.push(now);
  guestBurst.set('g', arr);
  return true;
}

/* Лимиты генераций: Free — день / неделя / месяц, Pro — те же окна ×25
   (безлимита больше нет) + антифлуд. Числа наружу не называем. */
const IMG_LIMITS_FREE = { day: 7, week: 23, month: 50 };
const IMG_PRO_MULTIPLIER = 25;
const IMG_LIMITS_PRO = { day: IMG_LIMITS_FREE.day * IMG_PRO_MULTIPLIER, week: IMG_LIMITS_FREE.week * IMG_PRO_MULTIPLIER, month: IMG_LIMITS_FREE.month * IMG_PRO_MULTIPLIER };
const IMG_PRO_BURST = { images: 15, windowSec: 180 };

function nextDayIso() { const d = new Date(); d.setHours(24, 0, 0, 0); return d.toISOString(); }
function nextWeekIso() { const d = new Date(startOfWeekIso()); d.setDate(d.getDate() + 7); return d.toISOString(); }
function nextMonthIso() { const d = new Date(startOfMonthIso()); d.setMonth(d.getMonth() + 1); return d.toISOString(); }

async function checkImageAllowance(userId, profile, isPro) {
  const role = profile?.role || 'user';
  if (role === 'developer' || role === 'admin') return { ok: true };

  if (!userId) {
    if (!guestBurstAllowed()) {
      return { ok: false, status: 429, scope: 'burst', message: 'Слишком много изображений подряд. Подождите несколько минут.' };
    }
    return { ok: true };
  }

  const plan = isPro ? 'pro' : 'free';
  const cfg = isPro ? IMG_LIMITS_PRO : IMG_LIMITS_FREE;
  const upgrade = isPro ? '' : ' или перейдите на Pro';
  try {
    const [burst, day, week, month] = await Promise.all([
      isPro ? countUsageSince(userId, new Date(Date.now() - IMG_PRO_BURST.windowSec * 1000).toISOString()) : 0,
      countUsageSince(userId, startOfTodayIso()),
      countUsageSince(userId, startOfWeekIso()),
      countUsageSince(userId, startOfMonthIso())
    ]);
    if (isPro && burst >= IMG_PRO_BURST.images) return { ok: false, status: 429, scope: 'burst', plan, message: 'Слишком много изображений подряд. Подождите пару минут.' };
    if (day >= cfg.day) return { ok: false, status: 429, scope: 'day', plan, resetAt: nextDayIso(), message: `Дневной лимит изображений исчерпан. Он обновится завтра${upgrade}.` };
    if (week >= cfg.week) return { ok: false, status: 429, scope: 'week', plan, resetAt: nextWeekIso(), message: `Недельный лимит изображений исчерпан. Он обновится в понедельник${upgrade}.` };
    if (month >= cfg.month) return { ok: false, status: 429, scope: 'month', plan, resetAt: nextMonthIso(), message: `Месячный лимит изображений исчерпан. Он обновится 1-го числа${upgrade}.` };
    return { ok: true };
  } catch (e) {
    console.warn('[generate-image] usage check failed (allowing):', compactErrorValue(e?.message, 200));
    return { ok: true };
  }
}

/* ---------- Модерация ---------- */

/* Сравнение идёт ПО НАЧАЛУ СЛОВА, а не по подстроке. Раньше 'гор' ловил «горы»,
   «горн», «Игорь», 'minor' — «A minor», 'попу' — «популярный», 'пытк' — «попытка»,
   'meth' — «Something», и безобидные музыкальные запросы отклонялись.
   Короткие английские корни (sex, ass, meth…) сверяются со словом целиком.
   Слова о детях сами по себе не запрещены («детский хор», «малыш за пианино»),
   запрещено только их сочетание с сексуальным контекстом. */
const SEXUAL_KEYWORDS = [
  'porn','hentai','nsfw','nude','naked','sexual','sexy','erotic','genital','penis','vagina','breast','boob',
  'fetish','masturbat','orgasm','bikini','lingerie','topless',
  'порн','хентай','нюд','голая','голый','голые','голых','обнажён','обнажен','секс','эрот',
  'генитал','пенис','вагин','грудь','груди','сосок','соски','попк','фетиш','мастурб','оргазм','интим','бельё','белье'
];
const SEXUAL_EXACT = ['sex','ass','xxx','tits'];
const MINOR_KEYWORDS = [
  'child','children','kid','kids','teen','teenager','preteen','baby','toddler','schoolgirl','schoolboy',
  'ребён','ребен','дет','малыш','подрост','школьни','девочк','мальчик'
];
const ALWAYS_FORBIDDEN = [
  'loli','shotacon','underage','pedophil','несовершеннолет','малолет','шотакон','педофил',
  'bloodbath','decapitat','dismember','mutilat','self-harm','suicide','massacre','snuff','torture',
  'кровав','обезглав','расчлен','пытк','пытать','изувеч','самоповрежд','самоубийств','резня','резню','снафф',
  'cocaine','heroin','methamphetamine','ecstasy','firearm','explosive','terrorist',
  'кокаин','героин','метамфетамин','наркотик','огнестрел','взрывчат','террорист','дипфейк','deepfake',
  ...SEXUAL_KEYWORDS
];
const ALWAYS_FORBIDDEN_EXACT = ['gore','meth','lsd','bomb','bombs','weapon','weapons','gun','guns','бомба','бомбу','оружие','оружия','убить','убей'];
const ALWAYS_FORBIDDEN_PHRASES = ['убить себя','drug deal','revenge porn'];

function promptWords(text = '') {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
}
function hasStem(words, stems) {
  return stems.some((st) => { const s = st.replace(/ё/g, 'е'); return words.some((w) => w.startsWith(s)); });
}
function hasExact(words, list) {
  return list.some((x) => words.includes(x.replace(/ё/g, 'е')));
}

function isForbiddenPrompt(prompt = '') {
  const low = String(prompt || '').toLowerCase().replace(/ё/g, 'е');
  const words = promptWords(low);
  if (ALWAYS_FORBIDDEN_PHRASES.some((p) => low.includes(p))) return true;
  if (hasStem(words, ALWAYS_FORBIDDEN) || hasExact(words, ALWAYS_FORBIDDEN_EXACT) || hasExact(words, SEXUAL_EXACT)) return true;
  // Дети + любой намёк на сексуальный контекст — всегда отказ (дубль защиты к ИИ-модератору).
  if (hasStem(words, MINOR_KEYWORDS) && (hasStem(words, SEXUAL_KEYWORDS) || hasExact(words, SEXUAL_EXACT))) return true;
  return false;
}

async function isPromptAllowedByAI(prompt) {
  const apiKey = utilityEndpoint().apiKey;
  const baseUrl = utilityEndpoint().baseUrl;
  if (!apiKey || isPlaceholderValue(apiKey) || isPlaceholderValue(baseUrl)) return true;
  const messages = [
    { role: 'system', content: 'Ты модератор. Ответь ровно одним словом: ALLOW или DENY. Запрещай: 18+, насилие, наркотики, оружие. Разрешай: природа, объекты, архитектура, люди в одежде.' },
    { role: 'user', content: `Запрос: ${prompt}` }
  ];
  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: utilityModel('IMAGE_MODERATOR_MODEL'), messages, max_tokens: 5, temperature: 0 })
      }),
      20000, 'AI moderator timed out'
    );
    if (!response.ok) return true;
    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    const verdict = String(data?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    return !verdict.startsWith('DENY');
  } catch (e) {
    console.warn('[generate-image] AI moderator error, fail-open:', compactErrorValue(e?.message, 200));
    return true;
  }
}

const MODERATION_REJECT_MESSAGE = 'Запрос отклонён: запрещённый контент. Сформулируйте описание иначе.';

/* ---------- Генерация через Cloudflare Workers AI (бесплатные — Adanatos) ---------- */

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function generateViaCloudflare(prompt) {
  const accountId = readEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = readEnv('CLOUDFLARE_API_TOKEN');
  const model = readEnv('CLOUDFLARE_IMAGE_MODEL') || FREE_IMAGE_MODEL;
  if (!accountId || isPlaceholderValue(accountId) || !apiToken || isPlaceholderValue(apiToken)) {
    const err = new Error('Cloudflare credentials not configured');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const response = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    }),
    45000, 'Cloudflare request timed out'
  );
  if (!response.ok) {
    let details = null;
    try { details = await response.json(); } catch (e) { details = null; }
    const err = new Error(`Cloudflare error ${response.status}`);
    err.code = 'CF_ERROR'; err.details = details; err.status = response.status;
    throw err;
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const b64 = data?.result?.image || data?.image;
    if (!b64) { const err = new Error('Cloudflare returned no image'); err.code = 'CF_NO_IMAGE'; throw err; }
    return { base64: b64, mime: 'image/png' };
  }
  if (contentType.includes('image/')) {
    const buf = await response.arrayBuffer();
    const mime = contentType.split(';')[0].trim() || 'image/png';
    return { base64: bytesToBase64(new Uint8Array(buf)), mime };
  }
  try {
    const data = await response.json();
    const b64 = data?.result?.image || data?.image;
    if (b64) return { base64: b64, mime: 'image/png' };
  } catch (e) {}
  const buf = await response.arrayBuffer().catch(() => null);
  if (!buf) { const err = new Error('Cloudflare unsupported content-type: ' + contentType); err.code = 'CF_BAD_CONTENT'; throw err; }
  return { base64: bytesToBase64(new Uint8Array(buf)), mime: 'image/png' };
}

/* ---------- Генерация через gpt-image-2 (Pro — Dynatos) ----------
   Идём через тот же OpenAI-совместимый шлюз, что и чат (OPENAI_BASE_URL,
   по умолчанию api.pro-ai.online) — прямой api.openai.com нашим ключом не
   открывается. Отдельный хост/ключ можно задать через OPENAI_IMAGE_BASE_URL /
   OPENAI_IMAGE_API_KEY, если картинки живут на другом провайдере.
   response_format НЕ передаём: gpt-image возвращает b64_json по умолчанию и
   на некоторых шлюзах ругается на этот параметр. Ответ принимаем в обоих
   видах — b64_json и url (второй докачиваем сами). */

async function fetchRemoteImageAsBase64(url) {
  const response = await withTimeout(fetch(url), 25000, 'Image download timed out');
  if (!response.ok) {
    const err = new Error(`Image download failed ${response.status}`);
    err.code = 'IMG_DOWNLOAD_ERROR'; err.status = response.status;
    throw err;
  }
  const mime = (response.headers.get('content-type') || 'image/png').split(';')[0].trim() || 'image/png';
  const buf = await response.arrayBuffer();
  return { base64: bytesToBase64(new Uint8Array(buf)), mime };
}

async function generateViaOpenAI(prompt, modelOverride) {
  const apiKey = readEnv('OPENAI_IMAGE_API_KEY') || readEnv('OPENAI_API_KEY');
  if (!apiKey || isPlaceholderValue(apiKey)) {
    const err = new Error('OpenAI API key not configured for image generation');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const rawBase = readEnv('OPENAI_IMAGE_BASE_URL') || providerBaseUrl();
  const baseUrl = String(isPlaceholderValue(rawBase) ? 'https://api.pro-ai.online/v1' : rawBase).replace(/\/+$/, '');
  const model = modelOverride || envModel('OPENAI_IMAGE_MODEL', PRO_IMAGE_MODEL);
  const response = await withTimeout(
    fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: '1024x1024'
      })
    }),
    40000, 'OpenAI image request timed out'
  );
  let data = {};
  try { data = await response.json(); } catch (e) { data = {}; }
  if (!response.ok || data?.error) {
    const err = new Error(data?.error?.message || `OpenAI image error ${response.status}`);
    err.code = 'OAI_ERROR'; err.status = response.status;
    throw err;
  }
  const item = data?.data?.[0] || {};
  const b64 = item.b64_json || item.b64 || '';
  if (b64) {
    // Формат ответа отличается от шлюза к шлюзу: где-то mime_type, где-то output_format ("png"/"webp").
    const mimeRaw = String(item.mime_type || '').trim().toLowerCase();
    const fmt = String(item.output_format || '').trim().toLowerCase().replace(/^image\//, '');
    let mime = 'image/png';
    if (mimeRaw.startsWith('image/')) mime = mimeRaw;
    else if (fmt) mime = 'image/' + fmt;
    return { base64: b64, mime };
  }
  const url = item.url || item.image_url || '';
  if (url) return await fetchRemoteImageAsBase64(url);
  const err = new Error('OpenAI returned no image data');
  err.code = 'OAI_NO_IMAGE';
  throw err;
}

/* ---------- Pro: closerouter.dev (gpt-image-2.5-sunburst → flare) ----------
   POST /v1/images/generations и /v1/images/edits (картинки — data:URL в JSON).
   Ответ 200 — url или b64_json; 202 (object=image.request) — генерация ещё идёт,
   статус по GET /v1/media/requests/{id}. Повторять POST при неясном исходе нельзя
   (outcome_unknown) — это создало бы вторую платную генерацию. */
const CLOSEROUTER_MODELS = ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'];

function findImageInResponse(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const list = Array.isArray(obj.data) ? obj.data : (Array.isArray(obj.output) ? obj.output : null);
  if (list && list.length) {
    const r = openAiImageFromResponse({ data: list });
    if (r.base64 || r.url) return r;
  }
  if (typeof obj.b64_json === 'string') return openAiImageFromResponse({ data: [obj] });
  if (typeof obj.url === 'string' && /^https?:/.test(obj.url) && !/\/media\/requests\//.test(obj.url)) return { url: obj.url };
  for (const key of ['result', 'response', 'outputs', 'images', 'image']) {
    const v = obj[key];
    if (Array.isArray(v) && v.length) {
      const first = v[0];
      if (typeof first === 'string' && /^https?:/.test(first)) return { url: first };
      const r = findImageInResponse(first, depth + 1);
      if (r) return r;
    } else if (v && typeof v === 'object') {
      const r = findImageInResponse(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

async function closeRouterImage(model, prompt, image, deadline) {
  const apiKey = readEnv('CLOSEROUTER_API_KEY');
  if (!apiKey || isPlaceholderValue(apiKey)) { const err = new Error('CLOSEROUTER_API_KEY not configured'); err.code = 'NO_CREDENTIALS'; throw err; }
  const base = (readEnv('CLOSEROUTER_BASE_URL') || 'https://api.closerouter.dev/v1').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const body = image
    ? { model, prompt, n: 1, size: '1024x1024', images: [`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`] }
    : { model, prompt, n: 1, size: '1024x1024' };
  const left = () => Math.max(3000, deadline - Date.now());
  const response = await withTimeout(fetch(`${base}/images/${image ? 'edits' : 'generations'}`, { method: 'POST', headers, body: JSON.stringify(body) }), left(), 'closerouter timed out');
  let data = {};
  try { data = await response.json(); } catch (e) { data = {}; }
  if (!response.ok && response.status !== 202) {
    const err = new Error(data?.error?.message || data?.message || `closerouter error ${response.status}`);
    err.code = 'CR_ERROR'; err.status = response.status; throw err;
  }
  let found = findImageInResponse(data);
  const reqId = data?.id || data?.request_id || data?.request?.id;
  // Генерация ещё идёт — опрашиваем статус, пока есть время.
  while (!found && reqId && Date.now() < deadline - 3000) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await withTimeout(fetch(`${base}/media/requests/${encodeURIComponent(reqId)}`, { headers: { Authorization: `Bearer ${apiKey}` } }), 10000, 'closerouter poll timed out').catch(() => null);
    if (!st) continue;
    const sd = await st.json().catch(() => ({}));
    if (/fail|error|cancel/i.test(String(sd?.status || ''))) { const err = new Error(sd?.error?.message || 'closerouter request failed'); err.code = 'CR_ERROR'; throw err; }
    found = findImageInResponse(sd);
  }
  if (!found) { const err = new Error('closerouter returned no image'); err.code = 'CR_NO_IMAGE'; throw err; }
  if (found.base64) return found;
  return await fetchRemoteImageAsBase64(found.url);
}

/* Pro: sunburst → flare (closerouter) → gpt-image-2.5 → gpt-image-2 (pro-ai.online). */
async function generatePro(prompt, image) {
  const deadline = Date.now() + 52000; // функция живёт 60 с
  const errors = [];
  if (readEnv('CLOSEROUTER_API_KEY')) {
    for (const model of CLOSEROUTER_MODELS) {
      if (Date.now() > deadline - 8000) break;
      try { return await closeRouterImage(model, prompt, image, deadline); }
      catch (e) { errors.push(`${model}: ${e.message}`); console.warn('[generate-image] closerouter', model, 'failed:', compactErrorValue(e?.message, 200)); }
    }
  }
  for (const model of [readEnv('OPENAI_IMAGE_MODEL') || 'gpt-image-2.5', PRO_IMAGE_MODEL]) {
    if (Date.now() > deadline - 8000) break;
    try { return image ? await editViaOpenAI(prompt, image, model) : await generateViaOpenAI(prompt, model); }
    catch (e) { errors.push(`${model}: ${e.message}`); console.warn('[generate-image] pro-ai', model, 'failed:', compactErrorValue(e?.message, 200)); if (e.code === 'NO_CREDENTIALS') break; }
  }
  const err = new Error(errors.join(' | ') || 'no image provider'); err.code = 'ALL_FAILED'; throw err;
}

/* ---------- Free: запасной бесплатный генератор Pollinations ----------
   Без ключа и регистрации; с POLLINATIONS_TOKEN — без водяного знака и выше лимиты. */
async function generateViaPollinations(prompt) {
  const token = readEnv('POLLINATIONS_TOKEN');
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).slice(0, 800))}?width=1024&height=1024&model=flux&nologo=true&private=true&seed=${seed}`;
  const response = await withTimeout(fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), 45000, 'Pollinations timed out');
  if (!response.ok) { const err = new Error(`Pollinations error ${response.status}`); err.code = 'PL_ERROR'; throw err; }
  const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!mime.startsWith('image/')) { const err = new Error('Pollinations returned no image'); err.code = 'PL_ERROR'; throw err; }
  return { base64: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mime };
}

async function generateFree(prompt) {
  try { return await generateViaCloudflare(prompt); }
  catch (e) {
    console.warn('[generate-image] Cloudflare failed, trying Pollinations:', compactErrorValue(e?.message, 200));
    return await generateViaPollinations(await toEnglishImagePrompt(prompt));
  }
}

/* ---------- Редактирование загруженного фото ----------
   Pro — gpt-image-2 через /images/edits (тот же шлюз, что и генерация).
   Free — Cloudflare Workers AI img2img (stable-diffusion-v1-5-img2img):
   бесплатная модель хуже понимает русский, поэтому инструкцию сначала
   переводим служебной моделью в короткий английский промпт. */
const FREE_EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';

function parseImageDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) return null;
  return { mime: m[1].toLowerCase().replace('jpg', 'jpeg'), bytes };
}

async function toEnglishImagePrompt(prompt) {
  const ep = utilityEndpoint();
  if (!ep.apiKey || isPlaceholderValue(ep.apiKey)) return prompt;
  try {
    const response = await withTimeout(fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: utilityModel('IMAGE_MODERATOR_MODEL'), temperature: 0, max_tokens: 120, messages: [
        { role: 'system', content: 'Rewrite the user\'s photo editing instruction as a short English prompt for an image-to-image model describing the desired result. Output only the prompt.' },
        { role: 'user', content: prompt }
      ] })
    }), 15000, 'translate timed out');
    const data = await response.json().catch(() => ({}));
    const out = String(data?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    return out && out.length < 600 ? out : prompt;
  } catch (e) { return prompt; }
}

function openAiImageFromResponse(data) {
  const item = data?.data?.[0] || {};
  const b64 = item.b64_json || item.b64 || '';
  if (b64) {
    const mimeRaw = String(item.mime_type || '').trim().toLowerCase();
    const fmt = String(item.output_format || '').trim().toLowerCase().replace(/^image\//, '');
    return { base64: b64, mime: mimeRaw.startsWith('image/') ? mimeRaw : fmt ? 'image/' + fmt : 'image/png' };
  }
  return { url: item.url || item.image_url || '' };
}

async function editViaOpenAI(prompt, image, modelOverride) {
  const apiKey = readEnv('OPENAI_IMAGE_API_KEY') || readEnv('OPENAI_API_KEY');
  if (!apiKey || isPlaceholderValue(apiKey)) { const err = new Error('OpenAI API key not configured'); err.code = 'NO_CREDENTIALS'; throw err; }
  const rawBase = readEnv('OPENAI_IMAGE_BASE_URL') || providerBaseUrl();
  const baseUrl = String(isPlaceholderValue(rawBase) ? 'https://api.pro-ai.online/v1' : rawBase).replace(/\/+$/, '');
  const form = new FormData();
  form.append('model', modelOverride || envModel('OPENAI_IMAGE_MODEL', PRO_IMAGE_MODEL));
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('image', new Blob([image.bytes], { type: image.mime }), 'image.' + (image.mime.split('/')[1] || 'png'));
  const response = await withTimeout(fetch(`${baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }), 90000, 'OpenAI image edit timed out');
  let data = {};
  try { data = await response.json(); } catch (e) { data = {}; }
  if (!response.ok || data?.error) { const err = new Error(data?.error?.message || `OpenAI image edit error ${response.status}`); err.code = 'OAI_ERROR'; err.status = response.status; throw err; }
  const r = openAiImageFromResponse(data);
  if (r.base64) return r;
  if (r.url) return await fetchRemoteImageAsBase64(r.url);
  const err = new Error('OpenAI returned no image data'); err.code = 'OAI_NO_IMAGE'; throw err;
}

async function editViaCloudflare(prompt, image) {
  const accountId = readEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = readEnv('CLOUDFLARE_API_TOKEN');
  if (!accountId || isPlaceholderValue(accountId) || !apiToken || isPlaceholderValue(apiToken)) { const err = new Error('Cloudflare credentials not configured'); err.code = 'NO_CREDENTIALS'; throw err; }
  const model = readEnv('CLOUDFLARE_EDIT_MODEL') || FREE_EDIT_MODEL;
  const response = await withTimeout(fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: await toEnglishImagePrompt(prompt), image: Array.from(image.bytes), strength: 0.6, num_steps: 20, guidance: 7.5 })
  }), 60000, 'Cloudflare edit timed out');
  if (!response.ok) { const err = new Error(`Cloudflare error ${response.status}`); err.code = 'CF_ERROR'; err.status = response.status; throw err; }
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    const data = await response.json();
    const b64 = data?.result?.image || data?.image;
    if (!b64) { const err = new Error('Cloudflare returned no image'); err.code = 'CF_NO_IMAGE'; throw err; }
    return { base64: b64, mime: 'image/png' };
  }
  const buf = await response.arrayBuffer();
  return { base64: bytesToBase64(new Uint8Array(buf)), mime: type.startsWith('image/') ? type.split(';')[0] : 'image/png' };
}

/* ---------- Supabase Storage ---------- */

function base64ToBytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function safeStorageSegment(value) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return clean || 'guest';
}

async function uploadImageToStorage(base64, mime, userId) {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    const err = new Error('Supabase not configured for image storage');
    err.code = 'NO_SUPABASE';
    throw err;
  }
  const bucket = 'generated-images';
  const ext = (mime && mime.split('/')[1]) || 'png';
  const path = `${safeStorageSegment(userId)}/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  const bytes = base64ToBytes(base64);
  const uploadResp = await withTimeout(
    fetch(`${baseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': mime || 'image/png',
        'x-upsert': 'false'
      },
      body: bytes
    }),
    20000, 'Supabase storage upload timed out'
  );
  if (!uploadResp.ok) {
    let details = null;
    try { details = await uploadResp.json(); } catch (e) { details = null; }
    const err = new Error('Supabase storage upload failed');
    err.code = 'STORAGE_ERROR'; err.details = details; err.status = uploadResp.status;
    throw err;
  }
  return `${baseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

/* ---------- Handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const user=await requireUser(req,res);if(!user)return;const userId=user.id;
    const { prompt, model, image, mode } = req.body || {};
    // Редактирование присланного фото (mode:'edit' + image: data URL).
    const editImage = mode === 'edit' || image ? parseImageDataUrl(image) : null;
    if ((mode === 'edit' || image) && !editImage) {
      return res.status(400).json({ error: { message: 'Фото для редактирования не прочиталось. Пришлите PNG или JPEG до 6 МБ.' } });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: { message: 'Пустой запрос на генерацию изображения' } });
    }
    const cleanPrompt = normalizeText(prompt).slice(0, 1200);

    // 1. Блок-лист модерации
    if (isForbiddenPrompt(cleanPrompt)) {
      return res.status(400).json({ error: { message: MODERATION_REJECT_MESSAGE, scope: 'moderation' } });
    }
    // 2. ИИ-фильтр
    const allowed = await isPromptAllowedByAI(cleanPrompt);
    if (!allowed) {
      return res.status(400).json({ error: { message: MODERATION_REJECT_MESSAGE, scope: 'moderation' } });
    }

    // 3. Профиль пользователя + проверка лимитов (параллельно)
    let profile = null;
    if (userId) {
      try { profile = await fetchProfile(userId); } catch (e) {
        console.warn('[generate-image] profile fetch failed:', compactErrorValue(e?.message, 200));
      }
    }

    // КЛЮЧЕВАЯ ЛОГИКА: Pro (Dynatos) → closerouter gpt-image-2.5 (запасной — pro-ai.online), Free (Adan) → Cloudflare / Pollinations
    const userIsPro = isProUser(profile);
    const allowance = await checkImageAllowance(userId, profile, userIsPro);
    if (!allowance.ok) {
      return res.status(allowance.status || 429).json({
        error: { message: allowance.message, status: allowance.status || 429, scope: allowance.scope, resetAt: allowance.resetAt || null, plan: allowance.plan || null }
      });
    }

    // 4. Генерация
    let generated;
    try {
      if (editImage) {
        generated = userIsPro ? await generatePro(cleanPrompt, editImage) : await editViaCloudflare(cleanPrompt, editImage);
      } else if (userIsPro) {
        // Pro: closerouter gpt-image-2.5-sunburst → flare → pro-ai gpt-image-2.5 → gpt-image-2
        generated = await generatePro(cleanPrompt, null);
      } else {
        // Free: Cloudflare Workers AI, при сбое или исчерпанной квоте — Pollinations
        generated = await generateFree(cleanPrompt);
      }
    } catch (e) {
      if (e.code === 'NO_CREDENTIALS') {
        return res.status(500).json({ error: { message: userIsPro
          ? 'Ключ OpenAI для генерации изображений не настроен. Обратитесь в поддержку.'
          : 'Cloudflare credentials not configured' } });
      }
      const provider = userIsPro ? 'gpt-image' : 'бесплатный генератор';
      console.error(`[generate-image] ${provider} failed:`, compactErrorValue(e?.message, 300));
      return res.status(502).json({
        error: { message: `Не удалось сгенерировать изображение (${provider}).`, details: e.message }
      });
    }

    // 5. Загрузка в Supabase Storage
    let publicUrl;
    try {
      publicUrl = await uploadImageToStorage(generated.base64, generated.mime, userId);
    } catch (e) {
      console.error('[generate-image] storage upload failed:', compactErrorValue(e?.message, 300));
      return res.status(502).json({
        error: { message: 'Изображение сгенерировано, но не удалось сохранить в хранилище.', details: e.message }
      });
    }

    // 6. Учёт использования
    await insertUsageEvent(userId);

    return res.status(200).json({ image: publicUrl });
  } catch (error) {
    console.error('[generate-image] handler error:', compactErrorValue(error?.message, 500));
    return res.status(500).json({ error: { message: error?.message || 'Внутренняя ошибка сервера' } });
  }
}
