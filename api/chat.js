export const config = {
  maxDuration: 300
};

import { FREE_TEXT_MODEL, PRO_TEXT_MODEL, envModel } from '../lib/models.js';

// Adanatos (free) отвечает на claude-haiku-4-5, Dynatos (pro) — на gpt-5.5 (см. lib/models.js).
// Режимы low/max НЕ меняют модель, они меняют только таймаут/глубину (см. selectRoute/handler).
/* ===== REASONING EFFORT ====================================================
   Единый внутренний параметр: low | medium | high | ultra.
   'max' — старое значение фронта, приводится к 'high' (обратная совместимость
   со старыми вкладками, которые ещё шлют effort:'max'). */
const EFFORT_ORDER = ['low', 'medium', 'high', 'ultra'];
function normalizeEffort(value) {
  if (typeof value !== 'string') return 'low'; // любой нестроковый ввод — безопасный уровень
  const raw = value.toLowerCase().trim();
  if (raw === 'max') return 'high';
  return EFFORT_ORDER.includes(raw) ? raw : 'low';
}
function isDeepEffort(effort) {
  return effort === 'high' || effort === 'ultra';
}
/* Провайдеры поддерживают разные уровни: OpenAI-совместимый reasoning_effort
   принимает low|medium|high. Для ultra берём ближайший доступный ('high')
   и дополнительно снимаем лимиты токенов/времени ниже по коду.
   Для low параметр не отправляется вообще — это самый быстрый путь. */
function reasoningParamFor(effort) {
  const e = normalizeEffort(effort);
  if (e === 'low') return '';
  if (e === 'medium') return 'medium';
  return 'high';
}
/* Если модель не знает reasoning_effort — повторяем запрос без параметра,
   чтобы выбор уровня никогда не ломал ответ. */
function isUnsupportedReasoning(message) {
  const low = String(message == null ? '' : message).toLowerCase();
  if (!low) return false;
  return low.includes('reasoning_effort')
    || low.includes('reasoning effort')
    || low.includes('unrecognized request argument')
    || low.includes('extra fields not permitted')
    || (low.includes('unsupported') && low.includes('parameter'))
    || (low.includes('unknown') && low.includes('parameter'));
}

/* Обе цепочки идут через envModel(): даже если в переменных окружения осталось
   старое значение (например gpt-5.4), оно будет отброшено, а не отправлено. */
const MODEL_CHAINS = {
  adanatos: [
    envModel('ADANATOS_MODEL', FREE_TEXT_MODEL),
    envModel('ADANATOS_FALLBACK', FREE_TEXT_MODEL)
  ],
  dynatos: [
    envModel('DYNATOS_MODEL', PRO_TEXT_MODEL),
    envModel('DYNATOS_FALLBACK', PRO_TEXT_MODEL)
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

/* ============================================================================
   ПОИСК В ИНТЕРНЕТЕ
   - Решение «нужен ли поиск» принимает сама ИИ (эвристика): актуальные факты, цены,
     новости, текущие события, конкретные онлайн-ресурсы → нужен. Музыкальная теория,
     творческие задания, личный контекст, общение → не нужен.
   - Источник поиска — DuckDuckGo HTML (не требует ключа). Берём первые результаты,
     вытягиваем текст страницы по паре ссылок, чтобы дать модели реальный контекст.
   - В поток клиенту шлём специальные события: search_query / search_browse /
     search_sources / search_done, которые фронтенд показывает как «размышление
     ИИ: смотрит сайты → просмотрел N сайтов → думаю над ответом». */

const SEARCH_MAX_RESULTS = 6;
const SEARCH_MAX_PAGES_TO_FETCH = 3;
const SEARCH_PAGE_TIMEOUT_MS = 9000;
const SEARCH_PAGE_MAX_CHARS = 6000;

// Эвристика: явно ли пользователь просит свежую/внешнюю информацию из интернета.
function isExplicitWebRequest(query = '') {
  const clean = normalizeText(query).toLowerCase();
  return /(в интернете|в сети|поищи|поиск(а|и)?\s*(в интернете|в сети|онлайн)|найди\s+(в интернете|онлайн|в сети)|загугли|погугли|нагугли|поисковик|актуальн(ая|ые|ый|ое)|сегодня|сейчас\s+(только|только что)?|на сегодня|на этот год|в этом году|в\s+20\d\d|новост|курс(а|ы)?\s+(валют|доллар|рубл)|цена|цены|стоимость|рейтинг|прогноз|погода|расписани|афиш|концерт\s+\d|выпуск\s+\d|обзор\s+нов|последни(е|й|х)\s)/.test(clean);
}

// Эвристика: запрос точно НЕ требует интернета — общение, музыкальная теория,
// творческие задания, личный контекст пользователя. ИИ сама решает, нужен ли поиск,
// но эти случаи отсекаем сразу, чтобы не мучать поиском теорию и творчество.
function isDefinitelyOfflineQuery(query = '') {
  const clean = normalizeText(query).toLowerCase();
  if (!clean) return true;
  // Приветствия / короткие нейтральные фразы
  if (isSimpleQuery(clean)) return true;
  // Музыкальная теория / творчество / ноты — всё это «домашние» знания ИИ
  if (wantsRenderedStaff(clean)) return true;
  if (/(гамм|аккорд|тональност|интервал|сольфеджи|нот(ы|ный|ная|ное)|аппликатур|ритм|такт(ы)?|размер\s+\d|трезвучи|септаккорд|обращени|импровиз|аранжир|транспони|темп\b|динамик(а|и)|штрих\b|фразировк|слух|диктовк)/.test(clean)) return true;
  if (/(сочини|сгенерируй|придумай|напиши\s+(мелоди|пьес|песн|гамм|этюд)|создай\s+(мелоди|пьес|песн|гамм|этюд)|построй\s+гамм)/.test(clean)) return true;
  // Личный контекст пользователя
  if (/(помнишь|как обычно|мо[йяюе]\s|я говорил|я просил|настрой|профил|прикреп|загрузил)/.test(clean)) return true;
  return false;
}

// Финальное решение: нужен ли поиск. Учитывает явный запрос пользователя,
// характер вопроса (факты/актуальность) и исключения.
function decideWebSearch({ query = '', searchEnabled = 'auto' } = {}) {
  // searchEnabled: 'auto' (ИИ решает сама) | 'on' (принудительно) | 'off'
  if (searchEnabled === 'on') return Boolean(query && query.trim());
  if (searchEnabled === 'off') return false;
  // auto
  if (!query || !query.trim()) return false;
  if (isDefinitelyOfflineQuery(query)) return false;
  if (isExplicitWebRequest(query)) return true;
  // Промежуточный случай: длинный фактологический вопрос без признаков теории/творчества —
  // даём шанс поискать, если вопрос снаружи выходит за музыкальную базу знаний.
  const clean = normalizeText(query).toLowerCase();
  if (clean.length > 90 && /(кто\s+(такой|такая|такое|это)|что\s+(такое|это)|когда\s+(состоится|выйдет|начнётся|пройдёт)|где\s+(можно|найти|купить|посмотреть)|сколько\s+(стоит|стоит|стоит)|как\s+(узнать|получить|найти)|почему\s+\w|откуда\s+\w|из\s+какого|в\s+каком\s+году|в\s+каком\s+город)/.test(clean)) {
    return true;
  }
  return false;
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Достаём список результатов из HTML-страницы DuckDuckGo (html.duckduckgo.com/html/).
function parseDuckDuckGoResults(html = '') {
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null && results.length < SEARCH_MAX_RESULTS) {
    let rawHref = match[1] || '';
    // DDG отдаёт редирект-ссылку вида //duckduckgo.com/l/?uddg=<закодированный url>
    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    let url = rawHref;
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch (e) { url = rawHref; }
    }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = stripHtml(match[2] || '');
    const snippet = stripHtml(match[3] || '');
    if (!title && !snippet) continue;
    results.push({ url, title: title || url, snippet });
  }
  return results;
}

async function webSearchResults(query) {
  const cleanQuery = normalizeText(query);
  if (!cleanQuery) return [];
  const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(cleanQuery);
  try {
    const resp = await withTimeout(
      fetch(ddgUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HarmonyAIBot/1.4; +https://harmonyai.app)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        }
      }),
      12000,
      'Web search timed out'
    );
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseDuckDuckGoResults(html);
  } catch (e) {
    console.warn('[harmonyai] web search failed:', compactErrorValue(e?.message, 200));
    return [];
  }
}

