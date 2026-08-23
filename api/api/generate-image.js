export const config = {
  maxDuration: 60
};

import { PRO_IMAGE_MODEL, FREE_IMAGE_MODEL, UTILITY_MODEL, envModel } from '../lib/models.js';

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
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,plan&limit=1`
  );
  return rows?.[0] || null;
}

/* ---------- Проверка: является ли пользователь Pro ---------- */

function isProUser(profile) {
  const r = String(profile?.role || '').toLowerCase();
  const p = String(profile?.plan || '').toLowerCase();
  return r === 'pro' || r === 'developer' || r === 'admin' || r === 'moderator' || p === 'pro';
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

const IMG_LIMITS = {
  free: { day: 7, week: 23, month: 50 },
  pro: { burstMessages: 15, burstWindowSec: 180, day: 200 }
};

async function checkImageAllowance(userId, profile, isPro) {
  const role = profile?.role || 'user';
  if (role === 'developer' || role === 'admin') return { ok: true };

  if (!userId) {
    if (!guestBurstAllowed()) {
      return { ok: false, status: 429, scope: 'burst', message: 'Слишком много изображений подряд. Подождите несколько минут.' };
    }
    return { ok: true };
  }

  try {
    if (isPro) {
      const cfg = IMG_LIMITS.pro;
      const [burst, day] = await Promise.all([
        countUsageSince(userId, new Date(Date.now() - cfg.burstWindowSec * 1000).toISOString()),
        countUsageSince(userId, startOfTodayIso())
      ]);
      if (burst >= cfg.burstMessages) return { ok: false, status: 429, scope: 'burst', message: 'Слишком много изображений подряд. Подождите пару минут.' };
      if (day >= cfg.day) return { ok: false, status: 429, scope: 'day', message: 'Достигнут суточный предел для Pro. Обратитесь в поддержку.' };
      return { ok: true };
    }
    const cfg = IMG_LIMITS.free;
    const [day, week, month] = await Promise.all([
      countUsageSince(userId, startOfTodayIso()),
      countUsageSince(userId, startOfWeekIso()),
      countUsageSince(userId, startOfMonthIso())
    ]);
    if (day >= cfg.day) return { ok: false, status: 429, scope: 'day', message: 'Дневной лимит исчерпан (7 в день). Обновится завтра или перейдите на Dynatos.' };
    if (week >= cfg.week) return { ok: false, status: 429, scope: 'week', message: 'Недельный лимит исчерпан (23 в неделю). Перейдите на Dynatos.' };
    if (month >= cfg.month) return { ok: false, status: 429, scope: 'month', message: 'Месячный лимит исчерпан (50 в месяц). Перейдите на Dynatos.' };
    return { ok: true };
  } catch (e) {
    console.warn('[generate-image] usage check failed (allowing):', compactErrorValue(e?.message, 200));
    return { ok: true };
  }
}

/* ---------- Модерация ---------- */

const FORBIDDEN_KEYWORDS = [
  'porn','porno','pornography','hentai','nsfw','nude','nudes','naked','sex','sexual','erotic','erotica',
  'genital','penis','vagina','breast','boob','ass','fetish','masturbat','orgasm','xxx','bikini',
  'порно','хентай','нюд','нюдс','голая','голый','голые','обнажённ','секс','сексуальн','эрот',
  'генитал','пенис','вагин','грудь','сосок','попка','попу','фетиш','мастурб','оргазм',
  'loli','lolicon','shotacon','underage','minor','child','kid','teen','preteen','pedophil','baby',
  'лоли','шотакон','несовершеннолет','малолет','ребёнок','ребенка','дети','подросток','педофил','малыш',
  'gore','bloodbath','decapitat','dismember','torture','mutilat','self-harm','suicide','massacre','snuff',
  'гор','кровав','обезглав','расчлен','пытк','увеч','самоповрежд','самоубийств','убить себя','резня','снафф',
  'cocaine','heroin','meth','lsd','ecstasy','drug deal','weapons','firearm','bomb','explosive','terrorist',
  'кокаин','героин','метамфетамин','наркотик','оружие','огнестрел','бомба','взрывчат','террорист',
  'deepfake nude','revenge porn','дипфейк','интим'
];

function isForbiddenPrompt(prompt = '') {
  const low = String(prompt || '').toLowerCase();
  return FORBIDDEN_KEYWORDS.some((kw) => low.includes(kw));
}

async function isPromptAllowedByAI(prompt) {
  const apiKey = readEnv('OPENAI_API_KEY');
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
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
        body: JSON.stringify({ model: envModel('IMAGE_MODERATOR_MODEL', UTILITY_MODEL), messages, max_tokens: 5, temperature: 0 })
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
   по умолчанию api.codex-api.online) — прямой api.openai.com нашим ключом не
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

async function generateViaOpenAI(prompt) {
  const apiKey = readEnv('OPENAI_IMAGE_API_KEY') || readEnv('OPENAI_API_KEY');
  if (!apiKey || isPlaceholderValue(apiKey)) {
    const err = new Error('OpenAI API key not configured for image generation');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const rawBase = readEnv('OPENAI_IMAGE_BASE_URL') || readEnv('OPENAI_BASE_URL');
  const baseUrl = String(isPlaceholderValue(rawBase) ? 'https://api.codex-api.online/v1' : rawBase).replace(/\/+$/, '');
  const model = envModel('OPENAI_IMAGE_MODEL', PRO_IMAGE_MODEL);
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
    55000, 'OpenAI image request timed out'
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
    const { prompt, userId, model } = req.body || {};
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

    // КЛЮЧЕВАЯ ЛОГИКА: Pro (Dynatos) → OpenAI gpt-image-2, Free (Adanatos) → Cloudflare Workers AI
    const userIsPro = isProUser(profile);
    const allowance = await checkImageAllowance(userId, profile, userIsPro);
    if (!allowance.ok) {
      return res.status(allowance.status || 429).json({
        error: { message: allowance.message, status: allowance.status || 429, scope: allowance.scope }
      });
    }

    // 4. Генерация
    let generated;
    try {
      if (userIsPro) {
        // Pro: OpenAI gpt-image-2
        generated = await generateViaOpenAI(cleanPrompt);
      } else {
        // Free: Cloudflare Workers AI (flux-1-schnell)
        generated = await generateViaCloudflare(cleanPrompt);
      }
    } catch (e) {
      if (e.code === 'NO_CREDENTIALS') {
        return res.status(500).json({ error: { message: userIsPro
          ? 'Ключ OpenAI для генерации изображений не настроен. Обратитесь в поддержку.'
          : 'Cloudflare credentials not configured' } });
      }
      const provider = userIsPro ? 'OpenAI' : 'Cloudflare';
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
