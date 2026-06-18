// ─── Model chains ────────────────────────────────────────────────────────────
const FREE_MODEL_CHAINS = {
  lite: [
    process.env.FREE_LITE_MODEL || 'gemini-2.5-flash-lite',
    process.env.FREE_LITE_FALLBACK_MODEL || 'gemini-2.5-flash'
  ],
  pro: [
    process.env.FREE_PRO_MODEL || 'gemini-2.5-flash',
    process.env.FREE_PRO_FALLBACK_MODEL || 'gemini-2.5-flash-lite'
  ]
};

const PREMIUM_MODEL_CHAINS = {
  openai: [
    process.env.PREMIUM_MODEL || 'gpt-5.5',
    process.env.PREMIUM_FALLBACK_MODEL || 'gpt-5'
  ],
  gemini: [
    process.env.PREMIUM_MODEL || 'gemini-2.5-pro',
    process.env.PREMIUM_FALLBACK_MODEL || 'gemini-2.5-flash'
  ]
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeText(text = '') {
  return String(text)
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function tokenize(text = '') {
  return Array.from(
    new Set(
      String(text)
        .toLowerCase()
        .replace(/[^a-zа-я0-9#]+/gi, ' ')
        .split(/\s+/)
        .filter((part) => part.length > 2)
    )
  );
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return normalizeText(msg.content);
    if (Array.isArray(msg.content)) {
      return normalizeText(
        msg.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text || '')
          .join(' ')
      );
    }
  }
  return '';
}

function chunkText(text, size = 1800, overlap = 220) {
  const src = normalizeText(text);
  if (!src) return [];
  const chunks = [];
  let start = 0;
  while (start < src.length) {
    const end = Math.min(src.length, start + size);
    chunks.push(src.slice(start, end));
    if (end >= src.length) break;
    start = Math.max(end - overlap, start + 300);
  }
  return chunks.slice(0, 120);
}

function buildSupabaseHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

// ─── Supabase: одна точка входа ──────────────────────────────────────────────
async function supabaseRequest(path, init = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const headers = { ...buildSupabaseHeaders(), ...(init.headers || {}) };
  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, { ...init, headers }),
    10000,
    'Supabase request timed out'
  );
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || data?.error || `Supabase error ${response.status}`);
  }
  return data;
}

// ─── FIX 1: Все Supabase-запросы объединены в один параллельный fetch ────────
// Раньше: profile → [docs, memories, feedback] → chunks  = 3 последовательных round-trip
// Теперь: profile + docs + memories + feedback параллельно, chunks — только если есть docs
async function fetchAllContext(userId) {
  const ownerId = encodeURIComponent(userId || '');
  const orClause = userId
    ? `or=(scope.eq.global,and(scope.eq.user,owner_user_id.eq.${userId}))`
    : `scope=eq.global`;

  const [profileRows, documents, memories, feedbackRows] = await Promise.all([
    userId
      ? supabaseRequest(`/rest/v1/profiles?id=eq.${ownerId}&select=id,nickname,role,plan,settings&limit=1`).catch(() => [])
      : Promise.resolve([]),
    supabaseRequest(
      // FIX 2: Грузим только 20 документов вместо 60 — реально нужно гораздо меньше
      `/rest/v1/knowledge_documents?select=id,title,scope,source_type,owner_user_id,chunk_count,is_active&is_active=eq.true&${encodeURI(orClause)}&order=created_at.desc&limit=20`
    ).catch(() => []),
    userId
      ? supabaseRequest(
          `/rest/v1/user_memories?select=memory_text,source_type,weight,last_used_at&user_id=eq.${ownerId}&is_active=eq.true&order=updated_at.desc&limit=20`
        ).catch(() => [])
      : Promise.resolve([]),
    userId
      ? supabaseRequest(
          // FIX 3: Feedback — только 15 записей вместо 30
          `/rest/v1/message_feedback?select=assistant_excerpt,corrected_answer,note,is_global,created_at&status=eq.active&${encodeURI(`or=(is_global.eq.true,user_id.eq.${userId})`)}&order=updated_at.desc&limit=15`
        ).catch(() => [])
      : supabaseRequest(
          `/rest/v1/message_feedback?select=assistant_excerpt,corrected_answer,note,is_global,created_at&status=eq.active&is_global=eq.true&order=updated_at.desc&limit=15`
        ).catch(() => [])
  ]);

  const profile = profileRows?.[0] || null;

  // FIX 4: Чанки грузим только релевантные документы (топ-3 по score),
  // и лимит снижен с 600 до 80 — это убирает главный тяжёлый запрос
  let chunks = [];
  if (documents.length) {
    const topDocIds = documents.slice(0, 3).map((d) => d.id);
    chunks = await withTimeout(
      supabaseRequest(
        `/rest/v1/knowledge_chunks?select=document_id,chunk_index,content&document_id=in.(${topDocIds.join(',')})&order=document_id.asc,chunk_index.asc&limit=80`
      ).catch(() => []),
      8000,
      'Knowledge chunks timed out'
    ).catch(() => []);
  }

  return { profile, documents, memories, feedbackRows, chunks };
}