// Вытягиваем читаемый текст со страницы результата (без скриптов/стилей), ограничивая объём.
async function fetchPageText(url) {
  try {
    const resp = await withTimeout(
      fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HarmonyAIBot/1.4; +https://harmonyai.app)',
          'Accept': 'text/html,application/xhtml+xml'
        },
        redirect: 'follow'
      }),
      SEARCH_PAGE_TIMEOUT_MS,
      'Page fetch timed out'
    );
    if (!resp.ok) return '';
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) return '';
    const html = await resp.text();
    let text = stripHtml(html);
    if (text.length > SEARCH_PAGE_MAX_CHARS) text = text.slice(0, SEARCH_PAGE_MAX_CHARS) + '…';
    return text;
  } catch (e) {
    return '';
  }
}

// Собираем итоговый контекст из найденных источников: для каждого источника —
// заголовок, ссылка и вытянутый текст (если получилось) или сниппет.
async function buildWebSearchContext(query, res) {
  const results = await webSearchResults(query);
  if (!results.length) return { context: '', sources: [], browsed: 0 };

  const sources = results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet }));
  // Тянем полный текст с нескольких первых страниц. Делаем это последовательно,
  // чтобы посылать клиенту событие search_browse («Смотрю <host>…») перед каждым
  // запросом — пользователь видит, какой конкретно сайт сейчас читает ИИ.
  const toFetch = results.slice(0, SEARCH_MAX_PAGES_TO_FETCH);

  // Список найденного отдаём СРАЗУ, до загрузки страниц: иначе клиент узнаёт о сайтах
  // только когда всё уже прочитано, и показать поэтапно «нашёл → читаю → прочитал»
  // просто не из чего.
  if (res) {
    writeSseEvent(res, {
      type: 'search_found',
      sites: toFetch.map((r) => {
        let host = '';
        try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
        return { url: r.url, title: r.title, host };
      }).filter((s) => s.host)
    });
  }

  const fetched = [];
  for (const r of toFetch) {
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
    if (res && host) writeSseEvent(res, { type: 'search_browse', host });
    fetched.push({ url: r.url, title: r.title, text: await fetchPageText(r.url) });
    // Страница прочитана — гасим «читаю» именно у этого сайта, а не у всех сразу.
    if (res && host) writeSseEvent(res, { type: 'search_browse_done', host });
  }

  const browsed = fetched.filter((f) => f.text && f.text.length > 120).length;
  const parts = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const full = fetched.find((f) => f.url === r.url);
    const body = (full && full.text) || r.snippet || '';
    if (!body) continue;
    parts.push(`[Веб-источник ${i + 1}: ${r.title}]\nURL: ${r.url}\n${body}`);
  }
  const context = parts.length
    ? '\nНАЙДЕННОЕ В ИНТЕРНЕТЕ (используй эти данные для ответа, при необходимости упоминай источники):\n' + parts.join('\n\n')
    : '';
  return { context, sources, browsed };
}

