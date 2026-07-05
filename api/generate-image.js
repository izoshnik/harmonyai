export const config = {
  maxDuration: 60
};

/* ============================================================================
   Генерация изображений через Cloudflare Workers AI.
   Полностью изолирована от api/chat.js (Codex API): текст/фото-анализ/файлы
   по-прежнему идут через api/chat, а этот хендлер — отдельный путь только для
   генерации картинок по текстовому промпту.

   Поток:
     1. Валидация prompt.
     2. Модерация: блок-лист ключевых слов → ИИ-фильтр (gpt-5.4-mini) ALLOW/DENY.
     3. Лимиты по usage_events (model='image'): free 7/день, 23/неделя, 50/месяц;
        pro — burst + суточный потолок (защита от злоупотребления).
     4. Запрос к Cloudflare Workers AI (flux-1-schnell по умолчанию).
     5. Оба формата ответа: JSON {result:{image:base64}} или сырые PNG-байты.
     6. Загрузка картинки в Supabase Storage (bucket generated-images) через service role.
     7. Клиенту отдаётся публичный URL картинки. */

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderValue(value = '') {
  const low = String(value || '').trim().toLowerCase();
  return !low || low === 'undefined' || low === 'null' || low === 'cfut_icTzeJWWO30mizQ1WlTPyqpKXa6knjOufukyGUP600979c48';
}