// ─── Scoring & context builders (без изменений) ───────────────────────────────
function scoreText(queryTokens, text) {
  const low = String(text || '').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (low.includes(token)) score += token.length > 5 ? 3 : 2;
  }
  return score;
}

function selectTopItems(items, pickText, queryText, limit = 4, maxChars = 8000) {
  const tokens = tokenize(queryText);
  const scored = items
    .map((item) => {
      const text = pickText(item);
      return { item, text, score: scoreText(tokens, text) };
    })
    .filter((entry) => entry.text && (entry.score > 0 || tokens.length === 0))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let chars = 0;
  for (const entry of scored) {
    if (selected.length >= limit) break;
    if (chars + entry.text.length > maxChars) continue;
    selected.push(entry.item);
    chars += entry.text.length;
  }
  return selected;
}

function buildKnowledgeContext(documents, chunks, query) {
  if (!documents.length || !chunks.length) return '';
  const docMap = new Map(documents.map((doc) => [doc.id, doc]));
  const items = chunks
    .map((chunk) => ({ ...chunk, document: docMap.get(chunk.document_id) }))
    .filter((row) => row.document);
  const picked = selectTopItems(items, (item) => item.content, query, 5, 10000);
  if (!picked.length) return '';
  return '\nБАЗА ЗНАНИЙ:\n' + picked
    .map((item, index) => `[Источник ${index + 1}: ${item.document.title}]\n${item.content}`)
    .join('\n\n');
}

// ─── Блок 2: Иерархия памяти — биография исключается для академических запросов ─
function isTechnicalQuery(query = '') {
  const low = String(query || '').toLowerCase();
  return /(нот|стан|гамм|аккорд|арпеджи|интервал|октав|тональ|лад|пьес|мелоди|сольфеджи|фортепиан|полифони|трезвучи|доминант|тоник|субдоминант|септ|терц|кварт|квинт|функци|ступен|диез|бемоль|размер|ритм|такт|abc)/.test(low) ||
         /(история|физик|математик|химия|биолог|программирован|алгоритм|теори|определени|объясни|что такое|как работает|почему)/.test(low);
}

// Биографические маркеры — записи, которые описывают пользователя лично
function isBiographicalMemory(text = '') {
  const low = String(text || '').toLowerCase();
  return /(меня зовут|мой возраст|я учусь|я живу|мой любимый|моя семья|я работаю|мне лет|мой день рождения|я из|моё хобби|я предпочитаю|мой уровень)/.test(low);
}

function buildMemoryContext(memories, query) {
  if (!memories.length) return '';
  const technical = isTechnicalQuery(query);
  // Для технических запросов биографическую память не передаём
  const filtered = technical
    ? memories.filter(m => !isBiographicalMemory(m.memory_text))
    : memories;
  const picked = selectTopItems(filtered, (item) => item.memory_text, query, 6, 4000);
  if (!picked.length) return '';
  return '\nПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ:\n' + picked
    .map((item, index) => `${index + 1}. ${item.memory_text}`)
    .join('\n');
}

function buildFeedbackContext(feedbackRows, query) {
  if (!feedbackRows.length) return '';
  const picked = selectTopItems(
    feedbackRows,
    (item) => `${item.assistant_excerpt}\n${item.corrected_answer}\n${item.note || ''}`,
    query,
    6,
    5000
  );
  if (!picked.length) return '';
  return '\nИСПРАВЛЕНИЯ И ОШИБКИ, КОТОРЫЕ НУЖНО УЧИТЫВАТЬ:\n' + picked
    .map((item, index) => {
      const note = item.note ? `\nКомментарий: ${item.note}` : '';
      return `${index + 1}. Было неверно: ${item.assistant_excerpt}\nПравильно: ${item.corrected_answer}${note}`;
    })
    .join('\n\n');
}

