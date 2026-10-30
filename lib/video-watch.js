/* ============================================================================
   ИИ СМОТРИТ ВИДЕО ПО ССЫЛКЕ: YouTube и TikTok.

   Смотрит Gemini (ключ GEMINI_API_KEY из Google AI Studio): он видит кадры и
   слышит звук, поэтому умеет описать происходящее, расставить таймкоды,
   переписать текст с экрана, расшифровать речь и прокомментировать смысл.
     • YouTube — ссылку Gemini принимает напрямую (только публичные ролики).
     • TikTok — Gemini ссылки TikTok не открывает. Ролик скачивает неофициальный
       сервис tikwm.com, файл уходит в Gemini (до 18 МБ — прямо в запросе,
       больше — через Files API). Сервис может перестать работать — тогда
       честно говорим об этом и предлагаем прислать файл.

   Лимиты: Free — 5 разных роликов в сутки и до 30 минут каждый, Pro — до 2 часов.
   Повторные вопросы по тому же ролику лимит не тратят. Учёт — таблица
   video_watches (supabase/2026-10-30-video-watch.sql); если её нет, не блокируем.
   ============================================================================ */

// GEMINI_API_BASE — только для стенда с заглушкой.
const gem = () => readEnv('GEMINI_API_BASE') || 'https://generativelanguage.googleapis.com';

function readEnv(name) {
  const v = String(process.env[name] || '').trim();
  return /^(undefined|null|your_key_here)$/i.test(v) ? '' : v;
}
function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

export const FREE_DAILY_VIDEOS = 5;
export const FREE_MAX_SECONDS = 30 * 60;
export const PRO_MAX_SECONDS = 2 * 60 * 60;

/* ------------------------------------------------------------ ссылки */

const YT_RE = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})[^\s)\]»"']*/i;
const TT_RE = /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s)\]»"']+/i;

/* Первая ссылка на видео в тексте → {platform, url, id, key}. */
export function findVideoLink(text) {
  const s = String(text || '');
  let m = s.match(YT_RE);
  if (m) {
    const t = (m[0].match(/[?&]t=(\d+)/) || [])[1];
    return { platform: 'youtube', id: m[1], url: 'https://www.youtube.com/watch?v=' + m[1], key: 'yt:' + m[1], start: t ? Number(t) : 0, raw: m[0] };
  }
  m = s.match(TT_RE);
  if (m) {
    const id = (m[0].match(/\/video\/(\d{8,})/) || [])[1] || '';
    return { platform: 'tiktok', id, url: m[0].replace(/[.,!?]+$/, ''), key: 'tt:' + (id || m[0].replace(/[?#].*$/, '')), raw: m[0] };
  }
  return null;
}

/* Вопрос продолжает разговор о ролике из истории: «а что на 2:30?», «перепиши текст». */
const FOLLOWUP_RE = /(видео|ролик|клип|тикток|ютуб|таймкод|тайм-код|метк|минут|секунд|момент|кадр|сцен|на экране|текст|субтитр|надпис|говорит|сказал|речь|расшифр|переск|о ч[её]м|смысл|комментар|опиши|что (там|происходит|было)|\b\d{1,2}:\d{2}\b)/i;
export function videoFromHistory(messages, query) {
  if (!FOLLOWUP_RE.test(String(query || ''))) return null;
  const users = (messages || []).filter((m) => m && m.role === 'user').slice(-4, -1).reverse();
  for (const m of users) {
    const t = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '');
    const link = findVideoLink(t);
    if (link) return link;
  }
  return null;
}

/* ------------------------------------------------------------ метаданные */

function isoDur(s) {
  const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

async function youtubeMeta(id) {
  const key = readEnv('YOUTUBE_API_KEY');
  const out = { title: '', channel: '', duration: 0 };
  try {
    if (key) {
      const r = await withTimeout(fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${key}`), 6000);
      const d = await r.json().catch(() => ({}));
      const it = (d.items || [])[0];
      if (!it) return { ...out, missing: true };
      return { title: it.snippet?.title || '', channel: it.snippet?.channelTitle || '', duration: isoDur(it.contentDetails?.duration), privacy: it.status?.privacyStatus || '' };
    }
    const r = await withTimeout(fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`), 6000);
    if (r.ok) { const d = await r.json(); return { ...out, title: d.title || '', channel: d.author_name || '' }; }
  } catch (e) { /* без метаданных */ }
  return out;
}

async function tiktokInfo(url) {
  const r = await withTimeout(fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HarmonyAI/1.0)' }
  }), 15000, 'tikwm timeout');
  const d = await r.json().catch(() => ({}));
  if (!d || d.code !== 0 || !d.data) { const e = new Error(d && d.msg ? d.msg : 'tikwm error'); e.code = 'tiktok_unavailable'; throw e; }
  const x = d.data;
  const abs = (u) => (u && !/^https?:/.test(u) ? 'https://www.tikwm.com' + u : u);
  return {
    title: String(x.title || ''), channel: String((x.author && (x.author.nickname || x.author.unique_id)) || ''),
    duration: Number(x.duration) || 0,
    play: abs(x.play || x.hdplay || x.wmplay), size: Number(x.size) || 0
  };
}

/* ------------------------------------------------------------ лимиты */

async function sb(path, init = {}) {
  const base = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return null;
  const r = await withTimeout(fetch(base + path, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }), 6000);
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.status === 204 ? null : r.json().catch(() => null);
}

