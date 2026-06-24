export const config = {
  maxDuration: 300
};

const MODEL_CHAINS = {
  adanatos: [
    process.env.ADANATOS_MODEL || 'gpt-5.4-mini',
    process.env.ADANATOS_FALLBACK || 'gpt-5.4'
  ],
  dynatos: [
    process.env.DYNATOS_MODEL || 'gpt-5.4',
    process.env.DYNATOS_FALLBACK || 'gpt-5.4-mini'
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
        .replace(/[^a-zÐ°-Ñ0-9#]+/gi, ' ')
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
  return '\nÐÐÐÐ ÐÐÐÐÐÐ:\n' + picked
    .map((item, index) => `[ÐÑÑÐ¾ÑÐ½Ð¸Ðº ${index + 1}: ${item.document.title}]\n${item.content}`)
    .join('\n\n');
}

function buildMemoryContext(memories, query) {
  if (!memories.length) return '';
  const picked = selectTopItems(memories, (item) => item.memory_text, query, 20, 30000);
  if (!picked.length) return '';
  return '\nÐÐÐÐ¯Ð¢Ð¬ Ð ÐÐÐÐ¬ÐÐÐÐÐ¢ÐÐÐ:\n' + picked
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
  return '\nÐÐ¡ÐÐ ÐÐÐÐÐÐÐ¯ Ð ÐÐ¨ÐÐÐÐ, ÐÐÐ¢ÐÐ Ð«Ð ÐÐ£ÐÐÐ Ð£Ð§ÐÐ¢Ð«ÐÐÐ¢Ð¬:\n' + picked
    .map((item, index) => {
      const note = item.note ? `\nÐÐ¾Ð¼Ð¼ÐµÐ½ÑÐ°ÑÐ¸Ð¹: ${item.note}` : '';
      return `${index + 1}. ÐÑÐ»Ð¾ Ð½ÐµÐ²ÐµÑÐ½Ð¾: ${item.assistant_excerpt}\nÐÑÐ°Ð²Ð¸Ð»ÑÐ½Ð¾: ${item.corrected_answer}${note}`;
    })
    .join('\n\n');
}

function isSimpleQuery(query = '') {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return true;
  if (clean.length <= 40 && /^(Ð¿ÑÐ¸Ð²ÐµÑ|Ð·Ð´ÑÐ°Ð²ÑÑÐ²ÑÐ¹|Ð·Ð´ÑÐ°Ð²ÑÑÐ²ÑÐ¹ÑÐµ|ÐºÐ°Ðº Ð´ÐµÐ»Ð°|ÑÐ¿Ð°ÑÐ¸Ð±Ð¾|Ð¾Ðº|Ð¿Ð¾Ð½ÑÐ»|Ð¿Ð¾Ð½ÑÐ»Ð°|Ð´Ð°|Ð½ÐµÑ|hi|hello|thanks|thank you)[\s!.?]*$/i.test(clean)) {
    return true;
  }
  return false;
}

// ÐÐ¿ÑÐµÐ´ÐµÐ»ÑÐµÑ, Ð½ÑÐ¶ÐµÐ½ Ð»Ð¸ Ð·Ð°Ð¿ÑÐ¾ÑÑ Ð¿ÐµÑÑÐ¾Ð½Ð°Ð»ÑÐ½ÑÐ¹ ÐºÐ¾Ð½ÑÐµÐºÑÑ Ð¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÐµÐ»Ñ:
// Ð¿Ð°Ð¼ÑÑÑ, Ð¿ÑÐ¾ÑÐ¸Ð»Ñ/Ð½Ð°ÑÑÑÐ¾Ð¹ÐºÐ¸, Ð·Ð°Ð³ÑÑÐ¶ÐµÐ½Ð½ÑÐµ Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÑ, Ð¸ÑÑÐ¾ÑÐ¸Ñ ÑÑÐ¾Ð³Ð¾ ÑÐ°ÑÐ°.
// ÐÑÐ»Ð¸ ÐºÐ¾Ð½ÑÐµÐºÑÑ Ð½Ðµ Ð½ÑÐ¶ÐµÐ½ â Ð¾ÑÐ²ÐµÑÐ°ÐµÐ¼ Ð±ÑÑÑÑÑÐ¼ Ð¿ÑÑÑÐ¼ Ð±ÐµÐ· Ð¿Ð¾ÑÐ¾Ð´Ð° Ð² Supabase Ð·Ð° Ð¿Ð°Ð¼ÑÑÑÑ/Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÐ°Ð¼Ð¸.
function needsPersonalContext(query = '', messages = []) {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return false;

  // Ð¯Ð²Ð½ÑÐµ ÑÐ¸Ð³Ð½Ð°Ð»Ñ: Ð¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÐµÐ»Ñ ÑÑÑÐ»Ð°ÐµÑÑÑ Ð½Ð° ÑÐµÐ±Ñ, ÑÐ²Ð¾Ñ Ð¸ÑÑÐ¾ÑÐ¸Ñ, ÑÐ²Ð¾Ð¸ ÑÐ°Ð¹Ð»Ñ/Ð½Ð°ÑÑÑÐ¾Ð¹ÐºÐ¸
  const personalSignals = /(Ð¿Ð¾Ð¼Ð½Ð¸ÑÑ|ÐºÐ°Ðº Ð¾Ð±ÑÑÐ½Ð¾|ÐºÐ°Ðº Ð²ÑÐµÐ³Ð´Ð°|Ð¼Ð¾[Ð¹ÑÑÐµ]\s|Ð¼Ð½Ðµ Ð½ÑÐ°Ð²Ð¸ÑÑÑ|Ð¼Ð½Ðµ Ð½Ðµ Ð½ÑÐ°Ð²Ð¸ÑÑÑ|Ñ Ð³Ð¾Ð²Ð¾ÑÐ¸Ð»|Ñ Ð¿Ð¸ÑÐ°Ð»|Ñ Ð¿ÑÐ¾ÑÐ¸Ð»|Ñ Ð¿ÑÐµÐ´Ð¿Ð¾ÑÐ¸ÑÐ°|Ð½Ð°ÑÑÑÐ¾Ð¹(ÐºÐ°|ÐºÐ¸)|Ð¿ÑÐ¾ÑÐ¸Ð»|Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ|ÑÐ°Ð¹Ð»|ÑÑÐµÐ±Ð½Ð¸Ðº|Ð·Ð°Ð³ÑÑÐ·Ð¸Ð»|Ð¿ÑÐ¸ÐºÑÐµÐ¿|ÑÐ°Ð½ÐµÐµ Ð¼Ñ|Ð² Ð¿ÑÐ¾ÑÐ»ÑÐ¹ ÑÐ°Ð·|Ð¿ÑÐ¾Ð´Ð¾Ð»Ð¶Ð¸|ÐºÐ°Ðº Ð² Ð¿ÑÐ¾ÑÐ»ÑÐ¹ ÑÐ°Ð·|Ð¸ÑÐ¿ÑÐ°Ð²Ñ(ÑÐµ)? (ÐºÐ°Ðº|ÑÐ°Ðº)|Ð¼Ð¾Ñ Ð¿Ð°Ð¼ÑÑÑ|Ð¾Ð±Ð½Ð¾Ð²Ð¸ Ð¿Ð°Ð¼ÑÑÑ|Ð·Ð°Ð¿Ð¾Ð¼Ð½Ð¸)/;
  if (personalSignals.test(clean)) return true;

  // ÐÑÐ»Ð¸ Ð² ÑÑÐ¾Ð¼ ÑÐ°ÑÐµ ÑÐ¶Ðµ ÐµÑÑÑ Ð¿ÑÐ¸ÐºÑÐµÐ¿Ð»ÑÐ½Ð½ÑÐµ Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÑ/Ð¸Ð·Ð¾Ð±ÑÐ°Ð¶ÐµÐ½Ð¸Ñ ÑÑÐµÐ´Ð¸ ÑÐ¾Ð¾Ð±ÑÐµÐ½Ð¸Ð¹ â ÐºÐ¾Ð½ÑÐµÐºÑÑ Ð½ÑÐ¶ÐµÐ½
  const hasAttachmentInHistory = messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some((item) => item.type === 'image_url' || item.type === 'file' || item.type === 'document');
  });
  if (hasAttachmentInHistory) return true;

  // ÐÐ»Ð¸Ð½Ð½ÑÐµ ÑÐ¾Ð´ÐµÑÐ¶Ð°ÑÐµÐ»ÑÐ½ÑÐµ Ð²Ð¾Ð¿ÑÐ¾ÑÑ ÑÐ¾Ð¶Ðµ Ð²ÑÐ¸Ð³ÑÑÐ²Ð°ÑÑ Ð¾Ñ Ð·Ð½Ð°Ð½Ð¸Ð¹/Ð¿Ð°Ð¼ÑÑÐ¸,
  // ÐºÐ¾ÑÐ¾ÑÐºÐ¸Ðµ Ð½ÐµÐ¹ÑÑÐ°Ð»ÑÐ½ÑÐµ Ð²Ð¾Ð¿ÑÐ¾ÑÑ â Ð½ÐµÑ.
  if (clean.length > 220) return true;

  return false;
}

// Ð¨Ð¸ÑÐ¾ÐºÐ°Ñ Ð¿ÑÐ¾Ð²ÐµÑÐºÐ° Ð¼ÑÐ·ÑÐºÐ°Ð»ÑÐ½Ð¾Ð¹ ÑÐµÐ¼Ð°ÑÐ¸ÐºÐ¸ â Ð¸ÑÐ¿Ð¾Ð»ÑÐ·ÑÐµÑÑÑ ÑÐ¾Ð»ÑÐºÐ¾ Ð´Ð»Ñ ÑÐ²ÐµÐ»Ð¸ÑÐµÐ½Ð¸Ñ ÑÐ°Ð¹Ð¼Ð°ÑÑÐ°,
// Ð½Ðµ Ð·Ð°Ð¿ÑÑÐºÐ°ÐµÑ Ð½Ð¸ÐºÐ°ÐºÐ¸Ñ Ð´Ð¾Ð¿Ð¾Ð»Ð½Ð¸ÑÐµÐ»ÑÐ½ÑÑ Ð²ÑÐ·Ð¾Ð²Ð¾Ð² Ð¼Ð¾Ð´ÐµÐ»Ð¸.
function isCreativeOrNotationRequest(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(ÑÐ³ÐµÐ½ÐµÑÐ¸ÑÑÐ¹|ÑÐ¾Ð·Ð´Ð°Ð¹|Ð½Ð°Ð¿Ð¸ÑÐ¸|Ð¿ÑÐ¸Ð´ÑÐ¼Ð°Ð¹|Ð¿Ð¾ÑÑÑÐ¾Ð¹|ÑÐ¾ÑÐ¸Ð½Ð¸|Ð³Ð°Ð¼Ð¼|Ð°ÐºÐºÐ¾ÑÐ´|Ð½Ð¾Ñ|ÑÑÐ°Ð½|abc|Ð¼ÐµÐ»Ð¾Ð´Ð¸|Ð¿ÑÐµÑ|ÑÐµÐ¿Ð¾ÑÐº)/.test(clean);
}

// Ð£Ð·ÐºÐ°Ñ Ð¿ÑÐ¾Ð²ÐµÑÐºÐ°: Ð¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÐµÐ»Ñ ÑÐµÐ°Ð»ÑÐ½Ð¾ ÑÐ¾ÑÐµÑ ÐÐÐÐ£ÐÐÐ¬ÐÐ«Ð Ð½Ð¾ÑÐ½ÑÐ¹ ÑÑÐ°Ð½ (ÐºÐ°ÑÑÐ¸Ð½ÐºÑ Ð½Ð¾Ñ),
// Ð° Ð½Ðµ Ð¿ÑÐ¾ÑÑÐ¾ ÑÐµÐºÑÑÐ¾Ð²Ð¾Ðµ Ð¾Ð±ÑÑÑÐ½ÐµÐ½Ð¸Ðµ ÑÐµÐ¾ÑÐ¸Ð¸ Ñ ÑÐ¿Ð¾Ð¼Ð¸Ð½Ð°Ð½Ð¸ÐµÐ¼ Ð°ÐºÐºÐ¾ÑÐ´Ð¾Ð²/Ð½Ð¾Ñ.
// Ð¢Ð¾Ð»ÑÐºÐ¾ Ð² ÑÑÐ¾Ð¼ ÑÐ»ÑÑÐ°Ðµ Ð¾Ð¿ÑÐ°Ð²Ð´Ð°Ð½ Ð´Ð¾ÑÐ¾Ð³Ð¾Ð¹ Ð¿Ð¾Ð²ÑÐ¾ÑÐ½ÑÐ¹ Ð²ÑÐ·Ð¾Ð² Ð¼Ð¾Ð´ÐµÐ»Ð¸ Ð´Ð»Ñ abc-Ð½Ð¾ÑÐ°ÑÐ¸Ð¸.
function wantsRenderedStaff(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(Ð½Ð¾ÑÐ½(ÑÐ¹|ÑÑ|Ð¾Ð¼|ÑÐ¼Ð¸)?\s*ÑÑÐ°Ð½|Ð½Ð¾ÑÐ°Ð¼Ð¸|Ð½Ð° Ð½Ð¾ÑÐ°Ñ|Ð·Ð°Ð¿Ð¸ÑÐ¸\s+Ð½Ð¾Ñ|Ð¸Ð·Ð¾Ð±ÑÐ°Ð·Ð¸\s+Ð½Ð¾Ñ|Ð½Ð°ÑÐ¸ÑÑÐ¹\s+Ð½Ð¾Ñ|Ð¿Ð¾ÐºÐ°Ð¶Ð¸\s+Ð½Ð¾Ñ|abc[-\s]?Ð½Ð¾ÑÐ°ÑÐ¸|ÑÑÐ³ÑÐ°Ð¹|ÑÐ¾ÑÐ¸Ð½Ð¸\s+(Ð¼ÐµÐ»Ð¾Ð´Ð¸|Ð¿ÑÐµÑ|Ð³Ð°Ð¼Ð¼)|Ð½Ð°Ð¿Ð¸ÑÐ¸\s+(Ð¼ÐµÐ»Ð¾Ð´Ð¸|Ð¿ÑÐµÑ|Ð³Ð°Ð¼Ð¼)|Ð¿ÑÐ¸Ð´ÑÐ¼Ð°Ð¹\s+(Ð¼ÐµÐ»Ð¾Ð´Ð¸|Ð¿ÑÐµÑ|Ð³Ð°Ð¼Ð¼)|Ð¿Ð¾ÑÑÑÐ¾Ð¹\s+Ð³Ð°Ð¼Ð¼|Ð¿Ð°ÑÑÐ¸ÑÑÑ)/.test(clean);
}

async function maybeSaveDeveloperNote(profile, queryText, trainingMode = false) {
  if (!profile || (profile.role !== 'developer' && profile.role !== 'admin')) return;
  const clean = normalizeText(queryText);
  // Ð ÑÐµÐ¶Ð¸Ð¼Ðµ Â«ÐÐ±ÑÑÐµÐ½Ð¸ÐµÂ» ÑÐ¾ÑÑÐ°Ð½ÑÐµÐ¼ Ð°Ð±ÑÐ¾Ð»ÑÑÐ½Ð¾ Ð²ÑÑ, ÑÑÐ¾ Ð¿ÑÐ¸ÑÐ»Ð°Ð» developer/admin.
  // Ð Ð¾Ð±ÑÑÐ½Ð¾Ð¼ ÑÐ°ÑÐµ â ÑÐ¾Ð»ÑÐºÐ¾ ÑÐ¾Ð´ÐµÑÐ¶Ð°ÑÐµÐ»ÑÐ½ÑÐµ ÑÐ¾Ð¾Ð±ÑÐµÐ½Ð¸Ñ (Ð¿Ð°ÑÑÐ¸Ð²Ð½Ð¾Ðµ Ð¾Ð±ÑÑÐµÐ½Ð¸Ðµ), ÑÑÐ¾Ð±Ñ Ð½Ðµ Ð·Ð°ÑÐ¾ÑÑÑÑ Ð±Ð°Ð·Ñ Ð·Ð½Ð°Ð½Ð¸Ð¹.
  const minLength = trainingMode ? 1 : 24;
  if (clean.length < minLength) return;
  const chunks = chunkText(clean);
  if (!chunks.length) return;

  const [document] = await supabaseRequest('/rest/v1/knowledge_documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      title: trainingMode ? `ÐÐ±ÑÑÐµÐ½Ð¸Ðµ ${new Date().toISOString()}` : `Developer note ${new Date().toISOString()}`,
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
  return 'Ð¡ÐµÑÐ²Ð¸Ñ Ð²ÑÐµÐ¼ÐµÐ½Ð½Ð¾ Ð¿ÐµÑÐµÐ³ÑÑÐ¶ÐµÐ½ Ð¸Ð»Ð¸ Ð¿ÑÐµÐ²ÑÑÐµÐ½ Ð»Ð¸Ð¼Ð¸Ñ Ð·Ð°Ð¿ÑÐ¾ÑÐ¾Ð². ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð½ÐµÐ¼Ð½Ð¾Ð³Ð¾ Ð¿Ð¾Ð·Ð¶Ðµ Ð»Ð¸Ð±Ð¾ Ð¾Ð±ÑÐ°ÑÐ¸ÑÐµÑÑ Ð² Ð¿Ð¾Ð´Ð´ÐµÑÐ¶ÐºÑ (ÐºÐ¾Ð´ 1511).';
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

async function repairNotationReplyIfNeeded(apiKey, modelName, query, replyText) {
  const cleanReply = sanitizeAssistantText(replyText);
  if (!wantsRenderedStaff(query) || hasAbcBlock(cleanReply)) {
    return cleanReply;
  }

  const repairMessages = [
    {
      role: 'system',
      content: [
        'Ð¢Ñ Ð¸ÑÐ¿ÑÐ°Ð²Ð»ÑÐµÑÑ Ð¼ÑÐ·ÑÐºÐ°Ð»ÑÐ½ÑÐ¹ Ð¾ÑÐ²ÐµÑ Ð¼Ð¾Ð´ÐµÐ»Ð¸.',
        'ÐÐµÑÐ½Ð¸ Ð¿Ð¾Ð»Ð½Ð¾ÑÐµÐ½Ð½ÑÐ¹ Ð²Ð¸Ð·ÑÐ°Ð»Ð¸Ð·Ð¸ÑÑÐµÐ¼ÑÐ¹ Ð½Ð¾ÑÐ½ÑÐ¹ ÑÑÐ°Ð½ ÑÑÑÐ¾Ð³Ð¾ ÑÐµÑÐµÐ· Ð¾Ð´Ð¸Ð½ Ð¸Ð»Ð¸ Ð½ÐµÑÐºÐ¾Ð»ÑÐºÐ¾ Ð±Ð»Ð¾ÐºÐ¾Ð² ```abc```.',
        'ÐÐ°Ð¿ÑÐµÑÐµÐ½Ð¾ Ð¸ÑÐ¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÑ ASCII-ÑÑÐ°Ð½, Ð¿ÑÐµÐ²Ð´Ð¾Ð³ÑÐ°ÑÐ¸ÐºÑ, ÑÐ°Ð±Ð»Ð¸ÑÑ Ð»Ð¸Ð½Ð¸Ð¹, Ð¿ÑÐ¾ÑÑÐ¾ ÑÐ¿Ð¸ÑÐ¾Ðº Ð½Ð¾Ñ Ð¸Ð»Ð¸ ÑÐµÐºÑÑÐ¾Ð²Ð¾Ðµ Ð¾Ð¿Ð¸ÑÐ°Ð½Ð¸Ðµ Ð²Ð¼ÐµÑÑÐ¾ abc.',
        'Ð¡Ð½Ð°ÑÐ°Ð»Ð° Ð´Ð°Ð¹ ÐºÐ¾ÑÑÐµÐºÑÐ½ÑÐ¹ abc-Ð±Ð»Ð¾Ðº, Ð·Ð°ÑÐµÐ¼ ÐºÑÐ°ÑÐºÐ¾Ðµ Ð¾Ð±ÑÑÑÐ½ÐµÐ½Ð¸Ðµ.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `ÐÐ°Ð¿ÑÐ¾Ñ Ð¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÐµÐ»Ñ:\n${query}\n\nÐÑÐµÐ´ÑÐ´ÑÑÐ¸Ð¹ Ð¾ÑÐ²ÐµÑ Ð±ÑÐ» Ð½ÐµÐ´Ð¾ÑÑÐ°ÑÐ¾ÑÐ½ÑÐ¼:\n${cleanReply}\n\nÐÐµÑÐµÐ¿Ð¸ÑÐ¸ Ð¾ÑÐ²ÐµÑ ÐºÐ¾ÑÑÐµÐºÑÐ½Ð¾.`
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

async function streamOpenAIToClient(res, apiKey, modelName, messages, timeoutMs, query, largeContext = false) {
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
      message: data?.error?.message || `ÐÑÐ¸Ð±ÐºÐ° Ð¼Ð¾Ð´ÐµÐ»Ð¸ ${modelName}`,
      model: modelName
    };
  }

  if (!upstream.body) {
    return {
      ok: false,
      status: 500,
      message: `ÐÐ¾ÑÐ¾ÐºÐ¾Ð²ÑÐ¹ Ð¾ÑÐ²ÐµÑ Ð½ÐµÐ´Ð¾ÑÑÑÐ¿ÐµÐ½ Ð´Ð»Ñ Ð¼Ð¾Ð´ÐµÐ»Ð¸ ${modelName}`,
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

  const chunkTimeoutMs = largeContext
    ? Math.max(30000, Math.min(timeoutMs, 60000))  // Ð´Ð¾ 60Ñ Ð¼ÐµÐ¶Ð´Ñ ÑÐ°Ð½ÐºÐ°Ð¼Ð¸ Ð´Ð»Ñ Ð±Ð¾Ð»ÑÑÐ¸Ñ Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÐ¾Ð²
    : Math.max(8000, Math.min(timeoutMs, 20000));   // ÑÑÐ°Ð½Ð´Ð°ÑÑÐ½ÑÐ¹ 20Ñ
  while (true) {
    let done, value;
    try {
      ({ done, value } = await withTimeout(
        reader.read(),
        chunkTimeoutMs,
        `OpenAI stream chunk timed out for ${modelName}`
      ));
    } catch (chunkErr) {
      // ÐÐ¾Ð´ÐµÐ»Ñ Ð·Ð°Ð¼Ð¾Ð»ÑÐ°Ð»Ð° Ð¼ÐµÐ¶Ð´Ñ ÑÐ¾ÐºÐµÐ½Ð°Ð¼Ð¸ â Ð³ÑÐ°ÑÐ¸Ð¾Ð·Ð½Ð¾ Ð·Ð°Ð²ÐµÑÑÐ°ÐµÐ¼ Ñ ÑÐµÐ¼, ÑÑÐ¾ Ð¿Ð¾Ð»ÑÑÐ¸Ð»Ð¸
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
          writeSseEvent(res, { type: 'delta', text: delta });
        }
      }
    }
  }

  if (!gotAnyDelta && !fullText.trim()) {
    writeSseEvent(res, { type: 'error', message: 'ÐÐ¾ÑÐ¾ÐºÐ¾Ð²ÑÐ¹ Ð¾ÑÐ²ÐµÑ Ð¿ÑÐµÑÐ²Ð°Ð»ÑÑ ÑÐ»Ð¸ÑÐºÐ¾Ð¼ ÑÐ°Ð½Ð¾. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ ÐµÑÑ ÑÐ°Ð·.' });
    res.end();
    return {
      ok: false,
      status: 504,
      message: `ÐÐ¾ÑÐ¾ÐºÐ¾Ð²ÑÐ¹ Ð¾ÑÐ²ÐµÑ Ð¿ÑÐµÑÐ²Ð°Ð»ÑÑ ÑÐ»Ð¸ÑÐºÐ¾Ð¼ ÑÐ°Ð½Ð¾ Ð´Ð»Ñ Ð¼Ð¾Ð´ÐµÐ»Ð¸ ${modelName}`,
      model: modelName
    };
  }

  const finalText = await repairNotationReplyIfNeeded(apiKey, modelName, query, fullText);
  writeSseEvent(res, { type: 'done', text: finalText });
  res.end();

  return { ok: true, text: finalText, model: modelName };
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
        message: 'ÐÐ»ÑÑ Ð¸Ð»Ð¸ Ð°Ð´ÑÐµÑ API ÐÐ-Ð¿ÑÐ¾Ð²Ð°Ð¹Ð´ÐµÑÐ° Ð½Ð°ÑÑÑÐ¾ÐµÐ½Ñ Ð½ÐµÐ²ÐµÑÐ½Ð¾. ÐÐ±ÑÐ°ÑÐ¸ÑÐµÑÑ Ðº Ð°Ð´Ð¼Ð¸Ð½Ð¸ÑÑÑÐ°ÑÐ¾ÑÑ.'
      }
    });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: { message: 'SUPABASE_URL Ð¸Ð»Ð¸ SUPABASE_SERVICE_ROLE_KEY Ð½Ðµ Ð½Ð°ÑÑÑÐ¾ÐµÐ½Ñ' } });
  }

  try {
    const { messages, model, userId, think = false, effort = 'low', stream = false, trainingMode = false } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'ÐÑÑÑÐ¾Ð¹ Ð·Ð°Ð¿ÑÐ¾Ñ Ðº Ð¼Ð¾Ð´ÐµÐ»Ð¸' } });
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
    // ÐÐ¿ÑÐµÐ´ÐµÐ»ÑÐµÐ¼ ÑÐ°Ð·Ð¼ÐµÑ ÐºÐ¾Ð½ÑÐµÐºÑÑÐ° â ÐµÑÐ»Ð¸ Ð² ÑÐ°ÑÐµ ÐµÑÑÑ Ð±Ð¾Ð»ÑÑÐ¾Ð¹ Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ, Ð½ÑÐ¶Ð½Ñ ÑÐ²ÐµÐ»Ð¸ÑÐµÐ½Ð½ÑÐµ ÑÐ°Ð¹Ð¼Ð°ÑÑÑ
    const totalContextChars = messages.reduce((sum, m) => {
      const c = m.content;
      if (typeof c === 'string') return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text?.length || 0), 0);
      return sum;
    }, 0);
    const isLargeContext = totalContextChars > 80000; // > ~80k ÑÐ¸Ð¼Ð²Ð¾Ð»Ð¾Ð² = Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ Ð² Ð¸ÑÑÐ¾ÑÐ¸Ð¸
    const isNotationHeavy = isCreativeOrNotationRequest(query);
    const wantsStaff = wantsRenderedStaff(query);
    let modelTimeoutMs;
    if (think || effort === 'max') {
      modelTimeoutMs = wantsStaff ? 35000 : 50000;
    } else if (isQuick && !isLargeContext) {
      modelTimeoutMs = 15000;
    } else if (wantsStaff) {
      modelTimeoutMs = 30000;
    } else if (wantsContext) {
      modelTimeoutMs = 35000;
    } else if (isNotationHeavy) {
      modelTimeoutMs = 30000;
    } else {
      modelTimeoutMs = 25000;
    }
    // ÐÐ»Ñ Ð±Ð¾Ð»ÑÑÐ¾Ð³Ð¾ ÐºÐ¾Ð½ÑÐµÐºÑÑÐ° (Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ 300Ðº+ ÑÐ¸Ð¼Ð²Ð¾Ð»Ð¾Ð²) Ð¼Ð¾Ð´ÐµÐ»Ð¸ Ð½ÑÐ¶Ð½Ð¾ Ð±Ð¾Ð»ÑÑÐµ Ð²ÑÐµÐ¼ÐµÐ½Ð¸
    if (isLargeContext) modelTimeoutMs = Math.max(modelTimeoutMs, 90000);
    const mergedSystem = appendServerContext(systemText, [
      profile ? `ÐÑÐ¾ÑÐ¸Ð»Ñ Ð¿Ð¾Ð»ÑÐ·Ð¾Ð²Ð°ÑÐµÐ»Ñ: role=${profile.role || 'user'}, plan=${profile.plan || 'free'}` : '',
      buildMemoryContext(memories, query),
      buildFeedbackContext(feedbackRows, query),
      buildKnowledgeContext(documents, chunks, query)
    ]);

    let lastError = null;

    if (route.provider === 'openai') {
      const openAiMessages = mapMessagesForOpenAI(messages, mergedSystem);
      for (const modelName of route.models) {
        if (stream) {
          const streamResult = await streamOpenAIToClient(res, route.apiKey, modelName, openAiMessages, modelTimeoutMs, query, isLargeContext);
          if (streamResult.ok) return;
          lastError = {
            status: streamResult.status || 500,
            message: streamResult.message || `ÐÑÐ¸Ð±ÐºÐ° Ð¼Ð¾Ð´ÐµÐ»Ð¸ ${modelName}`,
            model: streamResult.model || modelName
          };
          const errorMessage = lastError.message || '';
          if (isModelUnavailable(errorMessage)) {
            console.error(`[harmonyai] model unavailable | model=${modelName} | reason=${compactErrorValue(errorMessage, 500)}`);
            return res.status(400).json({
              error: {
                message: 'ÐÑÐ±ÑÐ°Ð½Ð½Ð°Ñ Ð¼Ð¾Ð´ÐµÐ»Ñ Ð²ÑÐµÐ¼ÐµÐ½Ð½Ð¾ Ð½ÐµÐ´Ð¾ÑÑÑÐ¿Ð½Ð°. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð´ÑÑÐ³ÑÑ Ð¼Ð¾Ð´ÐµÐ»Ñ Ð¸Ð»Ð¸ Ð¿Ð¾Ð²ÑÐ¾ÑÐ¸ÑÐµ Ð¿Ð¾Ð·Ð¶Ðµ.',
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
          lastError = { status: response.status || 500, message: errorMessage || `ÐÑÐ¸Ð±ÐºÐ° Ð¼Ð¾Ð´ÐµÐ»Ð¸ ${modelName}`, model: modelName };
          if (isModelUnavailable(errorMessage)) {
            console.error(`[harmonyai] model unavailable | model=${modelName} | reason=${compactErrorValue(errorMessage, 500)}`);
            return res.status(400).json({
              error: {
                message: 'ÐÑÐ±ÑÐ°Ð½Ð½Ð°Ñ Ð¼Ð¾Ð´ÐµÐ»Ñ Ð²ÑÐµÐ¼ÐµÐ½Ð½Ð¾ Ð½ÐµÐ´Ð¾ÑÑÑÐ¿Ð½Ð°. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð´ÑÑÐ³ÑÑ Ð¼Ð¾Ð´ÐµÐ»Ñ Ð¸Ð»Ð¸ Ð¿Ð¾Ð²ÑÐ¾ÑÐ¸ÑÐµ Ð¿Ð¾Ð·Ð¶Ðµ.',
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
        const replyText = await repairNotationReplyIfNeeded(
          route.apiKey,
          modelName,
          query,
          data?.choices?.[0]?.message?.content || 'ÐÐµÑ Ð¾ÑÐ²ÐµÑÐ°'
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
            message: 'Ð¡ÐµÐ¹ÑÐ°Ñ Ð²ÑÑÐ¾ÐºÐ°Ñ Ð½Ð°Ð³ÑÑÐ·ÐºÐ° Ð½Ð° ÑÐµÑÐ²Ð¸Ñ. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð¿Ð¾Ð²ÑÐ¾ÑÐ¸ÑÑ Ð·Ð°Ð¿ÑÐ¾Ñ ÑÐµÑÐµÐ· Ð¼Ð¸Ð½ÑÑÑ.',
            status: lastError.status || 503
          }
        });
      }

      if (lastError && isTimeoutError(lastError.message)) {
        console.error(`[harmonyai] timeout | model=${lastError.model || ''} | reason=${compactErrorValue(lastError.message, 500)}`);
        return res.status(504).json({
          error: {
            message: 'ÐÐ¾Ð´ÐµÐ»Ñ Ð¾ÑÐ²ÐµÑÐ°ÐµÑ ÑÐ»Ð¸ÑÐºÐ¾Ð¼ Ð´Ð¾Ð»Ð³Ð¾. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ ÐµÑÑ ÑÐ°Ð· Ð¸Ð»Ð¸ Ð¾ÑÐºÐ»ÑÑÐ¸ÑÐµ ÑÐ»Ð¾Ð¶Ð½ÑÐ¹ ÑÐµÐ¶Ð¸Ð¼.',
            status: 504
          }
        });
      }

      console.error(`[harmonyai] request failed | model=${lastError?.model || ''} | reason=${compactErrorValue(lastError?.message, 500)}`);
      return res.status(lastError?.status || 500).json({
        error: {
          message: 'ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð¿Ð¾Ð»ÑÑÐ¸ÑÑ Ð¾ÑÐ²ÐµÑ Ð¾Ñ Ð¼Ð¾Ð´ÐµÐ»Ð¸. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ ÐµÑÑ ÑÐ°Ð·.'
        }
      });
    }

    return res.status(500).json({
      error: {
        message: 'ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð²ÑÐ±ÑÐ°ÑÑ Ð¿ÑÐ¾Ð²Ð°Ð¹Ð´ÐµÑÐ° Ð¼Ð¾Ð´ÐµÐ»Ð¸'
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: error?.message || 'ÐÐ½ÑÑÑÐµÐ½Ð½ÑÑ Ð¾ÑÐ¸Ð±ÐºÐ° ÑÐµÑÐ²ÐµÑÐ°'
      }
    });
  }
}
