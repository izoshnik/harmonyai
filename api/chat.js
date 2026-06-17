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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function supabaseRequest(path, init = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const headers = { ...buildSupabaseHeaders(), ...(init.headers || {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
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
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,nickname,role,plan,settings&limit=1`
  );
  return rows?.[0] || null;
}

async function fetchAccessibleDocuments(userId) {
  const orClause = userId
    ? `or=(scope.eq.global,and(scope.eq.user,owner_user_id.eq.${userId}))`
    : `scope=eq.global`;
  return await supabaseRequest(
    `/rest/v1/knowledge_documents?select=id,title,scope,source_type,owner_user_id,created_at,chunk_count,is_active&is_active=eq.true&${encodeURI(orClause)}&order=created_at.desc&limit=60`
  );
}

async function fetchChunksForDocuments(docIds) {
  if (!docIds.length) return [];
  const encodedIds = docIds.join(',');
  return await supabaseRequest(
    `/rest/v1/knowledge_chunks?select=document_id,chunk_index,content&document_id=in.(${encodedIds})&order=document_id.asc,chunk_index.asc&limit=600`
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

function buildMemoryContext(memories, query) {
  if (!memories.length) return '';
  const picked = selectTopItems(memories, (item) => item.memory_text, query, 6, 4000);
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

async function maybeSaveDeveloperNote(profile, queryText) {
  if (!profile || profile.role !== 'developer') return;
  const clean = normalizeText(queryText);
  if (clean.length < 24) return;
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

async function callGemini(apiKey, modelName, body) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  return { response, data };
}

async function callOpenAI(apiKey, modelName, messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages
    })
  });
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  return { response, data };
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

function selectRoute(profile, requestedModel) {
  const plan = profile?.plan || 'free';
  const wantsPro = requestedModel === 'pro';

  if (wantsPro && plan === 'premium') {
    const provider = (process.env.PREMIUM_PROVIDER || 'openai').toLowerCase();
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        models: PREMIUM_MODEL_CHAINS.openai
      };
    }
    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      return {
        provider: 'gemini',
        apiKey: process.env.GEMINI_API_KEY,
        models: PREMIUM_MODEL_CHAINS.gemini
      };
    }
  }

  return {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    models: wantsPro ? FREE_MODEL_CHAINS.pro : FREE_MODEL_CHAINS.lite
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

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'GEMINI_API_KEY не настроен' } });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: { message: 'SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не настроены' } });
  }

  try {
    const { messages, model, userId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Пустой запрос к модели' } });
    }

    const profile = await fetchProfile(userId);
    const query = lastUserText(messages);

    const [documents, memories, feedbackRows] = await Promise.all([
      fetchAccessibleDocuments(profile?.id || userId || ''),
      fetchUserMemories(profile?.id || userId || ''),
      fetchFeedback(profile?.id || userId || '')
    ]);
    const chunks = await fetchChunksForDocuments(documents.map((doc) => doc.id));

    await maybeSaveDeveloperNote(profile, query);

    const route = selectRoute(profile, model);
    const { systemText, contents } = mapMessagesForGemini(messages);
    const mergedSystem = appendServerContext(systemText, [
      profile ? `Профиль пользователя: role=${profile.role || 'user'}, plan=${profile.plan || 'free'}` : '',
      buildMemoryContext(memories, query),
      buildFeedbackContext(feedbackRows, query),
      buildKnowledgeContext(documents, chunks, query)
    ]);

    let lastError = null;

    if (route.provider === 'openai') {
      const openAiMessages = mapMessagesForOpenAI(messages, mergedSystem);
      for (const modelName of route.models) {
        const { response, data } = await callOpenAI(route.apiKey, modelName, openAiMessages);
        const errorMessage = data?.error?.message || '';
        if (!response.ok || data.error) {
          lastError = { status: response.status || 500, message: errorMessage || `Ошибка модели ${modelName}`, model: modelName };
          if (isQuotaExceeded(response.status, errorMessage)) {
            return res.status(429).json({
              error: { message: 'Ошибка 1511. Сообщите в поддержку.' }
            });
          }
          if (isOverloaded(response.status, errorMessage)) await sleep(800);
          continue;
        }
        const replyText = data?.choices?.[0]?.message?.content || 'Нет ответа';
        return res.status(200).json({
          choices: [{ message: { content: replyText } }],
          model: modelName
        });
      }
    }

    const body = { contents };
    if (mergedSystem) body.systemInstruction = { parts: [{ text: mergedSystem }] };

    for (const modelName of route.models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { response, data } = await callGemini(route.apiKey, modelName, body);
        const errorMessage = data?.error?.message || '';
        if (!response.ok || data.error) {
          lastError = { status: response.status || 500, message: errorMessage || `Ошибка модели ${modelName}`, model: modelName };
          if (isQuotaExceeded(response.status, errorMessage)) {
            return res.status(429).json({
              error: { message: 'Ошибка 1511. Сообщите в поддержку.' }
            });
          }
          if (isOverloaded(response.status, errorMessage) && attempt === 0) {
            await sleep(900);
            continue;
          }
          break;
        }
        const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Нет ответа';
        return res.status(200).json({
          choices: [{ message: { content: replyText } }],
          model: modelName
        });
      }
    }

    if (lastError && isQuotaExceeded(lastError.status, lastError.message)) {
      return res.status(429).json({
        error: { message: 'Ошибка 1511. Сообщите в поддержку.' }
      });
    }

    if (lastError && isOverloaded(lastError.status, lastError.message)) {
      return res.status(503).json({
        error: { message: 'This model is currently experiencing high demand. Please try again in a minute.' }
      });
    }

    return res.status(lastError?.status || 500).json({
      error: {
        message: lastError?.message || 'Не удалось получить ответ от модели'
      }
    });
  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
}