/* → {ok, used, seen} ; seen — этот ролик сегодня уже смотрели (лимит не тратится). */
export async function checkVideoQuota(userId, key, pro) {
  if (!userId) return { ok: true, used: 0 };
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = await sb(`/rest/v1/video_watches?select=video_key&user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(since)}&limit=500`) || [];
    const keys = new Set(rows.map((r) => r.video_key));
    const seen = keys.has(key);
    if (pro || seen) return { ok: true, used: keys.size, seen };
    return { ok: keys.size < FREE_DAILY_VIDEOS, used: keys.size, seen };
  } catch (e) {
    console.warn('[video-watch] quota check skipped:', e.message);
    return { ok: true, used: 0 };
  }
}
export async function recordVideoWatch(userId, key, seconds) {
  if (!userId) return;
  try {
    await sb('/rest/v1/video_watches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, video_key: key, duration: Math.round(seconds || 0) }]) });
  } catch (e) { console.warn('[video-watch] record failed:', e.message); }
}

/* ------------------------------------------------------------ Gemini */

function geminiKey() { return readEnv('GEMINI_API_KEY') || readEnv('GOOGLE_AI_API_KEY'); }
export function videoWatchConfigured() { return Boolean(geminiKey()); }
/* Ключи нового формата «AQ.» (authorization keys) часть серверов Google не
   принимает в заголовке x-goog-api-key (401 ACCESS_TOKEN_TYPE_UNSUPPORTED),
   а в параметре ?key= — принимает. Пробуем заголовок, при 401/403 —
   параметр, и запоминаем, что сработало. */
let authMode = 'header';
async function gfetch(path, init = {}) {
  const tryMode = async (mode) => {
    const url = gem() + path + (mode === 'query' ? (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(geminiKey()) : '');
    const headers = { ...(init.headers || {}) };
    if (mode === 'header') headers['x-goog-api-key'] = geminiKey();
    return fetch(url, { ...init, headers });
  };
  let r = await tryMode(authMode);
  if (r.status === 401 || r.status === 403) {
    const other = authMode === 'header' ? 'query' : 'header';
    const r2 = await tryMode(other);
    if (r2.status !== 401 && r2.status !== 403) { authMode = other; return r2; }
  }
  return r;
}

/* Модели: из GEMINI_VIDEO_MODEL, иначе — какие реально есть у ключа (список
   кэшируется на час): свежие Flash раньше старых. Названия меняются каждые
   полгода, жёсткий список ломается молча. */
// Стабильные алиасы раньше свежих preview: новейшие модели бывают перегружены
// и не отвечают даже на «привет» за 20 секунд (видно в диагностике).
const PREFERRED = [/^gemini-flash-latest$/, /^gemini-2\.5-flash$/, /^gemini-3[\d.]*-flash$/, /^gemini-3[\d.]*-flash(?!-lite)/, /^gemini-[\d.]+-flash(?!-lite)/, /^gemini-flash-lite-latest$/, /flash-lite/];
let modelCache = { at: 0, list: [] };
export async function availableModels() {
  if (Date.now() - modelCache.at < 3600 * 1000 && modelCache.list.length) return modelCache.list;
  try {
    const r = await withTimeout(gfetch('/v1beta/models?pageSize=200'), 8000, 'models timeout');
    if (!r.ok) return [];
    const d = await r.json().catch(() => ({}));
    const names = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|thinking-exp)/.test(n));
    const ranked = [];
    PREFERRED.forEach((re) => names.filter((n) => re.test(n) && !ranked.includes(n)).sort().reverse().forEach((n) => ranked.push(n)));
    modelCache = { at: Date.now(), list: ranked };
    return ranked;
  } catch (e) { return []; }
}
/* Модели, которые у этого ключа отвечают 404 («больше недоступна новым
   пользователям»), на час убираем из перебора; удачную — ставим первой. */