function normalizeText(text = '') {
  return String(text)
    .replace(/ /g, ' ')
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- Supabase (service role) ---------- */

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
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
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

/* ---------- Учёт использования (usage_events, model='image') ---------- */

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

// In-memory burst-защита для гостей (без userId) — инстанс Vercel-функции.
const GUEST_BUST = { windowMs: 10 * 60 * 1000, max: 3 };
const guestBurst = new Map();

function guestBurstAllowed() {
  const now = Date.now();
  const arr = (guestBurst.get('g') || []).filter((t) => now - t < GUEST_BUST.windowMs);
  if (arr.length >= GUEST_BUST.max) {
    guestBurst.set('g', arr);
    return false;
  }
  arr.push(now);
  guestBurst.set('g', arr);
  return true;
}

const IMG_LIMITS = {
  // free (Adanatos-план): жёсткие лимиты по запросам пользователя.
  free: { day: 7, week: 23, month: 50 },
  // pro (Dynatos-план): формально безлимит, но защищён «мягкими» потолками от скриптов.
  pro: { burstMessages: 15, burstWindowSec: 180, day: 200 }
};

// Возвращает {ok} или {ok:false, status, message, scope}.
async function checkImageAllowance(userId, profile, requestedModel) {
  const role = profile?.role || 'user';
  if (role === 'developer' || role === 'admin') return { ok: true };

  // Гости — только in-memory burst.
  if (!userId) {
    if (!guestBurstAllowed()) {
      return {
        ok: false, status: 429, scope: 'burst',
        message: 'Слишком много изображений подряд. Подождите несколько минут — это временная защита от перегрузки.'
      };
    }
    return { ok: true };
  }

  const isPro = requestedModel === 'pro';
  try {
    if (isPro) {
      const cfg = IMG_LIMITS.pro;
      const [burst, day] = await Promise.all([
        countUsageSince(userId, new Date(Date.now() - cfg.burstWindowSec * 1000).toISOString()),
        countUsageSince(userId, startOfTodayIso())
      ]);
      if (burst >= cfg.burstMessages) {
        return {
          ok: false, status: 429, scope: 'burst',
          message: 'Слишком много изображений подряд. Подождите пару минут — это временная защита от перегрузки.'
        };
      }
      if (day >= cfg.day) {
        return {
          ok: false, status: 429, scope: 'day',
          message: 'Достигнут суточный предел защиты от злоупотребления для генерации изображений. Он очень высок — если вы достигли его при обычном использовании, обратитесь в поддержку.'
        };
      }
      return { ok: true };
    }
    const cfg = IMG_LIMITS.free;
    const [day, week, month] = await Promise.all([
      countUsageSince(userId, startOfTodayIso()),
      countUsageSince(userId, startOfWeekIso()),
      countUsageSince(userId, startOfMonthIso())
    ]);
    if (day >= cfg.day) {
      return {
        ok: false, status: 429, scope: 'day',
        message: 'Дневной лимит генерации изображений исчерпан (7 в день). Он обновится завтра, либо перейдите на Dynatos для работы без ограничений.'
      };
    }
    if (week >= cfg.week) {
      return {
        ok: false, status: 429, scope: 'week',
        message: 'Недельный лимит генерации изображений исчерпан (23 в неделю). Он обновится в начале недели, либо перейдите на Dynatos для работы без ограничений.'
      };
    }
    if (month >= cfg.month) {
      return {
        ok: false, status: 429, scope: 'month',
        message: 'Месячный лимит генерации изображений исчерпан (50 в месяц). Он обновится в начале следующего месяца, либо перейдите на Dynatos для работы без ограничений.'
      };
    }
    return { ok: true };
  } catch (e) {
    // Учётная таблица недоступна — не блокируем пользователя, но логируем.
    console.warn('[generate-image] usage check failed (allowing request):', compactErrorValue(e?.message, 200));
    return { ok: true };
  }
}

/* ---------- Модерация ---------- */

// Блок-лист ключевых слов (рус.+англ., регистронезависимо). Первый, дешёвый барьер.
const FORBIDDEN_KEYWORDS = [
  // сексуальное / 18+
  'porn', 'porno', 'pornography', 'hentai', 'nsfw', 'nude', 'nudes', 'naked',
  'sex', 'sexual', 'erotic', 'erotica', 'genital', 'penis', 'vagina', 'breast',
  'boob', 'ass', 'fetish', 'masturbat', 'orgasm', 'xxx', 'bikini',
  'порно', 'хентай', 'нюд', 'нюдс', 'голая', 'голый', 'голые', 'обнажённ',
  'секс', 'сексуальн', 'эрот', 'генитал', 'пенис', 'вагин', 'грудь', 'сосок',
  'попка', 'попу', 'фетиш', 'мастурб', 'оргазм', 'нижнее бельё', 'купальник',
  // несовершеннолетние
  'loli', 'lolicon', 'shotacon', 'underage', 'minor', 'child', 'kid', 'teen',
  'preteen', 'pedophil', 'baby',
  'лоли', 'шотакон', 'несовершеннолет', 'малолет', 'ребёнок', 'ребенка', 'дети',
  'подросток', 'педофил', 'малыш',
  // насилие / gore
  'gore', 'bloodbath', 'decapitat', 'dismember', 'torture', 'mutilat',
  'self-harm', 'suicide', 'kill myself', 'massacre', 'snuff',
  'гор', 'кровав', 'обезглав', 'расчлен', 'пытк', 'увеч', 'самоповрежд',
  'самоубийств', 'убить себя', 'резня', 'снафф',
  // оружие / наркотики / незаконное
  'cocaine', 'heroin', 'meth', 'lsd', 'ecstasy', 'weed drug', 'marijuana',
  'drug deal', 'weapons', 'firearm', 'bomb', 'explosive', 'terrorist', 'terrorism',
  'кокаин', 'героин', 'метамфетамин', 'наркотик', 'наркота', 'оружие',
  'огнестрел', 'бомба', 'взрывчат', 'террорист', 'терроризм',
  // реальные личности в унизительном виде — общие маркеры
  'deepfake nude', 'revenge porn', 'дипфейк', 'интим'
];

function isForbiddenPrompt(prompt = '') {
  const low = String(prompt || '').toLowerCase();
  if (!low) return false;
  return FORBIDDEN_KEYWORDS.some((kw) => low.includes(kw));
}

// ИИ-фильтр через текстовую модель Codex (gpt-5.4-mini). Второй барьер —
// ловит завуалированные формулировки, которые пропускает блок-лист.
async function isPromptAllowedByAI(prompt) {
  const apiKey = readEnv('OPENAI_API_KEY');
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  if (!apiKey || isPlaceholderValue(apiKey) || isPlaceholderValue(baseUrl)) {
    // Без ключа модератора — fail-open (не блокируем), но логируем.
    console.warn('[generate-image] AI moderator unavailable (no OPENAI key), skipping AI filter');
    return true;
  }
  const messages = [
    {
      role: 'system',
      content: [
        'Ты модератор запросов на генерацию изображений.',
        'Ответь ровно одним словом: ALLOW — если запрос безопасен, или DENY — если запрещён.',
        'Запрещай категорически: 18+ и сексуальный контент, обнажённую натуру, несовершеннолетних в любом подобном контексте,',
        'насилие/gore/пытки/расчленёнку, самоповреждение и суицид, оружие, наркотики, незаконные действия,',
        'реальных людей в унизительном или сексуальном виде, дипфейки, разжигание ненависти.',
        'Разрешай: обычные объекты, природу, животных, людей в одежде, архитектуру, абстракции, музыку/ноты, быт.',
        'Ответ — только ALLOW или DENY, без пояснений.'
      ].join('\n')
    },
    { role: 'user', content: `Запрос: ${prompt}` }
  ];
  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-5.4-mini', messages, max_tokens: 5, temperature: 0 })
      }),
      20000,
      'AI moderator timed out'
    );
    if (!response.ok) {
      console.warn('[generate-image] AI moderator non-ok, fail-open:', response.status);
      return true;
    }
    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    const verdict = String(data?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    if (!verdict) return true;
    // По умолчанию разрешаем; DENY запрещаем; всё остальное трактуем как ALLOW.
    return !verdict.startsWith('DENY');
  } catch (e) {
    console.warn('[generate-image] AI moderator error, fail-open:', compactErrorValue(e?.message, 200));
    return true;
  }
}