// Составляем «инструкцию про источники», чтобы модель вела себя как «посмотрел сайты — теперь думаю».
function buildWebSearchInstruction(sources) {
  if (!sources || !sources.length) return '';
  const list = sources.slice(0, 6).map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join('\n');
  return [
    '',
    'Ты ТОЛЬКО ЧТО просмотрел сайты в интернете по запросу пользователя. Список просмотренных источников:',
    list,
    'Опирайся на найденные данные. Если данные противоречат твоим знаниям — предпочти свежие данные из источников. Не выдумывай ссылки — используй только те, что даны выше.'
  ].join('\n');
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
    /* Язык рассуждений задаём явно: без этого требования модель почти всегда
       думает по-английски, и пользователь видел англоязычный блок
       «Размышление» над русским ответом. */
    'ЯЗЫК: и рассуждения, и финальный ответ пиши на языке последнего сообщения пользователя. Если пользователь пишет по-русски — рассуждения тоже полностью по-русски, без английских слов и фраз. Никогда не переходи на английский по своей инициативе.',
    'Сначала напиши ход рассуждений простым, связным и читаемым текстом: обычные полные предложения, без markdown-разметки, без обрывков слов и без служебных токенов.',
    'В рассуждениях НЕ используй звёздочки (**), подчёркивания (__), решётки (#), списки и заголовки — только обычная проза. Каждое слово отделяй пробелом, не склеивай их.',
    'Рассуждения держи компактными (примерно 100-200 слов) — скорость ответа важнее длинных размышлений.',
    `Когда рассуждения закончены, выведи на отдельной строке ровно маркер ${REASONING_DELIMITER}`,
    'Сразу после маркера дай финальный, чистый ответ для пользователя.',
    'Ответ после маркера должен быть самодостаточным: НЕ пересказывай в нём свои рассуждения и не ссылайся на них — пользователь видит их отдельно.',
    'ОБЯЗАТЕЛЬНО: маркер и финальный ответ должны быть всегда. Даже если ты не уверен, как ответить лучше всего, — всё равно выведи маркер и дай лучший возможный ответ. Пустой ответ недопустим.',
    'Не используй маркер где-либо ещё, кроме этого единственного разделителя.'
  ].join('\n');
}

function appendServerContext(systemText, additions) {
  return [systemText || '', ...additions.filter(Boolean)].join('\n');
}

// Текущая дата и время сервера (Europe/Moscow). Вызывается на каждый запрос — НЕ кэшируется,
// чтобы модель всегда знала «сегодня» как точку отсчёта. Модели Codex не имеют встроенного
// чувства времени и могут отвечать устаревшей информацией, если не дать им явный ориентир.
function buildCurrentDateTimeContext() {
  try {
    const now = new Date();
    const currentDateString = now.toLocaleDateString('ru-RU', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Europe/Moscow'
    });
    const currentTimeString = now.toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow'
    });
    return `Текущая дата: ${currentDateString}, время: ${currentTimeString} (МСК). Используй эту дату как точку отсчёта "сегодня" при ответах.`;
  } catch (e) {
    // Подстраховка: если Intl/таймзона недоступны в рантайме — отдаём UTC-строку.
    return `Текущая дата (UTC): ${new Date().toUTCString()}. Используй эту дату как точку отсчёта "сегодня" при ответах.`;
  }
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

async function callOpenAI(apiKey, modelName, messages, timeoutMs = 35000, maxTokens = 0, reasoningEffort = '') {
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  const body = { model: modelName, messages };
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const response = await withTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
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
  // Модель не поддерживает уровень reasoning — повторяем без параметра.
  if (reasoningEffort && !response.ok && isUnsupportedReasoning(data && data.error && data.error.message)) {
    delete body.reasoning_effort;
    const retry = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      }),
      timeoutMs,
      `OpenAI request timed out for ${modelName}`
    );
    let retryData = {};
    try {
      retryData = await retry.json();
    } catch (error) {
      retryData = {};
    }
    return { response: retry, data: retryData };
  }
  return { response, data };
}

async function callOpenAIStream(apiKey, modelName, messages, timeoutMs = 65000, maxTokens = 0, reasoningEffort = '') {
  const baseUrl = String(readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  const body = { model: modelName, messages, stream: true };
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const streamResponse = await withTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }),
    timeoutMs,
    `OpenAI stream timed out for ${modelName}`
  );
  // Тот же fallback для стрима: уровень reasoning не должен ломать запрос.
  if (reasoningEffort && !streamResponse.ok) {
    let errText = '';
    try {
      errText = await streamResponse.clone().text();
    } catch (error) {
      errText = '';
    }
    if (isUnsupportedReasoning(errText)) {
      delete body.reasoning_effort;
      return await withTimeout(
        fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body)
        }),
        timeoutMs,
        `OpenAI stream timed out for ${modelName}`
      );
    }
  }
  return streamResponse;
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
  const marker = findAnswerMarker(text);
  // Маркера нет — модель не подчинилась формату; отдаём текст как есть,
  // но всё равно прогоняем через зачистку (вдруг маркер написан неузнаваемо близко к форме).
  if (!marker) return stripAllAnswerMarkers(text);
  // Всё до первого маркера — рассуждения, они в ответ попадать не должны.
  // Остаток чистим ещё раз: модель иногда повторяет маркер ниже по тексту.
  return stripAllAnswerMarkers(String(text).slice(marker.index + marker.length));
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

// Модели часто пишут маркер неточно: с пробелами, жирным, как markdown-заголовок,
// с другим числом «=» или латиницей. Ловим все распространённые варианты — иначе финальный
// ответ целиком уходит в «размышления» и пользователь остаётся без ответа.
//
// Две формы, по убыванию однозначности:
//   1) FRAMED — обрамлённый маркер («===ОТВЕТ===», «**---ANSWER---**»). Такое сочетание
//      в живом тексте не встречается, поэтому ищем его в любом месте строки.
//   2) LOOSE — строка, состоящая ТОЛЬКО из маркера («**ОТВЕТ**», «### Ответ», «[ОТВЕТ]»,
//      «Ответ:»). Промпт как раз требует отдельной строки, а привязка к границам строки
//      не даёт обрезать настоящий ответ на слове «ответ» внутри обычного предложения.
const ANSWER_MARKER_WORD = '(?:ОТВЕТ|ANSWER|OTVET)';
const ANSWER_MARKER_FRAMED_SRC =
  `(?:\\*\\*|__)?[ \\t]*(?:={2,}|-{3,})[ \\t]*${ANSWER_MARKER_WORD}[ \\t]*(?:={2,}|-{3,})[ \\t]*(?:\\*\\*|__)?`;
const ANSWER_MARKER_LOOSE_SRC =
  `^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*|__|\\[)?[ \\t]*${ANSWER_MARKER_WORD}[ \\t]*(?:\\*\\*|__|\\]|:)?[ \\t]*`;