const deadModels = new Map();
let lastGood = '';
function markDead(m) { deadModels.set(m, Date.now()); }
function isDead(m) { const t = deadModels.get(m); return t && Date.now() - t < 3600 * 1000; }
async function models() {
  const env = readEnv('GEMINI_VIDEO_MODEL');
  const base = env ? env.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const found = await availableModels();
  const list = base.concat(found.length ? found : ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-flash-lite-latest']);
  const uniq = [...new Set(lastGood ? [lastGood, ...list] : list)].filter((m) => !isDead(m));
  return uniq.slice(0, 7);
}

async function uploadToGemini(buf, mime, name) {
  const key = geminiKey();
  const start = await gfetch(`/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: name } })
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('gemini upload start ' + start.status);
  const done = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: buf
  });
  const info = await done.json().catch(() => ({}));
  let file = info.file;
  if (!file || !file.uri) throw new Error('gemini upload ' + done.status);
  // Видео после загрузки обрабатывается — ждём ACTIVE.
  for (let i = 0; i < 40 && file.state !== 'ACTIVE'; i++) {
    if (file.state === 'FAILED') throw new Error('gemini file processing failed');
    await new Promise((r) => setTimeout(r, 1500));
    const r = await gfetch(`/v1beta/${file.name}`);
    file = await r.json().catch(() => file);
  }
  if (file.state !== 'ACTIVE') throw new Error('gemini file not ready');
  return { fileUri: file.uri, mimeType: mime };
}

export const WATCH_SYSTEM = [
  'Ты — HarmonyAI. Пользователь прислал видео, и ты его ПОСМОТРЕЛ: видишь кадры и слышишь звук.',
  'Отвечай по-русски, живым языком, без иностранных слов посреди фраз (названия, имена и цитаты оставляй как есть).',
  'Делай ровно то, о чём просят: описать происходящее, расставить таймкоды, переписать текст с экрана, расшифровать речь,',
  'пересказать, прокомментировать смысл, найти момент, ответить на вопрос. Если просьбы нет — кратко перескажи, о чём ролик,',
  'и дай 4–8 ключевых моментов с таймкодами.',
  'Таймкоды пиши в квадратных скобках: [мм:сс] или [ч:мм:сс] — например «[02:15] Ведущий показывает…».',
  'Текст с экрана переписывай дословно, с таймкодом, где он появился. Речь на другом языке — переводи на русский (оригинал — по просьбе).',
  'Не выдумывай того, чего в видео нет. Если что-то неразборчиво — так и скажи.',
  'Оформление — Markdown: короткие абзацы, списки, жирные подзаголовки.'
].join('\n');

/* Скрытые рассуждения модели — минимальные: для разбора видео они почти не
   нужны, а время до первого слова растёт в разы. */
function thinkingFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: /lite/.test(model) ? 0 : 512 };
  if (/^gemini-(3|flash)/.test(model)) return { thinkingLevel: 'low' };
  return null;
}
function geminiBody(parts, { long, system, model }) {
  const th = thinkingFor(model || '');
  return {
    systemInstruction: { parts: [{ text: system || WATCH_SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      // Длинные ролики — экономное разрешение кадров, иначе не влезут в контекст.
      ...(long ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
      ...(th ? { thinkingConfig: th } : {})
    }
  };
}

/* Поток ответа Gemini: onDelta(text). → полный текст. */
async function streamGemini(model, body, onDelta, timeoutMs, firstTokenMs, outer) {
  const ctrl = new AbortController();
  let cancelled = false;
  if (outer) { if (outer.aborted) cancelled = true; outer.addEventListener('abort', () => { cancelled = true; ctrl.abort(); }); }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Модель «зависла» и не начала отвечать — отдаём ролик следующей.
  let gotFirst = false;
  const firstTimer = firstTokenMs ? setTimeout(() => { if (!gotFirst) ctrl.abort(); }, firstTokenMs) : null;
  try {
    const r = await gfetch(`/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(`gemini ${r.status}: ${t.slice(0, 300)}`);
      e.status = r.status; e.body = t;
      throw e;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let d = null; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
        const parts = d?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (text) { gotFirst = true; full += text; onDelta(text); }
      }
    }
    return full;
  } catch (e) {
    if (cancelled) { const x = new Error('cancelled'); x.status = 499; throw x; }
    if (e && e.name === 'AbortError') { const x = new Error(gotFirst ? 'gemini stream timeout' : `gemini ${model}: no answer in ${Math.round((firstTokenMs || timeoutMs) / 1000)}s`); x.status = 504; throw x; }
    throw e;
  } finally { clearTimeout(timer); if (firstTimer) clearTimeout(firstTimer); }
}