const MODERATION_REJECT_MESSAGE =
  'Запрос отклонён: запрещённый контент (18+, насилие, нелегальное или унизительное). Сформулируйте описание иначе.';

/* ---------- Cloudflare Workers AI ---------- */

function bytesToBase64(bytes) {
  // Node 20: Buffer.from(uint8).toString('base64')
  return Buffer.from(bytes).toString('base64');
}

async function generateViaCloudflare(prompt) {
  const accountId = readEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = readEnv('CLOUDFLARE_API_TOKEN');
  const model = readEnv('CLOUDFLARE_IMAGE_MODEL') || '@cf/black-forest-labs/flux-1-schnell';
  if (!accountId || isPlaceholderValue(accountId) || !apiToken || isPlaceholderValue(apiToken)) {
    const err = new Error('Cloudflare credentials not configured');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const response = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    }),
    45000,
    'Cloudflare request timed out'
  );

  if (!response.ok) {
    let details = null;
    try { details = await response.json(); } catch (e) { details = null; }
    const err = new Error(`Cloudflare error ${response.status}`);
    err.code = 'CF_ERROR';
    err.details = details;
    err.status = response.status;
    throw err;
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  // Вариант 1: flux-1-schnell и подобные → JSON { result: { image: "base64..." } }
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const b64 = data?.result?.image || data?.image;
    if (!b64) {
      const err = new Error('Cloudflare returned no image in JSON');
      err.code = 'CF_NO_IMAGE';
      throw err;
    }
    return { base64: b64, mime: 'image/png' };
  }

  // Вариант 2: stable-diffusion и подобные → сырые PNG-байты (content-type: image/png)
  if (contentType.includes('image/')) {
    const buf = await response.arrayBuffer();
    const mime = contentType.split(';')[0].trim() || 'image/png';
    return { base64: bytesToBase64(new Uint8Array(buf)), mime };
  }

  // Неожиданный content-type — пробуем как JSON, иначе как байты.
  try {
    const data = await response.json();
    const b64 = data?.result?.image || data?.image;
    if (b64) return { base64: b64, mime: 'image/png' };
  } catch (e) { /* не JSON — пробуем байты ниже */ }
  const buf = await response.arrayBuffer().catch(() => null);
  if (!buf) {
    const err = new Error('Cloudflare returned unsupported content-type: ' + contentType);
    err.code = 'CF_BAD_CONTENT';
    throw err;
  }
  return { base64: bytesToBase64(new Uint8Array(buf)), mime: 'image/png' };
}