// Хвосты для потокового режима. В буфере лежит живой край стрима, поэтому маркер нельзя
// считать найденным, пока он не ДОПИСАН до конца:
//   • LOOSE требует настоящий перевод строки. Иначе «Ответ» на краю буфера (а следом придёт
//     «ственность за это») сойдёт за маркер, и половина рассуждений уедет в ответ.
//   • FRAMED требует, чтобы после него шёл символ, не продолжающий обрамление. Иначе
//     недописанный «===ОТВЕТ==» распознается как маркер, и лишний «=» окажется в начале ответа.
const MARKER_TAIL_LOOSE_STREAM = '(?=[ \\t]*\\r?\\n)';
const MARKER_TAIL_FRAMED_STREAM = '(?=[^=\\-*_])';
const MARKER_TAIL_LOOSE_FINAL = '(?=[ \\t]*(?:\\r?\\n|$))';

// Ищем самое РАННЕЕ вхождение любой из форм: рассуждения идут первыми, значит первый
// найденный маркер и есть граница «рассуждения → ответ».
//
// opts.atLineStart — начинается ли переданный текст с настоящего начала строки. При стриминге
// в буфере лежит хвост, отрезанный посреди строки, — там «^» подложный, и без этого флага
// обычное «Ответ:» в середине предложения сошло бы за маркер.
// opts.streaming — текст ещё дописывается, требуем от маркера завершённости (см. выше).
function findAnswerMarker(text = '', opts = {}) {
  const src = String(text || '');
  if (!src) return null;

  const atLineStart = opts.atLineStart !== false;
  const streaming = Boolean(opts.streaming);
  const framedSrc = ANSWER_MARKER_FRAMED_SRC + (streaming ? MARKER_TAIL_FRAMED_STREAM : '');
  const looseSrc = ANSWER_MARKER_LOOSE_SRC + (streaming ? MARKER_TAIL_LOOSE_STREAM : MARKER_TAIL_LOOSE_FINAL);

  let best = null;
  const framed = new RegExp(framedSrc, 'i').exec(src);
  if (framed && framed[0]) best = { index: framed.index, length: framed[0].length };

  const looseRe = new RegExp(looseSrc, 'gim');
  let m;
  while ((m = looseRe.exec(src))) {
    if (!m[0]) { looseRe.lastIndex += 1; continue; }
    // Совпадение в самом начале буфера годится только если это правда начало строки.
    if (m.index === 0 && !atLineStart) continue;
    if (!best || m.index < best.index) best = { index: m.index, length: m[0].length };
    break;
  }
  return best;
}