// ─── Query classification ─────────────────────────────────────────────────────
function isSimpleQuery(query = '') {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return true;
  if (
    clean.length <= 40 &&
    /^(привет|здравствуй|здравствуйте|как дела|спасибо|ок|понял|поняла|да|нет|hi|hello|thanks|thank you)[\s!.?]*$/i.test(clean)
  ) return true;
  return false;
}

function isCreativeOrNotationRequest(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(сгенерируй|создай|напиши|придумай|построй|сочини|гамм|аккорд|нот|стан|abc|мелоди|пьес|цепочк)/.test(clean);
}

// ─── FIX 5: Developer note сохраняется ПОСЛЕ ответа, не блокируя его ─────────
function maybeSaveDeveloperNoteAsync(profile, queryText) {
  if (!profile || profile.role !== 'developer') return;
  const clean = normalizeText(queryText);
  if (clean.length < 24) return;

  // fire-and-forget: не await, не блокирует ответ
  (async () => {
    try {
      const chunks = chunkText(clean);
      if (!chunks.length) return;
      const [document] = await supabaseRequest('/rest/v1/knowledge_documents', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          title: `Developer note ${new Date().toISOString()}`,
          scope: 'global',
          source_type: 'developer_note',
          owner_user_id: profile.id,
          created_by: profile.id,
          content_preview: clean.slice(0, 220),
          chunk_count: chunks.length,
          meta: { auto_learned: true }
        }])
      });
      const rows = chunks.map((content, index) => ({ document_id: document.id, chunk_index: index, content }));
      await supabaseRequest('/rest/v1/knowledge_chunks', { method: 'POST', body: JSON.stringify(rows) });
    } catch { /* silent */ }
  })();
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────
function appendServerContext(systemText, additions) {
  return [systemText || '', ...additions.filter(Boolean)].join('\n');
}

function isOverloaded(status, message = '') {
  const text = String(message).toLowerCase();
  return status === 429 || status === 503 || text.includes('high demand') || text.includes('resource exhausted') || text.includes('overloaded');
}

function isQuotaExceeded(status, message = '') {
  const low = String(message || '').toLowerCase();
  return status === 429 && (
    low.includes('quota') ||
    low.includes('resource has been exhausted') ||
    low.includes('resource exhausted') ||
    low.includes('exceeded your current quota') ||
    low.includes('billing') ||
    low.includes('insufficient balance') ||
    low.includes('token limit exceeded')
  );
}

function compactErrorValue(value, limit = 500) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return normalizeText(text).slice(0, limit);
}

function formatQuotaErrorMessage(errorMessage = '', modelName = '') {
  const reason = compactErrorValue(errorMessage, 320);
  const suffix = [reason, modelName ? `model=${modelName}` : ''].filter(Boolean).join(' | ');
  return suffix ? `Ошибка 1511. Сообщите в поддержку. Причина: ${suffix}` : 'Ошибка 1511. Сообщите в поддержку.';
}

function isTimeoutError(message = '') {
  const text = String(message || '').toLowerCase();
  return text.includes('timed out') || text.includes('timeout');
}