/* ---------- Supabase Storage ---------- */

function base64ToBytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function safeStorageSegment(value) {
  // Гости / некорректные id → общий путь guest, чтобы не ломать URL.
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
  // Date.now()/Math.random() запрещены в workflow-скриптах, но это обычный Vercel-хендлер —
  // здесь допустимо. Используем время + userId для уникальности пути.
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
    20000,
    'Supabase storage upload timed out'
  );

  if (!uploadResp.ok) {
    let details = null;
    try { details = await uploadResp.json(); } catch (e) { details = null; }
    const err = new Error('Supabase storage upload failed');
    err.code = 'STORAGE_ERROR';
    err.details = details;
    err.status = uploadResp.status;
    throw err;
  }

  // Публичный URL работает только если bucket сделан public в Supabase.
  return `${baseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

/* ---------- Handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { prompt, userId, model } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: { message: 'Пустой запрос на генерацию изображения' } });
    }
    const cleanPrompt = normalizeText(prompt).slice(0, 1200);

    // 1. Блок-лист модерации (дёшево).
    if (isForbiddenPrompt(cleanPrompt)) {
      return res.status(400).json({ error: { message: MODERATION_REJECT_MESSAGE, scope: 'moderation' } });
    }
    // 2. ИИ-фильтр (дороже, только если блок-лист пропустил).
    const allowed = await isPromptAllowedByAI(cleanPrompt);
    if (!allowed) {
      return res.status(400).json({ error: { message: MODERATION_REJECT_MESSAGE, scope: 'moderation' } });
    }

    // 3. Лимиты (нужен профиль для роли/плана; гости — in-memory burst).
    let profile = null;
    if (userId) {
      try { profile = await fetchProfile(userId); } catch (e) {
        console.warn('[generate-image] profile fetch failed:', compactErrorValue(e?.message, 200));
      }
    }
    const requestedModel = model === 'pro' ? 'pro' : 'free';
    const allowance = await checkImageAllowance(userId, profile, requestedModel);
    if (!allowance.ok) {
      return res.status(allowance.status || 429).json({
        error: { message: allowance.message, status: allowance.status || 429, scope: allowance.scope }
      });
    }

    // 4. Генерация через Cloudflare.
    let generated;
    try {
      generated = await generateViaCloudflare(cleanPrompt);
    } catch (e) {
      if (e.code === 'NO_CREDENTIALS') {
        return res.status(500).json({ error: { message: 'Cloudflare credentials not configured' } });
      }
      console.error('[generate-image] cloudflare failed:', compactErrorValue(e?.message, 300), e.details || '');
      return res.status(502).json({
        error: { message: 'Не удалось сгенерировать изображение на стороне Cloudflare.', details: e.details || e.message }
      });
    }

    // 5. Загрузка в Supabase Storage → публичный URL.
    let publicUrl;
    try {
      publicUrl = await uploadImageToStorage(generated.base64, generated.mime, userId);
    } catch (e) {
      console.error('[generate-image] storage upload failed:', compactErrorValue(e?.message, 300), e.details || '');
      return res.status(502).json({
        error: { message: 'Изображение сгенерировано, но не удалось сохранить его в хранилище.', details: e.details || e.message }
      });
    }

    // 6. Учитываем успешную генерацию (модерация/лимиты квоту не расходуют).
    await insertUsageEvent(userId);

    return res.status(200).json({ image: publicUrl });
  } catch (error) {
    console.error('[generate-image] handler error:', compactErrorValue(error?.message, 500));
    return res.status(500).json({ error: { message: error?.message || 'Внутренняя ошибка сервера' } });
  }
}