// Вычищает ВСЕ вхождения маркера из готового текста. Последний рубеж: модель иногда печатает
// маркер дважды, и второе вхождение осталось бы в видимом ответе.
function stripAllAnswerMarkers(text = '') {
  let out = String(text || '');
  for (let i = 0; i < 8; i += 1) {
    const marker = findAnswerMarker(out);
    if (!marker) break;
    out = out.slice(0, marker.index) + out.slice(marker.index + marker.length);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Обёртка с SSE keep-alive: пинг-комментарий каждые 15 секунд, чтобы прокси и браузер
// не обрывали соединение во время долгих пауз модели (главная причина «застрявшего» стриминга).
async function streamOpenAIToClient(res, apiKey, modelName, messages, timeoutMs, query, largeContext = false, captureReasoning = false, maxTokens = 0, headersAlreadySent = false, reasoningEffort = '') {
  const heartbeat = setInterval(() => {
    try { if (res.headersSent && !res.writableEnded) res.write(': ping\n\n'); } catch (e) {}
  }, 15000);
  try {
    return await streamOpenAIToClientInner(res, apiKey, modelName, messages, timeoutMs, query, largeContext, captureReasoning, maxTokens, headersAlreadySent, reasoningEffort);
  } finally {
    clearInterval(heartbeat);
  }
}

async function streamOpenAIToClientInner(res, apiKey, modelName, messages, timeoutMs, query, largeContext = false, captureReasoning = false, maxTokens = 0, headersAlreadySent = false, reasoningEffort = '') {
  let fullText = '';
  let gotAnyDelta = false;
  let headersSent = Boolean(headersAlreadySent);
  let buffer = '';

  // Состояние разбора рассуждений в реальном времени (только если captureReasoning=true)
  let rawAll = '';            // весь текст модели как есть (с маркером)
  let switchedToAnswer = !captureReasoning; // если не просили рассуждения — сразу режим ответа
  // Начинается ли rawAll с настоящего начала строки. Пока ничего не отдали — да (это начало
  // всего текста). После отправки куска в буфере остаётся хвост, отрезанный посреди строки, —
  // там «^» подложный, и без этого флага обычное «Ответ:» в середине фразы сошло бы за маркер.
  let rawAtLineStart = true;
  // Провайдер отдал рассуждения отдельным полем (reasoning_content) — значит маркер в тексте
  // ему не нужен: всё, что придёт в content, и есть ответ.
  let sawNativeReasoning = false;
  // Отправляли ли клиенту хоть одно событие `reasoning` — нужно, чтобы понять, есть ли что
  // убирать, если модель так и не выделила ответ маркером.
  let sentReasoningToClient = false;

  // Сколько молчит апстрим между токенами, прежде чем мы считаем это обрывом.
  // Большие документы и режим "Думать" — модель может надолго замолчать во время
  // длинных рассуждений, поэтому даём существенно больше запаса, чем раньше (было 45-60с,
  // чего регулярно не хватало и приводило к ложным обрывам ответа на середине).
  // Скорость важнее бесконечного ожидания: keep-alive пинги идут отдельно, поэтому если модель
  // молчит дольше этого времени — быстрее запускаем «тихое продолжение», а не висим.
  const chunkTimeoutMs = (largeContext || captureReasoning) ? 75000 : 45000;

  // Если апстрим всё же замолчал дольше chunkTimeoutMs — пробуем НЕЗАМЕТНО для пользователя
  // продолжить генерацию с того места, где она остановилась, прежде чем сдаваться и помечать
  // ответ как truncated. Это устраняет подавляющее большинство случаев "ИИ прервал ответ".
  const MAX_SILENT_RETRIES = 2;
  const SILENT_CONTINUE_INSTRUCTION = 'Продолжи свой предыдущий ответ ровно с места, где ты остановился — без повторов и без извинений, просто продолжай текст/нотацию дальше.';

  let currentMessages = messages;
  let stalled = false;
  let attempt = 0;

  while (true) {
    // На первой попытке не душим апстрим коротким таймаутом классификации запроса (low/quick) —
    // 8-12с было недостаточно даже просто на установление соединения и первый токен под нагрузкой.
    // На "тихих" попытках продолжения тоже даём адекватное время на старт ответа.
    const connectTimeoutMs = attempt === 0 ? Math.max(timeoutMs, 45000) : 45000;
    const upstream = await callOpenAIStream(apiKey, modelName, currentMessages, connectTimeoutMs, maxTokens, reasoningEffort);

    if (!upstream.ok) {
      if (attempt === 0) {
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
      // Попытка незаметного продолжения не дотянулась до апстрима — отдаём то, что уже накопили.
      stalled = true;
      break;
    }

    if (!upstream.body) {
      if (attempt === 0) {
        return {
          ok: false,
          status: 500,
          message: `Потоковый ответ недоступен для модели ${modelName}`,
          model: modelName
        };
      }
      stalled = true;
      break;
    }

    if (!headersSent) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      headersSent = true;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let finishedNaturally = false;

    while (true) {
      let done, value;
      try {
        ({ done, value } = await withTimeout(
          reader.read(),
          chunkTimeoutMs,
          `OpenAI stream chunk timed out for ${modelName}`
        ));
      } catch (chunkErr) {
        // Модель замолчала между токенами дольше chunkTimeoutMs — выходим из чтения этой попытки
        // и попробуем незаметно продолжить генерацию (см. ниже), не разрывая ответ пользователю.
        break;
      }
      if (done) { finishedNaturally = true; break; }
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
          // Некоторые провайдеры стримят рассуждения отдельным полем — транслируем их клиенту,
          // чтобы окно «Размышление модели» не оставалось пустым.
          const reasoningDelta = parsed?.choices?.[0]?.delta?.reasoning_content || parsed?.choices?.[0]?.delta?.reasoning || '';
          if (captureReasoning && !switchedToAnswer && typeof reasoningDelta === 'string' && reasoningDelta) {
            writeSseEvent(res, { type: 'reasoning', text: reasoningDelta });
            sentReasoningToClient = true;
            sawNativeReasoning = true;
          }
          let delta = parsed?.choices?.[0]?.delta?.content || '';
          if (Array.isArray(delta)) {
            delta = delta.map((item) => item?.text || '').join('');
          }
          if (typeof delta === 'string' && delta) {
            gotAnyDelta = true;
            fullText += delta;

            // Провайдер уже прислал рассуждения отдельным каналом — content целиком ответ,
            // маркер искать не нужно. Без этого текст ответа уходил бы и в серый блок,
            // и в сам ответ, то есть ровно тем задвоением, на которое жаловался пользователь.
            if (captureReasoning && !switchedToAnswer && sawNativeReasoning) {
              switchedToAnswer = true;
            }

            if (!captureReasoning || switchedToAnswer) {
              writeSseEvent(res, { type: 'delta', text: delta });
              continue;
            }

            // Накопили текст с потенциальным маркером — ищем его, придерживая хвост.
            // ВАЖНО: хвост живёт ТОЛЬКО в rawAll. Раньше он дублировался через pendingHold,
            // из-за чего в окно размышлений попадали задвоенные обрывки слов и «странный текст».
            rawAll += delta;
            const marker = findAnswerMarker(rawAll, { atLineStart: rawAtLineStart, streaming: true });
            if (!marker) {
              // Держим в буфере хвост, который может оказаться началом маркера. Запас с лихвой
              // перекрывает самую длинную форму («**====ОТВЕТ====**»); задержка показа
              // рассуждений на несколько десятков символов на глаз не заметна.
              const holdLen = Math.min(rawAll.length, 48);
              const safeLen = rawAll.length - holdLen;
              if (safeLen > 0) {
                const emitted = rawAll.slice(0, safeLen);
                writeSseEvent(res, { type: 'reasoning', text: emitted });
                sentReasoningToClient = true;
                // Новый буфер начинается с начала строки только если отрезали ровно по переводу строки.
                rawAtLineStart = emitted.slice(-1) === '\n';
                rawAll = rawAll.slice(safeLen);
              }
            } else {
              const reasoningPart = rawAll.slice(0, marker.index);
              if (reasoningPart) {
                writeSseEvent(res, { type: 'reasoning', text: reasoningPart });
                sentReasoningToClient = true;
              }
              const answerPart = rawAll.slice(marker.index + marker.length).replace(/^\s+/, '');
              switchedToAnswer = true;
              rawAll = '';
              rawAtLineStart = true;
              if (answerPart) writeSseEvent(res, { type: 'delta', text: answerPart });
            }
          }
        }
      }
    }

    if (finishedNaturally) break; // апстрим нормально завершил ответ — выходим из внешнего цикла

    // Апстрим замолчал — пытаемся незаметно для клиента продолжить генерацию с накопленного текста.
    attempt += 1;
    if (attempt > MAX_SILENT_RETRIES) { stalled = true; break; }
    currentMessages = [
      ...messages,
      { role: 'assistant', content: fullText },
      { role: 'user', content: SILENT_CONTINUE_INSTRUCTION }
    ];
    buffer = '';
  }

  if (!gotAnyDelta && !fullText.trim()) {
    // Стриминг не выдал ни одного токена (частая причина «Модель отвечает слишком долго»).
    // Прежде чем сдаваться — пробуем один обычный (нестримовый) запрос: он надёжнее под нагрузкой,
    // и если он успевает — пользователь всё равно получает ответ, а не ошибку.
    try {
      const { response, data } = await callOpenAI(apiKey, modelName, messages, Math.max(timeoutMs, 45000), maxTokens, reasoningEffort);
      const raw = data?.choices?.[0]?.message?.content || '';
      if (response.ok && !data?.error && raw.trim()) {
        const finalRaw = captureReasoning ? stripReasoningPrefix(raw) : raw;
        const finalText = stripAllAnswerMarkers(await repairNotationReplyIfNeeded(apiKey, modelName, query, finalRaw));
        if (!headersSent) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          headersSent = true;
        }
        writeSseEvent(res, { type: 'delta', text: finalText });
        writeSseEvent(res, { type: 'done', text: finalText, truncated: false });
        res.end();
        return { ok: true, text: finalText, model: modelName, truncated: false };
      }
    } catch (fallbackErr) {
      // игнорируем — ниже вернём стандартную ошибку, дадим шанс следующей модели в цепочке
    }
    if (headersSent) {
      writeSseEvent(res, { type: 'error', message: 'Потоковый ответ прервался слишком рано. Попробуйте ещё раз.' });
      res.end();
    }
    return {
      ok: false,
      status: 504,
      message: `Потоковый ответ прервался слишком рано для модели ${modelName}`,
      model: modelName
    };
  }

  // fullText — ВЕСЬ сырой текст модели: рассуждения + маркер + ответ. В режиме «Думать»
  // его нужно обрезать по маркеру ВСЕГДА, а не только когда маркер не встретился в потоке.
  // Раньше условие было инвертировано (`&& !switchedToAnswer`), поэтому при найденном маркере
  // событие `done` увозило клиенту сырой текст, и тот заменял им уже настримленный чистый
  // ответ — пользователь видел ход мыслей и служебный «===ОТВЕТ===» прямо в ответе.
  // stripReasoningPrefix безопасен в обоих случаях: без маркера он лишь вычищает мусор.
  const finalRawText = captureReasoning ? stripReasoningPrefix(fullText) : fullText;

  // Ответ оборвался из-за молчания модели даже после попыток незаметно продолжить — не "чиним"
  // нотацию повторным запросом (он может полностью переписать честный частичный текст), просто
  // сообщаем клиенту, что ответ неполный (клиент сам попробует автоматически продолжить ещё раз).
  let finalText = stalled
    ? sanitizeAssistantText(finalRawText)
    : await repairNotationReplyIfNeeded(apiKey, modelName, query, finalRawText);

  // ГАРАНТИЯ ОТВЕТА: если после режима «Думать» финальный текст пуст (модель ушла в рассуждения
  // и не выдала ответ после маркера) — быстро запрашиваем краткий ответ без рассуждений.
  // Лучше хоть какой-то ответ, чем пустое сообщение после «Думал N секунд».
  if (!String(finalText || '').trim()) {
    try {
      const { response, data } = await callOpenAI(apiKey, modelName, [
        ...messages,
        { role: 'user', content: 'Время на размышления закончилось. Немедленно дай краткий финальный ответ на последний вопрос пользователя: без рассуждений и без маркеров, только сам ответ. Даже если не уверен — дай лучший возможный вариант.' }
      ], 25000, 1024);
      const quick = data?.choices?.[0]?.message?.content || '';
      if (response.ok && !data?.error && quick.trim()) {
        finalText = sanitizeAssistantText(stripReasoningPrefix(quick));
      }
    } catch (quickErr) {
      // подстрахуемся ниже текстом, который уже успела написать модель
    }
    if (!String(finalText || '').trim()) {
      // Последний рубеж. В режиме «Думать» СЫРОЙ fullText отдавать нельзя: там лежат только
      // рассуждения (ответа модель так и не дала), а они уже показаны в сером блоке —
      // продублировать их в ответе значит ровно то, на что жаловался пользователь.
      const salvaged = captureReasoning ? stripReasoningPrefix(fullText) : fullText;
      finalText = sanitizeAssistantText(salvaged) || 'Не удалось сформировать развёрнутый ответ. Попробуйте переформулировать вопрос.';
    }
  }

  // Финальная зачистка: даже если маркер проскочил все проверки выше (модель написала его
  // в неожиданной форме или повторила ниже по тексту) — в видимый ответ он не попадёт.
  finalText = stripAllAnswerMarkers(finalText);

  // Модель проигнорировала формат: маркера не было вообще, и всё, что мы отправили как
  // «рассуждения», оказалось её обычным ответом. Показать этот текст и в сером блоке, и в
  // ответе — то самое задвоение мыслей. Просим клиента убрать серый блок: текст не теряется,
  // он остаётся ответом. Если рассуждения пришли отдельным каналом (sawNativeReasoning),
  // блок настоящий — его не трогаем.
  if (captureReasoning && !switchedToAnswer && sentReasoningToClient && !sawNativeReasoning) {
    writeSseEvent(res, { type: 'reasoning_reset' });
  }

  writeSseEvent(res, { type: 'done', text: finalText, truncated: stalled });
  res.end();

  return { ok: true, text: finalText, model: modelName, truncated: stalled };
}