/* Таймкоды [мм:сс] → ссылки на нужную секунду ролика YouTube. */
export function linkTimestamps(text, link) {
  if (!link || link.platform !== 'youtube') return text;
  return String(text || '').replace(/\[(\d{1,2}:)?(\d{1,2}):(\d{2})\](?!\()/g, (m, h, mm, ss) => {
    const sec = (h ? parseInt(h, 10) * 3600 : 0) + parseInt(mm, 10) * 60 + parseInt(ss, 10);
    return `[${m.slice(1, -1)}](https://youtu.be/${link.id}?t=${sec})`;
  });
}

/* Главное: посмотреть ролик и ответить на вопрос.
   opts: {pro, history:[{role,text}], onDelta, onStatus}
   → {ok, text, meta, error, message} */
export async function watchVideo(link, question, opts = {}) {
  const onDelta = opts.onDelta || (() => {});
  const onStatus = opts.onStatus || (() => {});
  if (!geminiKey()) return { ok: false, error: 'not_configured' };
  const maxSec = opts.pro ? PRO_MAX_SECONDS : FREE_MAX_SECONDS;

  let meta = { title: '', channel: '', duration: 0 };
  let videoPart = null;
  if (link.platform === 'youtube') {
    meta = await youtubeMeta(link.id);
    if (meta.missing) return { ok: false, error: 'unavailable', meta };
    if (meta.privacy && meta.privacy !== 'public') return { ok: false, error: 'private', meta };
    videoPart = { fileData: { fileUri: link.url } }; // для YouTube тип файла не указывается
  } else {
    onStatus('Скачиваю ролик из TikTok');
    let info;
    try { info = await tiktokInfo(link.url); } catch (e) { return { ok: false, error: 'tiktok_unavailable', message: e.message }; }
    meta = { title: info.title, channel: info.channel, duration: info.duration };
    if (info.duration && info.duration > maxSec) return { ok: false, error: 'too_long', meta, maxSec };
    const vr = await withTimeout(fetch(info.play, { headers: { 'User-Agent': 'Mozilla/5.0' } }), 30000, 'tiktok download timeout');
    if (!vr.ok) return { ok: false, error: 'tiktok_unavailable', message: 'download ' + vr.status };
    const buf = Buffer.from(await vr.arrayBuffer());
    if (buf.length > 80 * 1024 * 1024) return { ok: false, error: 'too_big', meta };
    if (buf.length <= 18 * 1024 * 1024) videoPart = { inlineData: { mimeType: 'video/mp4', data: buf.toString('base64') } };
    else { onStatus('Загружаю ролик в Gemini'); videoPart = { fileData: await uploadToGemini(buf, 'video/mp4', 'tiktok-' + (link.id || Date.now())) }; }
  }
  if (meta.duration && meta.duration > maxSec) return { ok: false, error: 'too_long', meta, maxSec };
  if (link.start && link.platform === 'youtube') videoPart.videoMetadata = { startOffset: link.start + 's' };

  const context = (opts.history || []).slice(-6).map((t) => `${t.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${String(t.text || '').slice(0, 600)}`).join('\n');
  const ask = [
    meta.title ? `Видео: «${meta.title}»${meta.channel ? ' — ' + meta.channel : ''}${meta.duration ? `, длительность ${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}` : ''}.` : '',
    context ? `Предыдущий разговор:\n${context}` : '',
    `Просьба пользователя: ${String(question || '').replace(link.raw || '', '').trim() || 'посмотри это видео'}`
  ].filter(Boolean).join('\n\n');
  const long = meta.duration > 20 * 60 || !meta.duration;

  onStatus('Смотрю видео');
  const r = await hedgedWatch(await models(), (model, signal, onText) =>
    streamGemini(model, geminiBody([videoPart, { text: ask }], { long, model }), onText, opts.timeoutMs || 240000, long ? 90000 : 45000, signal), onDelta);
  if (r.ok) return { ...r, meta };
  const e = r.err;
  if (e && e.status === 400 && /private|unavailable|not.*(found|accessible)|Unsupported/i.test(e.body || '')) return { ok: false, error: 'unavailable', meta };
  if (e && e.status === 400 && /token|too long|exceeds/i.test(e.body || '')) return { ok: false, error: 'too_long', meta, maxSec };
  if (e && (e.status === 401 || e.status === 403)) return { ok: false, error: 'auth', message: String(e.message).slice(0, 300), meta };
  return { ok: false, error: r.busy ? 'rate_limited' : 'failed', message: e ? String(e.message).slice(0, 300) : '', meta };
}

/* Перебор моделей «с подстраховкой». Google то и дело перегружает отдельные
   модели: одна отвечает 503, другая молчит минуту, третья удалена (404).
   Запускаем первую; если она за HEDGE_MS не начала отвечать — параллельно
   следующую; при быстрой ошибке — следующую сразу. Отвечает тот, кто первым
   дал текст, остальные отменяются. 503/429 — один повтор через пару секунд. */
const HEDGE_MS = 15000;
export async function hedgedWatch(list, run, onDelta, hedgeMs = HEDGE_MS) {
  return new Promise((resolve) => {
    let winner = null, finished = false, next = 0, running = 0, lastErr = null, busy = false, hedgeTimer = null;
    const ctrls = new Map();
    const retried = new Set();
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      ctrls.forEach((c, m) => { if (m !== (r && r.model)) c.abort(); });
      resolve(r);
    };
    const launch = () => {
      clearTimeout(hedgeTimer);
      if (finished || winner) return;
      if (next >= list.length) { if (!running) finish({ ok: false, err: lastErr, busy }); return; }
      start(list[next++]);
      hedgeTimer = setTimeout(launch, hedgeMs);
    };
    const start = (model, again) => {
      const c = new AbortController();
      ctrls.set(model, c);
      running++;
      let sent = '';
      run(model, c.signal, (t) => {
        if (finished) return;
        if (!winner) { winner = model; clearTimeout(hedgeTimer); ctrls.forEach((x, m) => { if (m !== model) x.abort(); }); }
        if (winner !== model) return;
        sent += t; onDelta(t);
      }).then((text) => {
        running--;
        if (winner === model || (!winner && String(text || '').trim())) {
          if (!winner) { winner = model; onDelta(text); }
          lastGood = model;
          return finish({ ok: true, text: sent || text, model });
        }
        if (!winner) launch();
      }, (e) => {
        running--;
        if (finished) return;
        if (winner === model) return finish(sent ? { ok: true, text: sent, model, truncated: true } : { ok: false, err: e, busy });
        if (winner) return;
        console.warn('[video-watch]', model, String(e && e.message || e).slice(0, 200));
        const st = e && e.status;
        // Ошибка про сам ролик или ключ — другие модели не помогут.
        if ((st === 400 && /private|unavailable|not.*(found|accessible)|Unsupported|token|too long|exceeds/i.test(e.body || '')) || st === 401 || st === 403) return finish({ ok: false, err: e });
        if (st === 404) markDead(model);
        if (st !== 499) lastErr = e;
        if (st === 429 || st === 503) busy = true;
        if ((st === 503 || st === 429) && !again && !retried.has(model)) {
          retried.add(model);
          running++; // повтор ещё впереди — не сдаёмся раньше него
          setTimeout(() => { running--; if (!finished && !winner) start(model, true); else if (!finished && !running && next >= list.length) finish({ ok: false, err: lastErr, busy }); }, 2500);
        }
        launch();
      });
    };
    launch();
  });
}

