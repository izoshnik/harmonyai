/* ============================================================================
   HarmonyAI — распознавание музыки / нотный диктант (Pro-only).
   Две ветки:
     Path A — AudD API (audd.io). Точное совпадение записи (нужен AUDD_API_KEY).
              Если ключа нет или совпадения нет — идём в Path B.
     Path B — эвристика на gpt-5.5 (тот же OPENAI_API_KEY / OPENAI_BASE_URL,
              что и /api/chat). Модель получает текстовое описание мелодии
              (последовательность нот из basic-pitch на клиенте) и играет
              роль музыковеда, отдавая JSON с обязательным confidence.
   Гейт по роли (isProRole из /api/chat) реализуем прямо здесь, чтобы не
   тащить чат-модуль. Free-роль → 403 сразу, без обращения к внешним API.
   ============================================================================ */

export const config = { maxDuration: 60 };

// Лёгкая защита: разрешённые источники (Origin/Referer) + rate-limit по IP.
const ALLOWED_HOSTS = ['harmonyai-zeta.vercel.app', 'localhost', '127.0.0.1'];
function originAllowed(req) {
  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return true; // некоторые webview не шлют заголовок — не блокируем жёстко
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}
const RL_WINDOW_MS = 60 * 1000, RL_MAX = 12; // распознавание тяжелее — не более 12/мин с IP
const _rlStore = new Map();
function rateLimited(req) {
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const rec = _rlStore.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    _rlStore.set(ip, { start: now, count: 1 });
    if (_rlStore.size > 5000) { for (const [k, v] of _rlStore) { if (now - v.start > RL_WINDOW_MS) _rlStore.delete(k); } }
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

// Разрешаем PRO-функции только этим ролям (то же, что клиентский isProUser).
function isProRole(profile) {
  const r = String(profile?.role || '').toLowerCase();
  const p = String(profile?.plan || '').toLowerCase();
  return r === 'pro' || r === 'developer' || r === 'admin' || r === 'moderator' || p === 'pro';
}

function readEnv(name) { return String(process.env[name] || '').trim(); }

async function fetchProfile(userId) {
  if (!userId) return null;
  const base = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,plan&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (e) {
    return null;
  }
}

async function logRecognition({ userId, type, pathUsed, resultJson }) {
  const base = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key || !userId) return;
  try {
    await fetch(`${base}/rest/v1/recognition_requests`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ user_id: userId, type, path_used: pathUsed, result_json: resultJson, created_at: new Date().toISOString() }])
    });
  } catch (e) { /* учёт не критичен */ }
}

/* -------- Path A: AudD (fingerprint по готовой записи) -------- */
async function tryAudD(audioBase64) {
  const apiToken = readEnv('AUDD_API_KEY');
  if (!apiToken || !audioBase64) return null;
  try {
    // AudD принимает multipart file или url. Форма с полем 'file' в data-URI не поддерживается,
    // поэтому декодируем в Buffer и шлём multipart/form-data.
    const buf = Buffer.from(audioBase64, 'base64');
    const boundary = '----HarmonyAI' + Date.now();
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="api_token"\r\n\r\n${apiToken}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="return"\r\n\r\napple_music,spotify\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
      'utf8'
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, buf, closing]);
    const res = await fetch('https://api.audd.io/', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    const data = await res.json().catch(() => null);
    if (!data || data.status !== 'success' || !data.result) return null;
    const r = data.result;
    return {
      source: 'fingerprint',
      workGuess: r.title || '',
      composerGuess: r.artist || '',
      periodGuess: r.release_date || r.album || '',
      confidence: 'высокая',
      reasoning: 'Точное совпадение с записью в базе AudD (fingerprint).',
      raw: { title: r.title, artist: r.artist, album: r.album, releaseDate: r.release_date }
    };
  } catch (e) {
    console.warn('[recognize] AudD failed:', e?.message || e);
    return null;
  }
}

