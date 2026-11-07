/* ============================================================================
   ОТВЕТ НЕ ТЕРЯЕТСЯ ПРИ ВЫХОДЕ ИЗ ВКЛАДКИ
   ----------------------------------------------------------------------------
   iPhone (и любой телефон) замораживает вкладку, как только пользователь
   уходит из браузера: соединение рвётся, клиент видел «Load failed», «Сервер
   слишком долго отвечает» или ответ на полуслове. Функция на сервере при этом
   продолжает работать (обрыв клиента её не останавливает) — ответ просто
   некуда было отдать.

   Теперь клиент присылает jobId, а сервер по ходу генерации сохраняет то, что
   уже написано, в таблицу chat_jobs (раз в несколько секунд и в конце).
   Вернувшись, клиент спрашивает GET /api/chat?job=<id> и дописывает ответ.
   Таблица — supabase/2026-11-06-chat-jobs.sql. Нет таблицы — всё работает как
   раньше, просто без восстановления.

   Записи живут недолго: клиент удаляет запись, получив ответ (DELETE), а всё,
   что старше суток, сервер чистит сам.
   ========================================================================== */

const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FLUSH_MS = 3000;
const LOST_AFTER_MS = 45000; // запись не обновлялась столько — функция умерла
const MAX_TEXT = 200000;

let tableMissing = false;
let lastCleanup = 0;

export function isJobId(id) { return JOB_ID.test(String(id || '')); }

function sb(path, init = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return Promise.reject(new Error('no supabase'));
  return fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(6000)
  });
}

function noteMissing(r) {
  // PostgREST: таблицы нет (миграцию ещё не выполнили) — больше не пытаемся.
  if (r && (r.status === 404 || r.status === 400)) {
    return r.clone().text().then((t) => {
      if (/chat_jobs|PGRST205|42P01|does not exist/i.test(t)) { tableMissing = true; console.warn('[chat-jobs] table chat_jobs missing — run supabase/2026-11-06-chat-jobs.sql'); }
    }).catch(() => {});
  }
  return Promise.resolve();
}

function cleanupOld() {
  const now = Date.now();
  if (now - lastCleanup < 10 * 60 * 1000) return;
  lastCleanup = now;
  const before = new Date(now - 24 * 3600 * 1000).toISOString();
  sb(`chat_jobs?created_at=lt.${encodeURIComponent(before)}`, { method: 'DELETE' }).catch(() => {});
}

/* Разбор того, что функция пишет клиенту: копим ответ, источники, ошибку. */
function absorb(state, chunk) {
  const s = typeof chunk === 'string' ? chunk : (chunk && chunk.toString ? chunk.toString('utf8') : '');
  if (!s || s.indexOf('data:') === -1) return;
  for (const line of s.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev = null;
    try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'delta' && typeof ev.text === 'string') {
      if (state.text.length < MAX_TEXT) state.text += ev.text;
      state.dirty = true;
    } else if (ev.type === 'done') {
      if (typeof ev.text === 'string' && ev.text) state.text = ev.text.slice(0, MAX_TEXT);
      state.truncated = Boolean(ev.truncated);
      state.status = 'done';
      state.dirty = true;
    } else if (ev.type === 'error') {
      state.status = 'error';
      state.error = { message: String(ev.message || '').slice(0, 500), code: ev.code || null, status: ev.status || null };
      state.dirty = true;
    } else if (ev.type === 'search_sources' && Array.isArray(ev.sources)) {
      state.sources = ev.sources.slice(0, 20).map((x) => ({ url: String(x.url || '').slice(0, 500), title: String(x.title || '').slice(0, 200), snippet: String(x.snippet || '').slice(0, 240) }));
      state.dirty = true;
    } else if (ev.type === 'reasoning_end') {
      state.reasoningMs = Math.max(0, Number(ev.durationMs) || 0);
      state.dirty = true;
    }
  }
}

function row(state) {
  return {
    status: state.status,
    text: state.text,
    sources: state.sources || null,
    reasoning_ms: state.reasoningMs ?? null,
    truncated: Boolean(state.truncated),
    error_message: state.error?.message || null,
    error_code: state.error?.code || null,
    updated_at: new Date().toISOString()
  };
}