// Роли, у которых есть доступ к Pro-модели Dynatos.
// Max и «Думать» доступны всем тарифам; сервер защищает только выбор модели.
function isProRole(profile){
  const r=String(profile?.role||'').toLowerCase();
  const p=String(profile?.plan||'').toLowerCase();
  return r==='pro'||r==='developer'||r==='admin'||r==='moderator'||p==='pro';
}

function selectRoute(profile, requestedModel) {
  const wantsPro = requestedModel === 'pro';
  // Если запрошена Pro-модель, но роль не Pro — тихо откатываемся на Adanatos.
  const allowedPro = wantsPro && isProRole(profile);
  const modelChain = allowedPro ? MODEL_CHAINS.dynatos : MODEL_CHAINS.adanatos;

  return {
    provider: 'openai',
    apiKey: readEnv('OPENAI_API_KEY'),
    models: modelChain,
    proDowngraded: wantsPro && !allowedPro
  };
}

/* ============================================================================
   СЕРВЕРНАЯ ЗАЩИТА ОТ ЗЛОУПОТРЕБЛЕНИЯ (таблица public.usage_events в Supabase)
   - Adanatos (free): жёсткие суточные/недельные лимиты по токенам ИЛИ сообщениям.
   - Dynatos (pro): формально безлимитен, но защищён «мягкими» потолками, т.к. токены дороги:
       • burst — не более N сообщений за короткое окно (антифлуд);
       • суточный потолок токенов (очень высокий) — режет только явное злоупотребление/скрипты.
   Учёт ведётся по user_id на сервере, поэтому его нельзя обойти очисткой localStorage.
   Гости (без userId) режутся по «мягкому» burst в памяти инстанса (лучше, чем ничего). */