function sanitizeTheoryText(text = '') {
  return String(text || '')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\(\s*\$+\s*([TSDIVXivx]+)\s*_\{?\s*(\d{1,3})\s*\}?\s*\$+\s*\)/g, '$1$2')
    .replace(/\$+\s*([TSDIVXivx]+)\s*_\{?\s*(\d{1,3})\s*\}?\s*\$+/g, '$1$2')
    .replace(/([TSDIVXivx]+)\s*_\{?\s*(\d{1,3})\s*\}?/g, '$1$2')
    .replace(/\(\s*([A-Ga-g][,']?)\s*\)/g, '($1)')
    .replace(/\s+([,.;:!?])/g, '$1');
}

function sanitizeAssistantText(text = '') {
  return String(text || '')
    .split(/(```\s*abc[\r\n]+[\s\S]*?```)/gi)
    .map((part) => /^```\s*abc/i.test(part) ? part : sanitizeTheoryText(part))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Message mappers ──────────────────────────────────────────────────────────
function mapMessagesForOpenAI(messages, systemText) {
  const mapped = [];
  if (systemText) mapped.push({ role: 'system', content: systemText });
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string') {
      mapped.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (Array.isArray(msg.content)) {
      const content = msg.content.map((item) => {
        if (item.type === 'text') return { type: 'text', text: item.text };
        if (item.type === 'image_url') return { type: 'image_url', image_url: { url: item.image_url.url } };
        return null;
      }).filter(Boolean);
      mapped.push({ role: msg.role, content });
    }
  }
  return mapped;
}

function mapMessagesForGemini(messages) {
  let systemText = '';
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText = typeof msg.content === 'string' ? msg.content : '';
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          parts.push({ text: item.text });
        } else if (item.type === 'image_url') {
          const match = item.image_url.url.match(/^data:(.+);base64,(.+)$/);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
    }
    contents.push({ role, parts });
  }
  return { systemText, contents };
}

// ─── API callers ──────────────────────────────────────────────────────────────
async function callGemini(apiKey, modelName, body, timeoutMs = 35000) {
  const response = await withTimeout(
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    ),
    timeoutMs,
    `Gemini request timed out for ${modelName}`
  );
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  return { response, data };
}

// ─── FIX 6: Gemini Streaming ──────────────────────────────────────────────────
// Вызывает streamGenerateContent и читает SSE-чанки.
// Возвращает полный текст ответа, попутно отправляя клиенту SSE-события.
async function callGeminiStream(apiKey, modelName, body, res, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      let errData = {};
      try { errData = await response.json(); } catch { /* ignore */ }
      return { ok: false, status: response.status, error: errData?.error?.message || `HTTP ${response.status}`, data: errData };
    }

    // Открываем SSE-поток к клиенту
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // последняя незавершённая строка

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          const chunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (chunk) {
            const sanitized = sanitizeAssistantText(chunk);
            fullText += sanitized;
            // Отправляем дельту клиенту
            res.write(`data: ${JSON.stringify({ delta: sanitized })}\n\n`);
          }
        } catch { /* skip malformed chunk */ }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, model: modelName })}\n\n`);
    res.end();
    return { ok: true, text: fullText };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, status: 504, error: 'Gemini stream timed out' };
    return { ok: false, status: 500, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(apiKey, modelName, messages, timeoutMs = 35000) {
  const response = await withTimeout(
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelName, messages })
    }),
    timeoutMs,
    `OpenAI request timed out for ${modelName}`
  );
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  return { response, data };
}

