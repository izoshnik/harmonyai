export const config = {
  maxDuration: 300
};

// Adanatos (free) всегда отвечает на gpt-5.4, Dynatos (pro) — на gpt-5.5.
// Режимы low/max НЕ меняют модель, они меняют только таймаут/глубину (см. selectRoute/handler).
const MODEL_CHAINS = {
  adanatos: [
    process.env.ADANATOS_MODEL || 'gpt-5.4',
    process.env.ADANATOS_FALLBACK || 'gpt-5.4'
  ],
  dynatos: [
    process.env.DYNATOS_MODEL || 'gpt-5.5',
    process.env.DYNATOS_FALLBACK || 'gpt-5.4'
  ]
};

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderValue(value = '') {
  const low = String(value || '').trim().toLowerCase();
  return !low || low === 'undefined' || low === 'null' || low === 'your_key_here' || low === 'openai_base_url';
}

function hasUsableGemini() {
  const key = readEnv('GEMINI_API_KEY');
  return Boolean(key && !isPlaceholderValue(key));
}

function hasUsableOpenAI() {
  const key = readEnv('OPENAI_API_KEY');
  const baseUrl = readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1';
  if (!key || isPlaceholderValue(key)) return false;
  if (isPlaceholderValue(baseUrl)) return false;
  try {
    const parsed = new URL(baseUrl);
    return Boolean(parsed.protocol && parsed.host);
  } catch (error) {
    return false;
  }
}

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