export function watchErrorText(r, link) {
  const where = link && link.platform === 'tiktok' ? 'TikTok' : 'YouTube';
  const mins = (s) => Math.round(s / 60);
  switch (r.error) {
    case 'not_configured': return 'Просмотр видео пока не подключён: нужен ключ Google AI Studio на сервере.';
    case 'auth': return 'Google не принял ключ Gemini, поэтому посмотреть видео не получилось. Нужно проверить ключ в настройках сервера.';
    case 'private': case 'unavailable': return `Не могу открыть это видео на ${where}: оно приватное, удалено или доступно только по ссылке. Я смотрю только открытые ролики.`;
    case 'too_long': return `Ролик слишком длинный: ${r.meta && r.meta.duration ? mins(r.meta.duration) + ' мин' : 'больше лимита'}. В вашем тарифе — до ${mins(r.maxSec || FREE_MAX_SECONDS)} минут.${(r.maxSec || 0) < PRO_MAX_SECONDS ? ' В **Pro** — до 2 часов.' : ''}`;
    case 'too_big': return 'Ролик из TikTok слишком большой для разбора.';
    case 'tiktok_unavailable': return 'Не получилось скачать ролик из TikTok — сервис загрузки сейчас не отвечает. Пришлите видео файлом или попробуйте позже.';
    case 'quota': return `Сегодня вы уже разобрали ${FREE_DAILY_VIDEOS} видео — это лимит Free. Лимит обновится через сутки, а в **Pro** ограничения нет.`;
    case 'rate_limited': return 'Сервис просмотра видео сейчас перегружен. Попробуйте через минуту.';
    default: return 'Не получилось посмотреть видео. Попробуйте ещё раз чуть позже.';
  }
}