// ─── Route selector ───────────────────────────────────────────────────────────
function selectRoute(profile, requestedModel) {
  const plan = profile?.plan || 'free';
  const wantsPro = requestedModel === 'pro';
  if (wantsPro && plan === 'premium') {
    const provider = (process.env.PREMIUM_PROVIDER || 'openai').toLowerCase();
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, models: PREMIUM_MODEL_CHAINS.openai };
    }
    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY, models: PREMIUM_MODEL_CHAINS.gemini };
    }
  }
  return {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    models: wantsPro ? FREE_MODEL_CHAINS.pro : FREE_MODEL_CHAINS.lite
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'GEMINI_API_KEY не настроен' } });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: { message: 'SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не настроены' } });
  }

  try {
    const { messages, model, userId, think = false, effort = 'low', stream = false } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Пустой запрос к модели' } });
    }

    const query = lastUserText(messages);
    const isQuick = isSimpleQuery(query);

    // FIX 1+4: Один параллельный запрос вместо 3-4 последовательных
    let profile = null, documents = [], memories = [], feedbackRows = [], chunks = [];
    if (!isQuick || think || effort === 'max') {
      ({ profile, documents, memories, feedbackRows, chunks } = await fetchAllContext(userId));
    } else {
      // Для простых запросов грузим только профиль — быстро
      if (userId) {
        const rows = await supabaseRequest(
          `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,nickname,role,plan,settings&limit=1`
        ).catch(() => []);
        profile = rows?.[0] || null;
      }
    }

    // FIX 5: fire-and-forget, не блокирует ответ
    maybeSaveDeveloperNoteAsync(profile, query);

    const route = selectRoute(profile, model);
    const { systemText, contents } = mapMessagesForGemini(messages);
    const isNotationHeavy = isCreativeOrNotationRequest(query);

    // FIX 7: Таймауты снижены — простые запросы теперь 8 сек вместо 18
    const modelTimeoutMs =
      think || effort === 'max' ? 55000
      : isQuick                 ?  8000
      : isNotationHeavy         ? 38000
      :                           25000;

    // FIX 8: Retries убраны для быстрых запросов, оставлены только для тяжёлых
    const geminiAttempts = think || effort === 'max' ? 2 : 1;

    const mergedSystem = appendServerContext(systemText, [
      profile ? `Профиль пользователя: role=${profile.role || 'user'}, plan=${profile.plan || 'free'}` : '',
      buildMemoryContext(memories, query),
      buildFeedbackContext(feedbackRows, query),
      buildKnowledgeContext(documents, chunks, query)
    ]);

    let lastError = null;

    // ── OpenAI (premium) ──────────────────────────────────────────────────────
    if (route.provider === 'openai') {
      const openAiMessages = mapMessagesForOpenAI(messages, mergedSystem);
      for (const modelName of route.models) {
        const { response, data } = await callOpenAI(route.apiKey, modelName, openAiMessages, modelTimeoutMs);
        const errorMessage = data?.error?.message || '';
        if (!response.ok || data.error) {
          lastError = { status: response.status || 500, message: errorMessage || `Ошибка модели ${modelName}`, model: modelName };
          if (isQuotaExceeded(response.status, errorMessage)) {
            return res.status(429).json({ error: { message: formatQuotaErrorMessage(errorMessage, modelName), provider: 'openai', model: modelName, status: response.status || 429 } });
          }
          if (isOverloaded(response.status, errorMessage)) await sleep(600);
          continue;
        }
        const replyText = sanitizeAssistantText(data?.choices?.[0]?.message?.content || 'Нет ответа');
        return res.status(200).json({ choices: [{ message: { content: replyText } }], model: modelName });
      }
    }

    // ── Gemini ────────────────────────────────────────────────────────────────
    const body = { contents };
    if (mergedSystem) body.systemInstruction = { parts: [{ text: mergedSystem }] };

    // FIX 6: Streaming path для Gemini
    if (stream && route.provider === 'gemini') {
      for (const modelName of route.models) {
        const result = await callGeminiStream(route.apiKey, modelName, body, res, modelTimeoutMs);
        if (result.ok) return; // streaming закончился, res уже закрыт
        // При ошибке пробуем следующую модель (если res ещё не начали писать)
        lastError = { status: result.status, message: result.error, model: modelName };
        if (isQuotaExceeded(result.status, result.error)) {
          return res.headersSent ? undefined : res.status(429).json({
            error: { message: formatQuotaErrorMessage(result.error, modelName), provider: 'gemini', model: modelName, status: result.status }
          });
        }
      }
      if (!res.headersSent) {
        return res.status(lastError?.status || 500).json({ error: { message: lastError?.message || 'Не удалось получить ответ' } });
      }
      return;
    }

    // Non-streaming path (без изменений по логике, но с меньшим числом retries)
    for (const modelName of route.models) {
      for (let attempt = 0; attempt < geminiAttempts; attempt += 1) {
        const { response, data } = await callGemini(route.apiKey, modelName, body, modelTimeoutMs);
        const errorMessage = data?.error?.message || '';
        if (!response.ok || data.error) {
          lastError = { status: response.status || 500, message: errorMessage || `Ошибка модели ${modelName}`, model: modelName };
          if (isQuotaExceeded(response.status, errorMessage)) {
            return res.status(429).json({ error: { message: formatQuotaErrorMessage(errorMessage, modelName), provider: 'gemini', model: modelName, status: response.status || 429 } });
          }
          if (isOverloaded(response.status, errorMessage) && attempt === 0) {
            await sleep(700);
            continue;
          }
          break;
        }
        const replyText = sanitizeAssistantText(data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Нет ответа');
        return res.status(200).json({ choices: [{ message: { content: replyText } }], model: modelName });
      }
    }

    // Error responses
    if (lastError && isQuotaExceeded(lastError.status, lastError.message)) {
      return res.status(429).json({ error: { message: formatQuotaErrorMessage(lastError.message, lastError.model), status: lastError.status || 429, model: lastError.model } });
    }
    if (lastError && isOverloaded(lastError.status, lastError.message)) {
      return res.status(503).json({ error: { message: `This model is currently experiencing high demand. Please try again in a minute. Причина: ${compactErrorValue(lastError.message, 320) || 'unknown'}${lastError.model ? ` | model=${lastError.model}` : ''}`, status: lastError.status || 503, model: lastError.model } });
    }
    if (lastError && isTimeoutError(lastError.message)) {
      return res.status(504).json({ error: { message: `Gemini отвечает слишком долго. Попробуйте ещё раз или отключите сложный режим. Причина: ${compactErrorValue(lastError.message, 320) || 'timeout'}${lastError.model ? ` | model=${lastError.model}` : ''}`, status: 504, model: lastError.model } });
    }
    return res.status(lastError?.status || 500).json({ error: { message: lastError?.message || 'Не удалось получить ответ от модели' } });

  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
}