async function flush(state) {
  if (tableMissing || state.cancelled || state.flushing) return;
  if (!state.dirty && state.inserted) return;
  state.flushing = true;
  state.dirty = false;
  try {
    if (!state.inserted) {
      const r = await sb('chat_jobs', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: state.id, user_id: state.userId, ...row(state) })
      });
      if (r.ok) state.inserted = true; else await noteMissing(r);
      cleanupOld();
    } else {
      // PATCH только живой записи: пользователь нажал «Стоп» (запись удалена) —
      // ответ дальше не сохраняем и не воскрешаем запись.
      const r = await sb(`chat_jobs?id=eq.${encodeURIComponent(state.id)}&user_id=eq.${state.userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row(state))
      });
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        if (Array.isArray(rows) && !rows.length) state.cancelled = true;
      }
    }
  } catch (e) {
    state.dirty = true;
  } finally {
    state.flushing = false;
  }
}

/* Подключить сохранение к ответу. Возвращает state (или null — выключено). */
export function attachChatJob(req, res, { jobId, userId }) {
  if (tableMissing || !isJobId(jobId) || !userId) return null;
  const state = { id: String(jobId), userId: String(userId), status: 'running', text: '', sources: null, reasoningMs: null, truncated: false, error: null, dirty: true, inserted: false, cancelled: false, flushing: false, clientGone: false };
  res.__hmJob = state;

  const markGone = () => { if (!res.writableFinished) state.clientGone = true; };
  try { req.on('aborted', markGone); req.on('close', () => { if (req.aborted) markGone(); }); } catch (e) {}
  try { res.on('close', markGone); } catch (e) {}
  // Запись в закрытое соединение не должна ронять функцию.
  try { res.on('error', () => { state.clientGone = true; }); } catch (e) {}

  const write = res.write.bind(res);
  res.write = function (chunk, ...rest) {
    try { absorb(state, chunk); } catch (e) {}
    if (state.clientGone || res.destroyed || res.socket?.destroyed) { state.clientGone = true; return true; }
    try { return write(chunk, ...rest); } catch (e) { state.clientGone = true; return true; }
  };

  const timer = setInterval(() => { flush(state); }, FLUSH_MS);
  const end = res.end.bind(res);
  let ended = false;
  res.end = function (...args) {
    if (ended) return res;
    ended = true;
    clearInterval(timer);
    if (state.status === 'running') state.status = state.text ? 'done' : 'error';
    if (state.status === 'error' && !state.error) state.error = { message: 'Поток ответа оборвался', code: null };
    state.dirty = true;
    const gone = state.clientGone || res.destroyed || res.socket?.destroyed;
    // Клиент на связи и записи ещё нет — ответ дошёл целиком, сохранять нечего.
    const p = (!state.inserted && !gone) ? Promise.resolve() : waitFlush(state);
    Promise.race([p, new Promise((r) => setTimeout(r, 4000))]).finally(() => {
      if (gone) { try { end(); } catch (e) {} return; }
      try { end(...args); } catch (e) {}
    });
    return res;
  };
  return state;
}

async function waitFlush(state) {
  for (let i = 0; i < 20 && state.flushing; i++) await new Promise((r) => setTimeout(r, 100));
  await flush(state);
}

/* Подсказка клиенту в событии done: запись есть — её можно удалить. */
export function jobExists(res) { return Boolean(res.__hmJob?.inserted); }

/* GET /api/chat?job=<id> — что успел написать сервер. */
export async function readChatJob(jobId, userId) {
  if (tableMissing) return { status: 'missing' };
  if (!isJobId(jobId)) return { status: 'missing' };
  const r = await sb(`chat_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${userId}&select=*`, { method: 'GET' });
  if (!r.ok) { await noteMissing(r); return { status: 'missing' }; }
  const rows = await r.json().catch(() => []);
  const j = Array.isArray(rows) ? rows[0] : null;
  if (!j) return { status: 'missing' };
  let status = j.status;
  if (status === 'running' && Date.now() - Date.parse(j.updated_at || j.created_at) > LOST_AFTER_MS) status = 'lost';
  return {
    status,
    text: j.text || '',
    sources: j.sources || null,
    reasoningMs: j.reasoning_ms,
    truncated: Boolean(j.truncated),
    error: j.error_message ? { message: j.error_message, code: j.error_code } : null
  };
}

/* DELETE /api/chat?job=<id> — ответ получен или пользователь нажал «Стоп». */
export async function deleteChatJob(jobId, userId) {
  if (tableMissing || !isJobId(jobId)) return;
  await sb(`chat_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${userId}`, { method: 'DELETE' }).catch(() => {});
}

export function __resetChatJobs() { tableMissing = false; lastCleanup = 0; }