const ABUSE = {
  adanatos: { dayTokens: 20000, dayMessages: 14, weekTokens: 100000, weekMessages: 100 },
  dynatos:  { burstMessages: 25, burstWindowSec: 180, dayTokens: 2000000, dayMessages: 4000 }
};

function estimateTokensFromMessages(messages = []) {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) chars += c.reduce((s, p) => s + (p.text?.length || 0), 0);
  }
  return Math.max(1, Math.ceil(chars / 4));
}

async function insertUsageEvent(userId, model, tokens, messagesCount) {
  if (!userId) return;
  try {
    await supabaseRequest('/rest/v1/usage_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        user_id: userId,
        model: model === 'pro' ? 'dynatos' : 'adanatos',
        tokens: tokens,
        messages: messagesCount || 1,
        created_at: new Date().toISOString()
      }])
    });
  } catch (e) {
    // Учёт не должен ломать основной ответ — просто логируем.
    console.warn('[harmonyai] usage insert failed:', compactErrorValue(e?.message, 200));
  }
}

async function sumUsageSince(userId, model, sinceIso) {
  // Возвращает {tokens, messages, count} по событиям пользователя для модели с момента sinceIso.
  const rows = await supabaseRequest(
    `/rest/v1/usage_events?select=tokens,messages&user_id=eq.${encodeURIComponent(userId)}&model=eq.${model}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=100000`
  );
  let tokens = 0, messages = 0;
  for (const r of rows || []) { tokens += r.tokens || 0; messages += r.messages || 0; }
  return { tokens, messages, count: (rows || []).length };
}

function startOfTodayIso() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function startOfWeekIso() {
  const d = new Date(); const day = d.getDay() || 7;
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (day - 1));
  return d.toISOString();
}