function chunkText(text, size = 6000, overlap = 600) {
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
  return chunks;
}

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
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,nickname,role,plan,settings&limit=1`
  );
  return rows?.[0] || null;
}

async function fetchAccessibleDocuments(userId) {
  const orClause = userId
    ? `or=(scope.eq.global,and(scope.eq.user,owner_user_id.eq.${userId}))`
    : `scope=eq.global`;
  return await supabaseRequest(
    `/rest/v1/knowledge_documents?select=id,title,scope,source_type,owner_user_id,created_at,chunk_count,is_active&is_active=eq.true&${encodeURI(orClause)}&order=created_at.desc&limit=500`
  );
}

async function fetchChunksForDocuments(docIds) {
  if (!docIds.length) return [];
  const encodedIds = docIds.join(',');
  return await supabaseRequest(
    `/rest/v1/knowledge_chunks?select=document_id,chunk_index,content&document_id=in.(${encodedIds})&order=document_id.asc,chunk_index.asc&limit=20000`
  );
}

async function fetchUserMemories(userId) {
  if (!userId) return [];
  return await supabaseRequest(
    `/rest/v1/user_memories?select=memory_text,source_type,weight,last_used_at&user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true&order=updated_at.desc&limit=30`
  );
}

async function fetchFeedback(userId) {
  const orClause = userId
    ? `or=(is_global.eq.true,user_id.eq.${userId})`
    : `is_global=eq.true`;
  return await supabaseRequest(
    `/rest/v1/message_feedback?select=assistant_excerpt,corrected_answer,note,is_global,created_at&status=eq.active&${encodeURI(orClause)}&order=updated_at.desc&limit=30`
  );
}

function scoreText(queryTokens, text) {
  const low = String(text || '').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (low.includes(token)) score += token.length > 5 ? 3 : 2;
  }
  return score;
}

function selectTopItems(items, pickText, queryText, limit = 50, maxChars = 300000) {
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
  const picked = selectTopItems(items, (item) => item.content, query, 80, 350000);
  if (!picked.length) return '';
  return '\nБАЗА ЗНАНИЙ:\n' + picked
    .map((item, index) => `[Источник ${index + 1}: ${item.document.title}]\n${item.content}`)
    .join('\n\n');
}

function buildMemoryContext(memories, query) {
  if (!memories.length) return '';
  const picked = selectTopItems(memories, (item) => item.memory_text, query, 20, 30000);
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
    20,
    50000
  );
  if (!picked.length) return '';
  return '\nИСПРАВЛЕНИЯ И ОШИБКИ, КОТОРЫЕ НУЖНО УЧИТЫВАТЬ:\n' + picked
    .map((item, index) => {
      const note = item.note ? `\nКомментарий: ${item.note}` : '';
      return `${index + 1}. Было неверно: ${item.assistant_excerpt}\nПравильно: ${item.corrected_answer}${note}`;
    })
    .join('\n\n');
}

function isSimpleQuery(query = '') {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return true;
  if (clean.length <= 40 && /^(привет|здравствуй|здравствуйте|как дела|спасибо|ок|понял|поняла|да|нет|hi|hello|thanks|thank you)[\s!.?]*$/i.test(clean)) {
    return true;
  }
  return false;
}

// Определяет, нужен ли запросу персональный контекст пользователя:
// память, профиль/настройки, загруженные документы, история этого чата.
// Если контекст не нужен — отвечаем быстрым путём без похода в Supabase за памятью/документами.
function needsPersonalContext(query = '', messages = []) {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return false;

  // Явные сигналы: пользователь ссылается на себя, свою историю, свои файлы/настройки
  const personalSignals = /(помнишь|как обычно|как всегда|мо[йяюе]\s|мне нравится|мне не нравится|я говорил|я писал|я просил|я предпочита|настрой(ка|ки)|профил|документ|файл|учебник|загрузил|прикреп|ранее мы|в прошлый раз|продолжи|как в прошлый раз|исправь(те)? (как|так)|мою память|обнови память|запомни)/;
  if (personalSignals.test(clean)) return true;

  // Если в этом чате уже есть прикреплённые документы/изображения среди сообщений — контекст нужен
  const hasAttachmentInHistory = messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some((item) => item.type === 'image_url' || item.type === 'file' || item.type === 'document');
  });
  if (hasAttachmentInHistory) return true;

  // Длинные содержательные вопросы тоже выигрывают от знаний/памяти,
  // короткие нейтральные вопросы — нет.
  if (clean.length > 220) return true;

  return false;
}

// Широкая проверка музыкальной тематики — используется только для увеличения таймаута,
// не запускает никаких дополнительных вызовов модели.
function isCreativeOrNotationRequest(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(сгенерируй|создай|напиши|придумай|построй|сочини|гамм|аккорд|нот|стан|abc|мелоди|пьес|цепочк)/.test(clean);
}

// Узкая проверка: пользователь реально хочет ВИЗУАЛЬНЫЙ нотный стан (картинку нот),
// а не просто текстовое объяснение теории с упоминанием аккордов/нот.
// Только в этом случае оправдан дорогой повторный вызов модели для abc-нотации.
function wantsRenderedStaff(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(нотн(ый|ую|ом|ыми)?\s*стан|нотами|на нотах|запиши\s+нот|изобрази\s+нот|нарисуй\s+нот|покажи\s+нот|abc[-\s]?нотаци|сыграй|сочини\s+(мелоди|пьес|гамм)|напиши\s+(мелоди|пьес|гамм)|придумай\s+(мелоди|пьес|гамм)|построй\s+гамм|партитур)/.test(clean);
}

async function maybeSaveDeveloperNote(profile, queryText, trainingMode = false) {
  if (!profile || (profile.role !== 'developer' && profile.role !== 'admin')) return;
  const clean = normalizeText(queryText);
  // В режиме «Обучение» сохраняем абсолютно всё, что прислал developer/admin.
  // В обычном чате — только содержательные сообщения (пассивное обучение), чтобы не засорять базу знаний.
  const minLength = trainingMode ? 1 : 24;
  if (clean.length < minLength) return;
  const chunks = chunkText(clean);
  if (!chunks.length) return;

  const [document] = await supabaseRequest('/rest/v1/knowledge_documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      title: trainingMode ? `Обучение ${new Date().toISOString()}` : `Developer note ${new Date().toISOString()}`,
      scope: 'global',
      source_type: trainingMode ? 'training_note' : 'developer_note',
      owner_user_id: profile.id,
      created_by: profile.id,
      content_preview: clean.slice(0, 220),
      chunk_count: chunks.length,
      meta: { auto_learned: true, training_mode: Boolean(trainingMode) }
    }])
  });

  const rows = chunks.map((content, index) => ({
    document_id: document.id,
    chunk_index: index,
    content
  }));

  await supabaseRequest('/rest/v1/knowledge_chunks', {
    method: 'POST',
    body: JSON.stringify(rows)
  });
}

function buildThinkInstruction() {
  return [
    '',
    'РЕЖИМ ДУМАТЬ ВКЛЮЧЁН.',
    `Сначала напиши настоящий, развёрнутый ход рассуждений простым текстом (анализ вопроса, варианты, проверка) — это реальные размышления, а не заглушка.`,
    `Когда рассуждения закончены, выведи на отдельной строке ровно маркер ${REASONING_DELIMITER}`,
    `Сразу после маркера дай финальный, чистый ответ для пользователя без повторения рассуждений.`,
    'Не используй маркер где-либо ещё, кроме этого единственного разделителя.'
  ].join('\n');
}

function appendServerContext(systemText, additions) {
  return [systemText || '', ...additions.filter(Boolean)].join('\n');
}

function isOverloaded(status, message = '') {
  const text = String(message).toLowerCase();
  return status === 429 || status === 503 || text.includes('high demand') || text.includes('resource exhausted') || text.includes('overloaded');
}

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
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
    }

    contents.push({ role, parts });
  }

  return { systemText, contents };
}

async function callGemini(apiKey, modelName, body, timeoutMs = 35000) {
  const response = await withTimeout(
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    ),
    timeoutMs,
    `Gemini request timed out for ${modelName}`
  );
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  return { response, data };
}

async function callOpenAI(apiKey, modelName, messages, timeoutMs = 35000) {
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  const response = await withTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages
      })
    }),
    timeoutMs,
    `OpenAI request timed out for ${modelName}`
  );
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  return { response, data };
}

async function callOpenAIStream(apiKey, modelName, messages, timeoutMs = 65000) {
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  return await withTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true
      })
    }),
    timeoutMs,
    `OpenAI stream timed out for ${modelName}`
  );
}

function isQuotaExceeded(status, message = '') {
  const low = String(message || '').toLowerCase();
  return (
    status === 429 && (
      low.includes('quota') ||
      low.includes('resource has been exhausted') ||
      low.includes('resource exhausted') ||
      low.includes('exceeded your current quota') ||
      low.includes('billing') ||
      low.includes('insufficient balance') ||
      low.includes('token limit exceeded')
    )
  );
}

function isModelUnavailable(message = '') {
  const low = String(message || '').toLowerCase();
  return low.includes('model is not available') || low.includes('model_not_found') || low.includes('unsupported model');
}

function compactErrorValue(value, limit = 500) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return normalizeText(text).slice(0, limit);
}

function formatQuotaErrorMessage(errorMessage = '', modelName = '') {
  console.error(`[harmonyai] quota exceeded | model=${modelName} | reason=${compactErrorValue(errorMessage, 500)}`);
  return 'Сервис временно перегружен или превышен лимит запросов. Попробуйте немного позже либо обратитесь в поддержку (код 1511).';
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

function hasAbcBlock(text = '') {
  return /```\s*abc[\r\n]+[\s\S]*?```/i.test(String(text || ''));
}

function stripReasoningPrefix(text = '') {
  const idx = String(text || '').indexOf(REASONING_DELIMITER);
  if (idx === -1) return text;
  return String(text).slice(idx + REASONING_DELIMITER.length).replace(/^\s+/, '');
}

async function repairNotationReplyIfNeeded(apiKey, modelName, query, replyText) {
  const cleanReply = sanitizeAssistantText(replyText);
  if (!wantsRenderedStaff(query) || hasAbcBlock(cleanReply)) {
    return cleanReply;
  }

  const repairMessages = [
    {
      role: 'system',
      content: [
        'Ты исправляешь музыкальный ответ модели.',
        'Верни полноценный визуализируемый нотный стан строго через один или несколько блоков ```abc```.',
        'Запрещено использовать ASCII-стан, псевдографику, таблицы линий, просто список нот или текстовое описание вместо abc.',
        'Сначала дай корректный abc-блок, затем краткое объяснение.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Запрос пользователя:\n${query}\n\nПредыдущий ответ был недостаточным:\n${cleanReply}\n\nПерепиши ответ корректно.`
    }
  ];

  try {
    const { response, data } = await callOpenAI(apiKey, modelName, repairMessages, 20000);
    if (!response.ok || data?.error) return cleanReply;
    return sanitizeAssistantText(data?.choices?.[0]?.message?.content || cleanReply);
  } catch (error) {
    return cleanReply;
  }
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Маркер, после которого начинается финальный ответ для пользователя.
// Модель просят сначала писать реальные рассуждения, затем этот маркер, затем сам ответ.
const REASONING_DELIMITER = '===ОТВЕТ===';