/* Диагностика для персонала: принят ли ключ, какие модели видны, отвечает ли
   генерация. Секретов не возвращает. */
export async function diagnoseGemini() {
  const key = geminiKey();
  const out = { configured: Boolean(key), keyFormat: key ? (key.startsWith('AQ.') ? 'AQ (authorization key)' : key.startsWith('AIza') ? 'AIza (standard key)' : 'unknown') : '', authMode: '', models: [], test: null };
  if (!key) return out;
  modelCache = { at: 0, list: [] };
  try {
    const r = await withTimeout(gfetch('/v1beta/models?pageSize=200'), 8000, 'timeout');
    out.modelsStatus = r.status;
    if (!r.ok) out.modelsError = (await r.text().catch(() => '')).slice(0, 400);
  } catch (e) { out.modelsError = e.message; }
  out.authMode = authMode;
  out.models = await availableModels();
  const list = out.models.slice(0, 12);
  out.dead = [...deadModels.keys()].filter(isDead);
  out.lastGood = lastGood;
  out.tests = await Promise.all(list.map(async (m) => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(gfetch(`/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Ответь одним словом: привет' }] }], generationConfig: { maxOutputTokens: 40, ...(thinkingFor(m) ? { thinkingConfig: thinkingFor(m) } : {}) } })
      }), 25000, 'timeout');
      const t = await r.text();
      return { model: m, status: r.status, ms: Date.now() - t0, body: t.slice(0, 200) };
    } catch (e) { return { model: m, error: e.message, ms: Date.now() - t0 }; }
  }));
  return out;
}