// Проверяет право на запрос ДО вызова модели. Возвращает {ok} или {ok:false, status, message, scope}.
async function checkUsageAllowance(userId, profile, requestedModel) {
  // Разработчики/админы — без ограничений.
  const role = profile?.role || 'user';
  if (role === 'developer' || role === 'admin') return { ok: true };
  // Без userId серверный учёт невозможен — пропускаем (клиент всё равно ограничивает).
  if (!userId) return { ok: true };

  const isPro = requestedModel === 'pro';
  try {
    if (isPro) {
      const cfg = ABUSE.dynatos;
      const [burst, day] = await Promise.all([
        sumUsageSince(userId, 'dynatos', new Date(Date.now() - cfg.burstWindowSec * 1000).toISOString()),
        sumUsageSince(userId, 'dynatos', startOfTodayIso())
      ]);
      if (burst.messages >= cfg.burstMessages) {
        return { ok: false, status: 429, scope: 'burst',
          message: 'Слишком много сообщений подряд. Подождите пару минут — это временная защита от перегрузки.' };
      }
      if (day.tokens >= cfg.dayTokens || day.messages >= cfg.dayMessages) {
        return { ok: false, status: 429, scope: 'day',
          message: 'Достигнут суточный предел защиты от злоупотребления для Dynatos. Он очень высок — если вы его достигли при обычном использовании, обратитесь в поддержку.' };
      }
      return { ok: true };
    }
    const cfg = ABUSE.adanatos;
    const [day, week] = await Promise.all([
      sumUsageSince(userId, 'adanatos', startOfTodayIso()),
      sumUsageSince(userId, 'adanatos', startOfWeekIso())
    ]);
    if (day.tokens >= cfg.dayTokens || day.messages >= cfg.dayMessages) {
      return { ok: false, status: 429, scope: 'day_limit',
        message: 'Дневной лимит Adanatos исчерпан. Он обновится завтра, либо перейдите на Dynatos для работы без ограничений.' };
    }
    if (week.tokens >= cfg.weekTokens || week.messages >= cfg.weekMessages) {
      return { ok: false, status: 429, scope: 'week_limit',
        message: 'Недельный лимит Adanatos исчерпан. Он обновится в начале недели, либо перейдите на Dynatos для работы без ограничений.' };
    }
    return { ok: true };
  } catch (e) {
    // Если учётная таблица недоступна — не блокируем пользователя, но логируем.
    console.warn('[harmonyai] usage check failed (allowing request):', compactErrorValue(e?.message, 200));
    return { ok: true };
  }
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
    let { messages, model, userId, think = false, effort = 'low', stream = false, trainingMode = false, webSearch = 'auto' } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Пустой запрос к модели' } });
    }

    const profile = await fetchProfile(userId);
    // Max и «Думать» разрешены всем. Только Dynatos остаётся серверно защищённым.
    // Прямой запрос model:'pro' от FREE не получает платную модель.
    if (!isProRole(profile) && model === 'pro') model = 'lite';
    // Единый параметр: low | medium | high | ultra ('max' → 'high').
    effort = normalizeEffort(effort);
    think = Boolean(think);
    const query = lastUserText(messages);
    const isQuick = isSimpleQuery(query);
    const wantsContext = needsPersonalContext(query, messages);

    // РЕШЕНИЕ О ПОИСКЕ В ИНТЕРНЕТЕ: ИИ сама определяет, нужен ли поиск, если webSearch='auto'.
    // Пользователь может принудительно включить ('on') или выключить ('off') через кнопку «Поиск».
    const shouldSearch = decideWebSearch({ query, searchEnabled: webSearch });

    // СЕРВЕРНАЯ ПРОВЕРКА ЛИМИТОВ/ЗЛОУПОТРЕБЛЕНИЯ (нельзя обойти через localStorage).
    const allowance = await checkUsageAllowance(userId, profile, model);
    if (!allowance.ok) {
      return res.status(allowance.status || 429).json({
        error: { message: allowance.message, status: allowance.status || 429, scope: allowance.scope }
      });
    }

    let documents = [];
    let memories = [];
    let feedbackRows = [];
    let chunks = [];

    if (wantsContext || think || isDeepEffort(effort) || trainingMode) {
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
    if (effort === 'ultra') {
      // Ultra — самый медленный и ресурсоёмкий уровень: даём максимум времени.
      modelTimeoutMs = wantsStaff ? 80000 : 110000;
    } else if (think || effort === 'high') {
      modelTimeoutMs = wantsStaff ? 60000 : 75000;
    } else if (effort === 'medium') {
      modelTimeoutMs = wantsStaff ? 50000 : 58000;
    } else if (isQuick && !isLargeContext) {
      // Простые вопросы, не связанные с пользователем: быстрый путь без Supabase.
      // Потолок ожидания поднят, чтобы апстрим-модель успевала выдать первый токен под нагрузкой,
      // а не фейлилась ложным «слишком долго» ещё до начала ответа.
      modelTimeoutMs = 30000;
    } else if (wantsStaff) {
      modelTimeoutMs = 40000;
    } else if (wantsContext) {
      modelTimeoutMs = 38000;
    } else if (isNotationHeavy) {
      modelTimeoutMs = 36000;
    } else {
      modelTimeoutMs = 32000;
    }
    // Для большого контекста (документ 300к+ символов) модели нужно больше времени
    if (isLargeContext) modelTimeoutMs = Math.max(modelTimeoutMs, 90000);
    // Ограничиваем длину ответа, чтобы простые вопросы отвечались быстро и не «висели».
    // Сложные режимы (думать/max/нотация/большой контекст) получают большой потолок.
    let maxTokens;
    if (think || isDeepEffort(effort) || isLargeContext || wantsStaff || isNotationHeavy) {
      maxTokens = 0; // без ограничения — нужна полная глубина
    } else if (effort === 'medium') {
      maxTokens = 4096; // средний уровень: запас на развёрнутый структурированный ответ
    } else if (isQuick) {
      maxTokens = 800; // короткий быстрый ответ на простой вопрос
    } else {
      maxTokens = 2048;
    }
    // Если поиск в интернете нужен — выполняем его ДО вызова модели и сразу стримим
    // клиенту события «размышления ИИ»: какой запрос ищу → какие сайты просмотрел →
    // отдаю источники (фронт показывает стрелочку и попап со ссылками).
    let webContext = '';
    let webSources = [];
    let webBrowsed = 0;
    let webHeadersSent = false;
    if (shouldSearch) {
      if (stream) {
        // Открываем SSE-поток заранее, чтобы отправлять события поиска до ответа модели.
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        webHeadersSent = true;
        writeSseEvent(res, { type: 'search_query', query: normalizeText(query) });
      }
      const searchResult = await buildWebSearchContext(query, stream ? res : null);
      webContext = searchResult.context;
      webSources = searchResult.sources;
      webBrowsed = searchResult.browsed;
      if (stream) {
        // Сообщаем клиенту, какие сайты просмотрены, и отдаём список источников для попапа.
        writeSseEvent(res, {
          type: 'search_sources',
          browsed: webBrowsed,
          total: webSources.length,
          sources: webSources.map((s) => ({ url: s.url, title: s.title, snippet: s.snippet }))
        });
        writeSseEvent(res, { type: 'search_done' });
      }
    }

    const mergedSystem = appendServerContext(systemText, [
      buildCurrentDateTimeContext(),
      profile ? `Профиль пользователя: role=${profile.role || 'user'}, plan=${profile.plan || 'free'}` : '',
      think ? buildThinkInstruction() : '',
      buildMemoryContext(memories, query),
      buildFeedbackContext(feedbackRows, query),
      buildKnowledgeContext(documents, chunks, query),
      webContext,
      webSources.length ? buildWebSearchInstruction(webSources) : ''
    ]);

    let lastError = null;

    // Оценка токенов запроса — для серверного учёта использования (записывается при успешном ответе).
    const promptTokens = estimateTokensFromMessages(mapMessagesForOpenAI(messages, mergedSystem));

    if (route.provider === 'openai') {
      const openAiMessages = mapMessagesForOpenAI(messages, mergedSystem);
      /* Когда включён режим «Думать», reasoning_effort НЕ отправляем.
         Иначе провайдер стримит собственные рассуждения в delta.reasoning_content
         (см. streamOpenAIToClientInner), а они не подчиняются системному промпту
         и приходят по-английски — именно это и видел пользователь в блоке
         «Размышление». Без параметра модель пишет рассуждения обычным текстом до
         маркера, и язык задаёт buildThinkInstruction(). Уровень effort при этом
         продолжает влиять на лимит токенов и таймауты. */
      const reasoningParam = think ? '' : reasoningParamFor(effort);
      for (const modelName of route.models) {
        if (stream) {
          const streamResult = await streamOpenAIToClient(res, route.apiKey, modelName, openAiMessages, modelTimeoutMs, query, isLargeContext, Boolean(think), maxTokens, webHeadersSent, reasoningParam);
          if (streamResult.ok) {
            const replyTokens = Math.max(1, Math.ceil(String(streamResult.text || '').length / 4));
            await insertUsageEvent(userId, model, promptTokens + replyTokens, 1);
            return;
          }
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
        const { response, data } = await callOpenAI(route.apiKey, modelName, openAiMessages, modelTimeoutMs, maxTokens, reasoningParam);
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
        const replyTokens = Math.max(1, Math.ceil(String(replyText || '').length / 4));
        await insertUsageEvent(userId, model, promptTokens + replyTokens, 1);
        return res.status(200).json({
          // Нестримовый путь: серого блока здесь нет вовсе, поэтому маркер тем более
          // не должен остаться в тексте — вычищаем все его вхождения.
          choices: [{ message: { content: stripAllAnswerMarkers(replyText) } }]
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