async function streamOpenAIToClient(res, apiKey, modelName, messages, timeoutMs, query, largeContext = false, captureReasoning = false) {
  const upstream = await callOpenAIStream(apiKey, modelName, messages, timeoutMs);
  if (!upstream.ok) {
    let data = {};
    try {
      data = await upstream.json();
    } catch (error) {
      data = {};
    }
    return {
      ok: false,
      status: upstream.status || 500,
      message: data?.error?.message || `Ошибка модели ${modelName}`,
      model: modelName
    };
  }

  if (!upstream.body) {
    return {
      ok: false,
      status: 500,
      message: `Потоковый ответ недоступен для модели ${modelName}`,
      model: modelName
    };
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let gotAnyDelta = false;

  // Состояние разбора рассуждений в реальном времени (только если captureReasoning=true)
  let rawAll = '';            // весь текст модели как есть (с маркером)
  let switchedToAnswer = !captureReasoning; // если не просили рассуждения — сразу режим ответа
  let pendingHold = '';       // придерживаем хвост на случай, если маркер разорван между чанками

  const chunkTimeoutMs = largeContext
    ? Math.max(45000, Math.min(timeoutMs, 60000))  // до 60с между чанками для больших документов
    : Math.max(45000, Math.min(timeoutMs, 60000));  // до 60с — модель может "молчать" во время длинных рассуждений (режим "Думать")
  let stalled = false;
  while (true) {
    let done, value;
    try {
      ({ done, value } = await withTimeout(
        reader.read(),
        chunkTimeoutMs,
        `OpenAI stream chunk timed out for ${modelName}`
      ));
    } catch (chunkErr) {
      // Модель замолчала между токенами дольше chunkTimeoutMs — грациозно завершаем с тем, что получили,
      // но помечаем ответ как незавершённый, чтобы клиент предложил продолжить генерацию.
      stalled = true;
      break;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const eventChunk of events) {
      const lines = eventChunk.split('\n').filter((line) => line.startsWith('data:'));
      for (const line of lines) {
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
        if (!parsed) continue;
        let delta = parsed?.choices?.[0]?.delta?.content || '';
        if (Array.isArray(delta)) {
          delta = delta.map((item) => item?.text || '').join('');
        }
        if (typeof delta === 'string' && delta) {
          gotAnyDelta = true;
          fullText += delta;

          if (!captureReasoning || switchedToAnswer) {
            writeSseEvent(res, { type: 'delta', text: delta });
            continue;
          }

          // Накопили текст с потенциальным маркером — ищем его, придерживая хвост
          rawAll += pendingHold + delta;
          pendingHold = '';
          const idx = rawAll.indexOf(REASONING_DELIMITER);
          if (idx === -1) {
            // Держим в буфере только хвост, который может быть началом маркера
            const holdLen = Math.min(rawAll.length, REASONING_DELIMITER.length - 1);
            const safeLen = rawAll.length - holdLen;
            if (safeLen > 0) {
              writeSseEvent(res, { type: 'reasoning', text: rawAll.slice(0, safeLen) });
            }
            pendingHold = rawAll.slice(safeLen);
            rawAll = rawAll.slice(safeLen);
          } else {
            const reasoningPart = rawAll.slice(0, idx);
            if (reasoningPart) writeSseEvent(res, { type: 'reasoning', text: reasoningPart });
            const answerPart = rawAll.slice(idx + REASONING_DELIMITER.length).replace(/^\s+/, '');
            switchedToAnswer = true;
            rawAll = '';
            if (answerPart) writeSseEvent(res, { type: 'delta', text: answerPart });
          }
        }
      }
    }
  }

  if (!gotAnyDelta && !fullText.trim()) {
    writeSseEvent(res, { type: 'error', message: 'Потоковый ответ прервался слишком рано. Попробуйте ещё раз.' });
    res.end();
    return {
      ok: false,
      status: 504,
      message: `Потоковый ответ прервался слишком рано для модели ${modelName}`,
      model: modelName
    };
  }

  // Если маркер так и не пришёл (модель не подчинилась формату) — отдаём всё как ответ целиком
  let finalRawText = fullText;
  if (captureReasoning && !switchedToAnswer) {
    const idx = fullText.indexOf(REASONING_DELIMITER);
    finalRawText = idx === -1 ? fullText : fullText.slice(idx + REASONING_DELIMITER.length).replace(/^\s+/, '');
  }

  // Ответ оборвался из-за молчания модели (а не потому что она закончила сама) — не "чиним" нотацию
  // повторным запросом (он может полностью переписать честный частичный текст), просто сообщаем клиенту.
  const finalText = stalled
    ? sanitizeAssistantText(finalRawText)
    : await repairNotationReplyIfNeeded(apiKey, modelName, query, finalRawText);
  writeSseEvent(res, { type: 'done', text: finalText, truncated: stalled });
  res.end();

  return { ok: true, text: finalText, model: modelName, truncated: stalled };
}

function selectRoute(profile, requestedModel) {
  const wantsPro = requestedModel === 'pro';
  const modelChain = wantsPro ? MODEL_CHAINS.dynatos : MODEL_CHAINS.adanatos;
  
  return {
    provider: 'openai',
    apiKey: readEnv('OPENAI_API_KEY'),
    models: modelChain
  };
}

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

  if (!hasUsableOpenAI()) {
    return res.status(500).json({
      error: {
        message: 'Ключ или адрес API ИИ-провайдера настроены неверно. Обратитесь к администратору.'
      }
    });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: { message: 'SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не настроены' } });
  }

  try {
    const { messages, model, userId, think = false, effort = 'low', stream = false, trainingMode = false } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Пустой запрос к модели' } });
    }

    const profile = await fetchProfile(userId);
    const query = lastUserText(messages);
    const isQuick = isSimpleQuery(query);
    const wantsContext = needsPersonalContext(query, messages);

    let documents = [];
    let memories = [];
    let feedbackRows = [];
    let chunks = [];

    if (wantsContext || think || effort === 'max' || trainingMode) {
      const ownerId = profile?.id || userId || '';
      // Fetch docs, memories, and feedback in parallel
      const [docsResult, memoriesResult, feedbackResult] = await Promise.all([
        fetchAccessibleDocuments(ownerId).catch(() => []),
        fetchUserMemories(ownerId).catch(() => []),
        fetchFeedback(ownerId).catch(() => [])
      ]);
      documents = docsResult || [];
      memories = memoriesResult || [];
      feedbackRows = feedbackResult || [];

      if (documents.length) {
        chunks = await withTimeout(
          fetchChunksForDocuments(documents.map((doc) => doc.id)).catch(() => []),
          8000,
          'Knowledge chunks request timed out'
        ).catch(() => []);
      }
    }

    await maybeSaveDeveloperNote(profile, query, Boolean(trainingMode));

    const route = selectRoute(profile, model);
    const systemText = messages.find(m => m.role === 'system')?.content || '';
    // Определяем размер контекста — если в чате есть большой документ, нужны увеличенные таймауты
    const totalContextChars = messages.reduce((sum, m) => {
      const c = m.content;
      if (typeof c === 'string') return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text?.length || 0), 0);
      return sum;
    }, 0);
    const isLargeContext = totalContextChars > 80000; // > ~80k символов = документ в истории
    const isNotationHeavy = isCreativeOrNotationRequest(query);
    const wantsStaff = wantsRenderedStaff(query);
    // Цель: простые/обычные запросы (думать выкл, эффорт low) должны укладываться в 5-10 сек
    // ощущаемого времени ответа — таймаут здесь это потолок ожидания, а не искусственная задержка,
    // но более низкий потолок заставляет быстрее фейлиться на зависшем запросе и не "висеть" зря.
    // Режим "Думать" и effort=max сознательно получают намного больше времени, т.к. там нужна
    // реальная глубина рассуждений, а не скорость.
    let modelTimeoutMs;
    if (think || effort === 'max') {
      modelTimeoutMs = wantsStaff ? 45000 : 60000;
    } else if (isQuick && !isLargeContext) {
      modelTimeoutMs = 8000;
    } else if (wantsStaff) {
      modelTimeoutMs = 20000;
    } else if (wantsContext) {
      modelTimeoutMs = 18000;
    } else if (isNotationHeavy) {
      modelTimeoutMs = 16000;
    } else {
      modelTimeoutMs = 12000;
    }
    // Для большого контекста (документ 300к+ символов) модели нужно больше времени
    if (isLargeContext) modelTimeoutMs = Math.max(modelTimeoutMs, 90000);
    const mergedSystem = appendServerContext(systemText, [
      profile ? `Профиль пользователя: role=${profile.role || 'user'}, plan=${profile.plan || 'free'}` : '',
      think ? buildThinkInstruction() : '',
      buildMemoryContext(memories, query),
      buildFeedbackContext(feedbackRows, query),
      buildKnowledgeContext(documents, chunks, query)
    ]);

    let lastError = null;

    if (route.provider === 'openai') {
      const openAiMessages = mapMessagesForOpenAI(messages, mergedSystem);
      for (const modelName of route.models) {
        if (stream) {
          const streamResult = await streamOpenAIToClient(res, route.apiKey, modelName, openAiMessages, modelTimeoutMs, query, isLargeContext, Boolean(think));
          if (streamResult.ok) return;
          lastError = {
            status: streamResult.status || 500,
            message: streamResult.message || `Ошибка модели ${modelName}`,
            model: streamResult.model || modelName
          };
          const errorMessage = lastError.message || '';
          if (isModelUnavailable(errorMessage)) {
            console.error(`[harmonyai] model unavailable | model=${modelName} | reason=${compactErrorValue(errorMessage, 500)}`);
            return res.status(400).json({
              error: {
                message: 'Выбранная модель временно недоступна. Попробуйте другую модель или повторите позже.',
                status: lastError.status || 400
              }
            });
          }
          if (isQuotaExceeded(lastError.status, errorMessage)) {
            return res.status(429).json({
              error: {
                message: formatQuotaErrorMessage(errorMessage, modelName),
                status: lastError.status || 429
              }
            });
          }
          if (isOverloaded(lastError.status, errorMessage)) {
            await sleep(800);
            continue;
          }
          continue;
        }
        const { response, data } = await callOpenAI(route.apiKey, modelName, openAiMessages, modelTimeoutMs);
        const errorMessage = data?.error?.message || '';
        if (!response.ok || data.error) {
          lastError = { status: response.status || 500, message: errorMessage || `Ошибка модели ${modelName}`, model: modelName };
          if (isModelUnavailable(errorMessage)) {
            console.error(`[harmonyai] model unavailable | model=${modelName} | reason=${compactErrorValue(errorMessage, 500)}`);
            return res.status(400).json({
              error: {
                message: 'Выбранная модель временно недоступна. Попробуйте другую модель или повторите позже.',
                status: response.status || 400
              }
            });
          }
          if (isQuotaExceeded(response.status, errorMessage)) {
            return res.status(429).json({
              error: {
                message: formatQuotaErrorMessage(errorMessage, modelName),
                status: response.status || 429
              }
            });
          }
          if (isOverloaded(response.status, errorMessage)) await sleep(800);
          continue;
        }
        const rawContent = data?.choices?.[0]?.message?.content || 'Нет ответа';
        const replyText = await repairNotationReplyIfNeeded(
          route.apiKey,
          modelName,
          query,
          think ? stripReasoningPrefix(rawContent) : rawContent
        );
        return res.status(200).json({
          choices: [{ message: { content: replyText } }]
        });
      }
    }

    if (route.provider === 'openai') {
      if (lastError && isQuotaExceeded(lastError.status, lastError.message)) {
        return res.status(429).json({
          error: {
            message: formatQuotaErrorMessage(lastError.message, lastError.model),
            status: lastError.status || 429
          }
        });
      }

      if (lastError && isOverloaded(lastError.status, lastError.message)) {
        console.error(`[harmonyai] overloaded | model=${lastError.model || ''} | reason=${compactErrorValue(lastError.message, 500)}`);
        return res.status(503).json({
          error: {
            message: 'Сейчас высокая нагрузка на сервис. Попробуйте повторить запрос через минуту.',
            status: lastError.status || 503
          }
        });
      }

      if (lastError && isTimeoutError(lastError.message)) {
        console.error(`[harmonyai] timeout | model=${lastError.model || ''} | reason=${compactErrorValue(lastError.message, 500)}`);
        return res.status(504).json({
          error: {
            message: 'Модель отвечает слишком долго. Попробуйте ещё раз или отключите сложный режим.',
            status: 504
          }
        });
      }

      console.error(`[harmonyai] request failed | model=${lastError?.model || ''} | reason=${compactErrorValue(lastError?.message, 500)}`);
      return res.status(lastError?.status || 500).json({
        error: {
          message: 'Не удалось получить ответ от модели. Попробуйте ещё раз.'
        }
      });
    }

    return res.status(500).json({
      error: {
        message: 'Не удалось выбрать провайдера модели'
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: error?.message || 'Внутренняя ошибка сервера'
      }
    });
  }
}