/* -------- Path B: gpt-5.5 как музыковед -------- */
async function tryHeuristic({ mode, melodyDescription }) {
  const apiKey = readEnv('OPENAI_API_KEY');
  const baseUrl = (readEnv('OPENAI_BASE_URL') || 'https://api.codex-api.online/v1').replace(/\/+$/, '');
  if (!apiKey) return null;
  const model = readEnv('RECOGNIZE_MODEL') || 'gpt-5.5';

  const system = [
    'Ты музыковед-эксперт, специализируешься на классической и академической музыке (Бах, Гайдн, Моцарт, Бетховен, романтики, XX век и т.д.), но знаешь и другие стили.',
    'Пользователь СЫГРАЛ или НАПЕЛ мелодию, её расшифровка (последовательность нот и приблизительная структура) даётся ниже.',
    'Задача — предположить произведение, автора и период по стилю, гармонии и мелодическому рисунку.',
    'ВАЖНО:',
    '1. Никогда не выдумывай точные факты (номер опуса, дату). Если не уверен — так и скажи "предположительно" или "стиль напоминает".',
    '2. Обязательно укажи confidence: "высокая", "средняя" или "низкая".',
    '3. Отвечай СТРОГО валидным JSON без markdown-обёрток, ровно с полями: workGuess, composerGuess, periodGuess, confidence, reasoning.',
    '4. reasoning — 2-3 предложения на русском о том, почему ты пришёл к этому выводу.'
  ].join('\n');

  const user = `Мелодия: ${melodyDescription || '(без транскрипции — попробуй по общему описанию)'}\n\nОпредели произведение.`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.choices?.[0]?.message?.content) {
      return { source: 'heuristic', workGuess: '', composerGuess: '', periodGuess: '', confidence: 'низкая', reasoning: 'Модель не смогла определить произведение по фрагменту.' };
    }
    let parsed;
    try { parsed = JSON.parse(data.choices[0].message.content); } catch (e) { parsed = null; }
    if (!parsed) {
      return { source: 'heuristic', workGuess: '', composerGuess: '', periodGuess: '', confidence: 'низкая', reasoning: String(data.choices[0].message.content).slice(0, 400) };
    }
    return {
      source: 'heuristic',
      workGuess: String(parsed.workGuess || ''),
      composerGuess: String(parsed.composerGuess || ''),
      periodGuess: String(parsed.periodGuess || ''),
      confidence: String(parsed.confidence || 'низкая'),
      reasoning: String(parsed.reasoning || '')
    };
  } catch (e) {
    console.warn('[recognize] heuristic failed:', e?.message || e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  // Лёгкая защита от злоупотребления.
  if (!originAllowed(req)) return res.status(403).json({ error: { message: 'Недопустимый источник запроса.' } });
  if (rateLimited(req)) return res.status(429).json({ error: { message: 'Слишком много запросов. Попробуйте через минуту.' } });

  try {
    const { mode = 'identify', audioBase64 = '', melodyDescription = '', userId = null } = req.body || {};
    if (mode !== 'identify' && mode !== 'dictation') {
      return res.status(400).json({ error: { message: 'Неизвестный режим' } });
    }

    // Pro-гейт: без ID или без Pro-роли — отказ (клиент это дублирует, но серверная проверка обязательна).
    const profile = await fetchProfile(userId);
    if (!isProRole(profile)) {
      return res.status(403).json({ error: { message: 'Функция доступна только на тарифе Pro.' } });
    }

    // Диктант: сам нотный текст уже собран на клиенте через basic-pitch. Сервер только
    // прогоняет melodyDescription через gpt-5.5, чтобы дать текстовый комментарий/название
    // (Path A для диктанта не имеет смысла — пользователь сам играет мелодию).
    if (mode === 'dictation') {
      const heur = (await tryHeuristic({ mode, melodyDescription })) || {
        source: 'heuristic', workGuess: 'Нотный диктант', composerGuess: '', periodGuess: '', confidence: 'средняя',
        reasoning: 'Расшифровка выполнена автоматически. Проверьте ноты и при необходимости отредактируйте вручную.'
      };
      await logRecognition({ userId, type: 'notation', pathUsed: 'heuristic', resultJson: heur });
      return res.status(200).json(heur);
    }

    // Identify: сначала пробуем AudD (Path A), затем gpt-5.5 эвристику (Path B).
    let result = await tryAudD(audioBase64);
    let pathUsed = 'fingerprint';
    if (!result) {
      result = await tryHeuristic({ mode, melodyDescription });
      pathUsed = result ? 'heuristic' : 'none';
    }
    if (!result) {
      result = { source: 'heuristic', workGuess: '', composerGuess: '', periodGuess: '', confidence: 'низкая', reasoning: 'Не удалось получить ни fingerprint-совпадение, ни ответ модели.' };
    }
    await logRecognition({ userId, type: 'audio_id', pathUsed, resultJson: result });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: { message: e?.message || 'Внутренняя ошибка сервера' } });
  }
}
