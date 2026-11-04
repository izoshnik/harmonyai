/* ============================================================================
   СЛУЖЕБНЫЕ ЗАДАЧИ МОДЕЛИ, у которых нет своей функции на Vercel
   (лимит Hobby — 12 функций), поэтому они живут здесь и подключаются из
   существующих api/util.js и api/music.js:

     • summarizeUserProfile — краткая сводка «о пользователе» для Персонализации;
     • planPlaylist        — идеи треков для плейлиста по описанию.

   Обе — один нестриминговый вызов служебной модели с JSON-ответом и
   fail-closed по смыслу: при сбое возвращаем пустой результат, а не выдумку.
   ============================================================================ */
import { utilityEndpoint, utilityModel, fastReasoningEffort, noteUnaskedReasoning, responseHasReasoning, supportsReasoningEffort, providerForModel, providerFetch, geminiApiKey, geminiChatModel, coolDownModel, isCoolingDown } from './models.js';
import { warmCatalog, fastUtilityModels } from './model-catalog.js';

/* Запасные служебные модели: если основная (pro-ai.online) отвечает ошибкой
   шлюза или недоступна, служебные задачи — поисковые запросы, разбор музыки и
   видео, заголовки — не должны молча отваливаться. Сначала самые быстрые —
   Groq и Cerebras (если заданы их ключи), затем Gemini Flash Lite (GEMINI_API_KEY),
   затем бесплатная модель OpenRouter.
   UTILITY_FALLBACK_MODEL (через запятую) переопределяет список. */
const UTILITY_FALLBACK = 'nvidia/nemotron-3.5-super-vl:free';
function utilityFallbacks() {
  const env = String(process.env.UTILITY_FALLBACK_MODEL || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (env.length) return env;
  warmCatalog().catch(() => {}); // список моделей Groq/Cerebras обновится к следующему вызову
  return [...fastUtilityModels(), ...(geminiApiKey() ? [geminiChatModel()] : []), UTILITY_FALLBACK];
}

function clean(text = '') {
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractJson(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* ниже */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (e) { /* ниже */ } }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch (e) { /* ниже */ } }
  return null;
}

/* Один вызов служебной модели. Возвращает {text, reason}.
   Служебная модель по умолчанию «рассуждает»: на холодном сервере это
   выясняется только после первого ответа, а длинный ответ (список треков)
   за это время упирался в max_tokens или в таймаут. Поэтому для задач с
   длинным ответом lowReasoning=true просит думать по минимуму сразу.
   Основная модель, которая только что упала с ошибкой шлюза, минуту не
   вызывается — запрос сразу идёт к запасной (без 3–5 секунд на заведомый 502). */
async function callModel(messages, opts = {}) {
  const primary = opts.model || utilityModel(opts.envNames || []);
  let first = { text: '', reason: 'cooldown' };
  if (opts.model || !isCoolingDown(primary)) {
    first = await callModelOnce(messages, opts);
    // Таймаут не повторяем, чтобы не удваивать ожидание (если не попросили явно).
    if (first.text || opts.model || (first.reason === 'timeout' && !opts.fallbackOnTimeout)) return first;
    if (/^http_50[234]$/.test(first.reason) || first.reason === 'network') coolDownModel(primary, 60000);
  }
  for (const fb of utilityFallbacks()) {
    if (fb === primary || isCoolingDown(fb)) continue;
    // Запасная модель может рассуждать перед ответом — короткий лимит токенов она съедала целиком и отвечала пусто.
    const r = await callModelOnce(messages, { ...opts, model: fb, timeoutMs: opts.fallbackTimeoutMs || opts.timeoutMs, maxTokens: Math.max(500, opts.maxTokens || 0) });
    if (r.text) { console.warn('[ai-tasks] utility fallback used:', first.reason, '→', fb); return r; }
    if (r.reason === 'http_429' || /^http_50[234]$/.test(r.reason)) coolDownModel(fb, 60000);
  }
  return first;
}
async function callModelOnce(messages, { maxTokens = 600, temperature = 0.3, timeoutMs = 25000, envNames = [], json = true, lowReasoning = false, model: forced = '' } = {}) {
  const model = forced || utilityModel(envNames);
  // Модель из переменных *_MODEL может быть и OpenRouter (vendor/model), и Gemini — у них свой адрес и ключ.
  const base = providerForModel(model);
  const pr = forced || base.openrouter || base.gemini ? base : { ...base, ...utilityEndpoint() };
  if (!pr.apiKey || !pr.baseUrl) return { text: '', reason: 'no_key' };
  const openrouter = Boolean(pr.openrouter);
  const gemini = Boolean(pr.gemini);
  const extra = Boolean(pr.extra);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const effort = !openrouter && ((lowReasoning && supportsReasoningEffort(model)) || fastReasoningEffort(model)) ? 'low' : '';
    const body = {
      model,
      messages,
      temperature,
      // У Gemini лимит ответа включает и скрытые рассуждения — даём запас.
      max_tokens: maxTokens + (gemini ? 1024 : extra ? 1500 : 0),
      // response_format принимают не все шлюзы и модели — у Gemini и NIM/Cerebras/Groq JSON просим словами в промпте.
      ...(json && !openrouter && !gemini && !extra ? { response_format: { type: 'json_object' } } : {}),
      ...(openrouter ? { reasoning: { enabled: false } } : (effort ? { reasoning_effort: effort } : {}))
    };
    let response = await providerFetch(pr, '/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify(body) });
    if (response.status === 400 && body.reasoning_effort) {
      // Модель не приняла reasoning_effort — повторяем без него.
      delete body.reasoning_effort;
      response = await providerFetch(pr, '/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify(body) });
    }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn('[ai-tasks] model HTTP', model, response.status, errBody.slice(0, 200));
      return { text: '', reason: 'http_' + response.status };
    }
    const data = await response.json().catch(() => ({}));
    if (responseHasReasoning(data)) noteUnaskedReasoning(model);
    const text = String(data?.choices?.[0]?.message?.content || '');
    if (!text.trim()) console.warn('[ai-tasks] empty content, finish:', data?.choices?.[0]?.finish_reason);
    return { text, reason: text.trim() ? '' : 'empty_' + (data?.choices?.[0]?.finish_reason || 'unknown') };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timeout' : 'network';
    console.warn('[ai-tasks] model call failed:', reason, String(e?.message || e).slice(0, 200));
    return { text: '', reason };
  } finally {
    clearTimeout(timer);
  }
}
/* Служебный вызов для модулей вне этого файла (классификаторы интента, заголовки
   чатов, модерация, дистиллятор): та же логика, что у задач здесь, — при отказе
   основной модели (5xx, «Chat Completions is temporarily unavailable», сеть)
   отвечает запасная. Раньше эти модули ходили к провайдеру напрямую и при его
   сбое молча ломались: «найди трек» не находился, «нарисуй» уходил в текст.
   Возвращает {text, reason}. */
export async function utilityChat(messages, opts = {}) {
  return callModel(messages, { json: false, ...opts });
}
/* Диагностика служебных моделей для персонала: сырой ответ основной и запасной. */
export async function utilityProbe() {
  const msgs = [{ role: 'system', content: 'Ответ — ТОЛЬКО JSON: {"queries":["..."]}' }, { role: 'user', content: 'лучший бесплатный ИИ для видео' }];
  const fb = utilityFallbacks()[0];
  const [a, b] = await Promise.all([
    callModelOnce(msgs, { maxTokens: 120, timeoutMs: 8000, json: true, lowReasoning: true }),
    callModelOnce(msgs, { maxTokens: 120, timeoutMs: 8000, json: true, model: fb })
  ]);
  return { primary: { reason: a.reason, text: String(a.text).slice(0, 200) }, fallback: { model: fb, reason: b.reason, text: String(b.text).slice(0, 200) } };
}
async function callJson(messages, opts = {}) {
  const r = await callModel(messages, { ...opts, json: true });
  const parsed = extractJson(r.text);
  if (r.text && !parsed) console.warn('[ai-tasks] model returned no JSON');
  return parsed;
}

/* ---------------------------------------------------------------- сводка о пользователе */

export const SUMMARY_MAX = 700;

/* Секреты и платёжные данные в сводку не попадают ни при каких условиях. */
const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}|(?:\d[ -]?){13,19}|парол|password|токен|token|api[-_ ]?key)/i;

export async function summarizeUserProfile({ previous = '', messages = [], facts = [] } = {}) {
  const userLines = (Array.isArray(messages) ? messages : [])
    .map((m) => clean(m).slice(0, 400))
    .filter(Boolean)
    .slice(-30);
  const factLines = (Array.isArray(facts) ? facts : []).map((f) => clean(f).slice(0, 200)).filter(Boolean).slice(0, 25);
  if (!userLines.length && !factLines.length) return { summary: clean(previous).slice(0, SUMMARY_MAX), changed: false };

  const sys =
    'Ты ведёшь КРАТКУЮ сводку о пользователе музыкального ИИ-помощника HarmonyAI, чтобы ответы были персональнее. ' +
    'Верни строго JSON {"summary":"...","changed":true|false}. ' +
    'summary — 3–7 коротких строк, каждая начинается с «• », всего не больше 600 символов, на русском. ' +
    'Что включать: уровень и где учится (ДМШ, колледж, класс), инструмент, интересующие темы и жанры, ' +
    'цели (экзамен, поступление), предпочтения к ответам (кратко/подробно, с примерами, нотами), имя, если сам назвал. ' +
    'Пиши только то, что явно следует из сообщений или фактов; не выдумывай и не делай выводов о здоровье, ' +
    'политике, религии, финансах. Никогда не включай пароли, ключи, номера карт, адреса, телефоны. ' +
    'Сохраняй верные пункты прежней сводки, обновляй устаревшие. Если нового нет — верни прежнюю сводку и changed:false.';
  const usr =
    'Прежняя сводка:\n' + (clean(previous) || '(пусто)') +
    (factLines.length ? '\n\nСохранённые факты:\n- ' + factLines.join('\n- ') : '') +
    '\n\nНедавние сообщения пользователя:\n- ' + (userLines.join('\n- ') || '(нет)') +
    '\n\nВерни JSON.';

  const out = await callJson(
    [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    { maxTokens: 500, temperature: 0.2, envNames: ['SUMMARY_MODEL', 'INTENT_MODEL'] }
  );
  if (!out || typeof out.summary !== 'string') return null;
  let summary = clean(out.summary)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !SECRETISH.test(l))
    .map((l) => (/^[•\-*]\s*/.test(l) ? '• ' + l.replace(/^[•\-*]\s*/, '') : '• ' + l))
    .join('\n');
  if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX).replace(/\n[^\n]*$/, '');
  return { summary, changed: out.changed !== false && summary !== clean(previous) };
}

/* ---------------------------------------------------------------- плейлист */

export const PLAYLIST_MIN = 5;
export const PLAYLIST_MAX = 30;

/* Тема просьбы без служебных слов — для запасного поиска по каталогу:
   «Собери плейлист из популярных треков канье уэста на 15 треков» → «канье уэста». */
export function playlistTopic(prompt) {
  let t = ' ' + clean(prompt).toLowerCase().replace(/ё/g, 'е') + ' ';
  t = t.replace(/[«»"“”.,!?:;()]/g, ' ')
    .replace(/\d+\s*(?:-|–|—|до)?\s*\d*\s*(?:трек\S*|пес\S*|композиц\S*|шт\S*|позиц\S*)?/g, ' ')
    .replace(/\s(?:пожалуйста|мне|нам|собери|составь|сделай|создай|подбери|сгенерируй|набросай|придумай|накидай|сформируй|замути|новый|свой|плейлист\S*|подборк\S*|playlist|сборник\S*|микс\S*|из|с|со|для|на|в|во|по|под|стиле|жанре|популярн\S*|лучш\S*|известн\S*|хит\S*|топ\S*|трек\S*|песн\S*|пес|музык\S*|композици\S*|штук|примерно|около|еще)(?=\s)/g, ' ');
  return t.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function parsePlaylistText(text) {
  const raw = String(text || '');
  const asJson = extractJson(raw);
  if (asJson && Array.isArray(asJson.tracks)) {
    return {
      title: asJson.title, description: asJson.description,
      tracks: asJson.tracks.map((t) => ({ artist: t?.artist, title: t?.title }))
    };
  }
  let title = '', description = '', intro = '', suggest = '', chip = '';
  const tracks = [];
  for (const line0 of raw.split('\n')) {
    const line = line0.replace(/\*\*/g, '').trim();
    if (!line) continue;
    const mt = line.match(/^(?:название|title)\s*[:：]\s*(.+)$/i);
    if (mt) { title = mt[1]; continue; }
    const md = line.match(/^(?:описание|description)\s*[:：]\s*(.+)$/i);
    if (md) { description = md[1]; continue; }
    const mi = line.match(/^(?:вступление|intro)\s*[:：]\s*(.+)$/i);
    if (mi) { intro = mi[1]; continue; }
    const ms = line.match(/^(?:предложение|suggest(?:ion)?)\s*[:：]\s*(.+)$/i);
    if (ms) { suggest = ms[1]; continue; }
    const mb = line.match(/^(?:кнопка|button)\s*[:：]\s*(.+)$/i);
    if (mb) { chip = mb[1]; continue; }
    const m = line.match(/^(?:\d+[.)]\s*|[-•*]\s*)?(.+?)\s+[—–-]\s+(.+)$/);
    if (m) tracks.push({ artist: m[1].replace(/^["«]|["»]$/g, ''), title: m[2].replace(/^["«]|["»]$/g, '').replace(/\s*\(\d{4}\)\s*$/, '') });
  }
  return { title, description, intro, suggest, chip, tracks };
}

export async function planPlaylist(prompt, count, context = '') {
  const want = Math.max(PLAYLIST_MIN, Math.min(PLAYLIST_MAX, Number(count) || 15));
  let lastReason = '';
  /* Две попытки: вторая — короче, на случай таймаута или обрезанного ответа. */
  for (const ask of [want + 5, Math.min(want + 2, 22)]) {
    const t0 = Date.now();
    const sys =
      'Ты музыкальный редактор. По просьбе пользователя составь плейлист из РЕАЛЬНО существующих треков, ' +
      'которые есть в Яндекс Музыке. Отвечай без рассуждений и пояснений, строго в формате:\n' +
      'НАЗВАНИЕ: короткое название плейлиста (2–5 слов)\n' +
      'ОПИСАНИЕ: одно предложение о настроении\n' +
      '1. Исполнитель — Название трека\n2. Исполнитель — Название трека\n…\n' +
      `Ровно ${ask} позиций, без повторов. Если просят треки одного исполнителя — бери его самые известные треки; ` +
      'иначе не больше 2 треков одного исполнителя. Порядок — как в хорошем плейлисте. ' +
      'Оригинальные названия (латиницей, если они латиницей), без годов и без «feat.».\n' +
      'После списка добавь три строки:\n' +
      'ВСТУПЛЕНИЕ: одно живое предложение от первого лица о том, что ты собрал (например «Собрал плейлист «…» — 15 треков …»).\n' +
      'ПРЕДЛОЖЕНИЕ: 1–2 предложения: предложи изменить плейлист или собрать ещё один; если в данных о пользователе есть ' +
      'любимые исполнители или жанры, связанные с просьбой, предложи конкретный плейлист с ними (например «Ты любишь Tame Impala — ' +
      'могу собрать плейлист из их популярных треков»). Не выдумывай вкусы, которых нет в данных.\n' +
      'КНОПКА: этот предложенный следующий запрос от лица пользователя, 3–8 слов (например «Собери плейлист из треков Tame Impala»).\n' +
      'Обращайся так же, как пользователь: на «ты», если он пишет на «ты», иначе на «вы».' +
      (clean(context) ? '\n\nДанные о пользователе (для предложения):\n' + clean(context).slice(0, 1200) : '');
    const r = await callModel(
      [{ role: 'system', content: sys }, { role: 'user', content: clean(prompt).slice(0, 600) }],
      { maxTokens: 3000, temperature: 0.6, timeoutMs: 38000, json: false, lowReasoning: true, envNames: ['PLAYLIST_MODEL', 'INTENT_MODEL'] }
    );
    const parsed = parsePlaylistText(r.text);
    const seen = new Set();
    const tracks = parsed.tracks
      .map((t) => ({ artist: clean(t.artist).slice(0, 80), title: clean(t.title).slice(0, 120) }))
      .filter((t) => t.artist && t.title)
      .filter((t) => { const k = (t.artist + '|' + t.title).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (tracks.length >= Math.min(want, 5)) {
      return {
        title: clean(parsed.title).replace(/["«»*]/g, '').slice(0, 60) || 'Плейлист от HarmonyAI',
        description: clean(parsed.description).replace(/\*/g, '').slice(0, 200),
        intro: clean(parsed.intro).replace(/\*/g, '').slice(0, 300),
        suggest: clean(parsed.suggest).replace(/\*/g, '').slice(0, 400),
        chip: clean(parsed.chip).replace(/["«»*]/g, '').slice(0, 80),
        want,
        tracks
      };
    }
    lastReason = r.reason || (r.text ? 'unparsed' : 'empty');
    console.warn('[ai-tasks] playlist attempt failed:', lastReason, 'tracks:', tracks.length);
    if (Date.now() - t0 > 30000) break; // на вторую попытку времени уже нет
  }
  return { title: '', description: '', want, tracks: [], reason: lastReason };
}

/* ============================================================================
   АГЕНТ: что сделать по сообщению пользователя.
   ИИ сам решает по смыслу (без кодовых слов), нужно ли приложению выполнить
   действие: загрузить трек в Яндекс Музыку, разобрать или узнать трек,
   записать его ноты, показать лимиты, подключить Яндекс Музыку — или это
   обычный разговор. Возвращает действие и короткую живую фразу, с которой
   ассистент начинает (её видно над переливающимся статусом).
   ========================================================================== */
/* Разнообразие коротких реплик: одинаковый сценарий не должен звучать одной
   фразой. Модели с низкой температурой отвечают почти дословно одинаково,
   поэтому в каждый запрос подмешиваем случайную подсказку стиля и прошлые
   реплики ассистента, которые нельзя повторять. */
const REPLY_STYLES = [
  'Начни с глагола действия.', 'Начни с короткой живой реакции («Отличный выбор», «Понял», «Принято» — каждый раз другой).',
  'Начни с названия того, о чём просят.', 'Начни с обращения по имени, если оно есть.', 'Сделай фразу совсем короткой — 5–8 слов.',
  'Добавь лёгкую дружелюбную деталь в конце.', 'Начни со слова «Так»,«Окей» или «Ага» — выбери одно.', 'Начни с того, что будет дальше.'
];
export function replyVarietyRule(turns = '') {
  const style = REPLY_STYLES[Math.floor(Math.random() * REPLY_STYLES.length)];
  return `reply каждый раз формулируй по-новому: меняй первое слово, глагол и порядок слов. ${style} ` +
    'Не повторяй дословно и по шаблону реплики ассистента из «Последних реплик» — особенно их начало.';
}
export const AGENT_ACTIONS = ['upload_track', 'analyze_track', 'identify_track', 'transcribe_track', 'find_track', 'add_to_playlist', 'ask_audio', 'limits', 'connect_yandex', 'chat'];

export async function decideAgentAction({ message = '', history = [], context = {} } = {}) {
  const text = clean(message).slice(0, 1200);
  const ctx = context && typeof context === 'object' ? context : {};
  const audioNow = Math.max(0, Number(ctx.audioAttached) || 0);
  const recent = Array.isArray(ctx.recentAudio) ? ctx.recentAudio.slice(0, 3).map(n => clean(n).slice(0, 80)) : [];
  const name = clean(ctx.nickname || '').slice(0, 40);
  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .map(t => `${t.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${clean(t.text).slice(0, 300)}`).join('\n');

  const system = [
    'Ты — «мозг» приложения HarmonyAI. По сообщению пользователя реши, нужно ли приложению ВЫПОЛНИТЬ действие.',
    'Понимай смысл, а не слова: «закинь в я муз», «сохрани трек в яндекс» про СВОЙ аудиофайл пользователя — это загрузка;',
    '«что за песня», «кто это поёт», «как называется» про ПРИСЛАННЫЙ аудиофайл — узнать трек; «разбери», «какая тональность», «темп» — разбор;',
    '«запиши ноты», «сделай партитуру мелодии» — ноты; «сколько у меня осталось», «когда обновятся лимиты» — лимиты.',
    'Действия:',
    'upload_track — загрузить аудиофайл пользователя в его Яндекс Музыку (плейлист HarmonyAI). Нужен прикреплённый или недавний трек.',
    'analyze_track — разобрать трек: темп, тональность, лад, динамика, структура, характер.',
    'identify_track — узнать по АУДИОФАЙЛУ, что за трек (название, исполнитель). Только когда название НЕИЗВЕСТНО и речь о присланном/недавнем аудио.',
    'find_track — найти и дать послушать трек, название или исполнитель которого ИЗВЕСТНЫ: названы в сообщении или в последних репликах',
    '  («найди этот трек» сразу после ответа «играет Starboy — The Weeknd»; «найди Believer»; «где послушать эту песню»). Файл для этого НЕ нужен.',
    'transcribe_track — расшифровать мелодию трека в ноты.',
    'add_to_playlist — добавить трек ИЗ КАТАЛОГА (Яндекс Музыка, Audius, Jamendo) в плейлист пользователя в HarmonyAI: «добавь Believer в плейлист',
    '  Тренировка», «закинь этот трек в мой плейлист», «сохрани то, что играет, в Любимое». Трек — названный в сообщении, только что найденный',
    '  ассистентом или тот, что играет сейчас. Это НЕ загрузка файла: upload_track — только для аудиофайла, который прислал сам пользователь.',
    'ask_audio — пользователь прислал трек БЕЗ понятной просьбы: спросить, что с ним сделать.',
    'limits — рассказать, сколько осталось лимитов сообщений и когда сброс.',
    'connect_yandex — подключить аккаунт Яндекс Музыки.',
    'chat — обычный ответ: вопрос, беседа, файл/документ, картинка, просьба включить музыку и всё остальное.',
    'Если просят найти/включить/послушать трек и его название известно из сообщения или истории — это find_track, а НЕ identify_track.',
    '«Этот трек», «эту песню», «его», «её» — ищи название в последних репликах (часто его только что назвал ассистент).',
    'Ссылка на видео YouTube/TikTok с вопросом «что за трек тут играет» — chat (ролик смотрит другой модуль).',
    'Если действие про разбор/ноты/загрузку трека, а аудио нет ни сейчас, ни недавно — всё равно выбери это действие (приложение попросит прислать файл).',
    'query — для find_track и add_to_playlist: чистый поисковый запрос «Исполнитель Название» (+ версия, если просили: slowed, remix, live), без глаголов и кавычек;',
    '  для add_to_playlist пусто, если речь о треке, который играет сейчас. Для остальных действий — пустая строка.',
    'playlist — только для add_to_playlist: название плейлиста, как его назвал пользователь (без слова «плейлист»); не назвал — пустая строка.',
    'Загрузку понимай по смыслу, а не по слову «загрузи»: «сохрани себе», «кинь в мою медиатеку», «хочу его у себя в Яндексе», «добавь в мою музыку» — это upload_track.',
    'Короткое согласие («да», «давай», «ага», «ок», «да, загрузи») на предложение ассистента загрузить трек в последних репликах — тоже upload_track.',
    'Согласие на другое предложение ассистента (разобрать, записать ноты, узнать трек) — соответствующее действие.',
    'reply — 1–2 коротких живых предложения от лица ассистента (мужской род), на «ты», можно по имени, без канцелярита.',
    'Для upload_track пример: «Без проблем! Сейчас подключу плагин Яндекс Музыки и загружу твой трек в плейлист HarmonyAI.»',
    'Для ask_audio — тёплый вопрос, что сделать с треком. Для chat reply — пустая строка.',
    'Если аудио прикреплено сейчас — действие относится к НЕМУ, а не к недавним трекам. В reply не называй трек по названию.',
    replyVarietyRule(),
    'Отвечай ТОЛЬКО JSON: {"action":"…","reply":"…","query":"…","playlist":"…"}'
  ].join('\n');
  const user = [
    `Сообщение: ${text || '(пустое — только вложение)'}`,
    `Прикреплено аудио сейчас: ${audioNow}${Array.isArray(ctx.attachedAudio) && ctx.attachedAudio.length ? ' (' + ctx.attachedAudio.slice(0, 3).map(n => clean(n).slice(0, 80)).join('; ') + ')' : ''}`,
    recent.length ? `Недавние треки в этом чате: ${recent.join('; ')}` : 'Недавних треков нет',
    `Яндекс Музыка подключена: ${ctx.yandexConnected ? 'да' : 'нет'}`,
    ctx.nowPlaying ? `Сейчас играет: ${clean(ctx.nowPlaying).slice(0, 120)}` : '',
    Array.isArray(ctx.playlists) && ctx.playlists.length ? `Плейлисты пользователя: ${ctx.playlists.slice(0, 20).map((x) => clean(x).slice(0, 40)).join('; ')}` : '',
    name ? `Имя пользователя: ${name}` : '',
    turns ? `Последние реплики:\n${turns}` : ''
  ].filter(Boolean).join('\n');

  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 220, temperature: 0.7, timeoutMs: 12000, envNames: ['AGENT_MODEL'], lowReasoning: true });
  let action = AGENT_ACTIONS.includes(parsed?.action) ? parsed.action : '';
  if (!action) return null;
  const query = clean(parsed?.query || '').replace(/^[«"'\s]+|[»"'\s.!,]+$/g, '').slice(0, 160);
  // Подстраховка: «узнать трек» без аудио, но с известным названием — это поиск.
  if (action === 'identify_track' && !audioNow && !recent.length && query.length >= 2) action = 'find_track';
  if (action === 'find_track' && query.length < 2) action = audioNow || recent.length ? 'identify_track' : 'chat';
  // «Добавь в плейлист» без названия трека и без играющего — непонятно, что добавлять.
  if (action === 'add_to_playlist' && query.length < 2 && !ctx.nowPlaying) action = 'chat';
  return {
    action, reply: clean(parsed?.reply || '').slice(0, 400),
    query: action === 'find_track' || action === 'add_to_playlist' ? query : '',
    playlist: action === 'add_to_playlist' ? clean(parsed?.playlist || '').replace(/^плейлист\s+/i, '').replace(/^[«"']+|[»"']+$/g, '').slice(0, 60) : ''
  };
}

/* ---------------------------------------------------------------- кинотеатр */

/* Что хочет посмотреть пользователь: фильм, сериал, конкретную серию, озвучку
   или просто ролик. Модель понимает живую речь («закинь третью серию второго
   сезона Мандалорца в озвучке LostFilm», «есть Интерстеллар в оригинале?»)
   и отдаёт чистое название — его потом ищет lib/video.js.
   is_video=false при сомнениях: вопрос О фильме («кто снял Матрицу») — это
   обычный чат, а не поиск видео. */
export async function decideVideoIntent({ message = '', history = [] } = {}) {
  const text = clean(message).slice(0, 800);
  if (!text) return null;
  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .map(t => `${t.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${clean(t.text || t.content || '').slice(0, 240)}`).join('\n');
  const system = [
    'Ты разбираешь просьбы к онлайн-кинотеатру приложения HarmonyAI. Реши, хочет ли пользователь ПОСМОТРЕТЬ или НАЙТИ видео:',
    'фильм, мультфильм, сериал, конкретную серию, аниме, трейлер, клип или любой ролик.',
    'is_video=true только если просят включить/найти/показать/посмотреть видео. Вопросы о фильме («кто снял», «о чём», «стоит ли смотреть»)',
    'без просьбы показать — is_video=false. Просьба включить песню/трек (послушать музыку) — is_video=false, это музыкальный плеер.',
    'Учитывай историю: «а следующую серию», «давай в оригинале», «другую озвучку» — продолжение прошлого видео.',
    'Поля:',
    'kind: movie | series | episode | cartoon | anime | trailer | video. episode — если назван номер серии.',
    'title — официальное русское название (как в кинотеатрах), без года, сезона, серии и озвучки. title_en — оригинальное название, если знаешь.',
    'year — год выхода, если назван или однозначен (иначе 0). season, episode — числа (0, если не названы; «следующая серия» = прошлая + 1).',
    'voice — озвучка, если попросили: «Дубляж», «LostFilm», «HDRezka», «Кубик в Кубе», «AlexFilm», «Гоблин», «Многоголосый», «Оригинал» (английская/оригинальная дорожка), «Субтитры». Иначе пустая строка.',
    'franchise — серия фильмов/вселенная, если фильм в неё входит («Гарри Поттер», «Мстители», «Шрек»), иначе пусто.',
    'query — для kind=video: короткий поисковый запрос по смыслу (например «лучшие голы Месси 2022»); для остальных — пусто.',
    'Для kind=video с зарубежным автором (MrBeast, PewDiePie и т.п.) в title_en дай запрос на языке оригинала, как видео названо у автора (например «MrBeast Eat Everything In This Store»).',
    'want_answer — пользователь КРОМЕ видео задал вопрос (например «и расскажи, о чём он»); answer_request — этот вопрос.',
    'reply — одна короткая живая фраза от ассистента (мужской род, на «ты»), например «Включаю „Интерстеллар“ в дубляже.» или «Нашёл ролик MrBeast про магазин — смотри.».',
    replyVarietyRule(),
    'Отвечай ТОЛЬКО JSON: {"is_video":bool,"kind":"","title":"","title_en":"","franchise":"","year":0,"season":0,"episode":0,"voice":"","query":"","want_answer":false,"answer_request":"","reply":""}'
  ].join('\n');
  const user = [`Сообщение: ${text}`, turns ? `Последние реплики:\n${turns}` : ''].filter(Boolean).join('\n');
  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 260, temperature: 0.1, timeoutMs: 12000, envNames: ['VIDEO_INTENT_MODEL', 'AGENT_MODEL'], lowReasoning: true });
  if (!parsed || typeof parsed.is_video !== 'boolean') return null;
  return {
    is_video: parsed.is_video,
    kind: String(parsed.kind || ''),
    title: clean(parsed.title || '').slice(0, 120),
    title_en: clean(parsed.title_en || '').slice(0, 120),
    franchise: clean(parsed.franchise || '').slice(0, 80),
    year: Number(parsed.year) || 0,
    season: Number(parsed.season) || 0,
    episode: Number(parsed.episode) || 0,
    voice: clean(parsed.voice || '').slice(0, 40),
    query: clean(parsed.query || '').slice(0, 160),
    want_answer: Boolean(parsed.want_answer),
    answer_request: clean(parsed.answer_request || '').slice(0, 300),
    reply: clean(parsed.reply || '').slice(0, 200)
  };
}

/* Поисковый запрос, как его набрал бы человек: не фраза пользователя целиком
   («Напиши мне реферат на тему ИИ в современном мире» давала мусорную выдачу),
   а 1–2 запроса из ключевых слов. Язык — по теме: про технологии, продукты,
   мировые события — по-английски (там больше и свежее), про Россию, людей и
   места на русском — по-русски. Если важна свежесть — месяц и год.
   → ['best free AI video generator November 2026', ...] или [] при сбое. */
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export async function planSearchQueries({ message = '', history = [], now = new Date() } = {}) {
  const text = clean(message).replace(/\[ФАЙЛ \d+:[\s\S]*$/, '').slice(0, 900);
  if (!text) return [];
  const turns = (Array.isArray(history) ? history : []).slice(-4)
    .map(t => `${t.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${clean(t.text || t.content || '').slice(0, 200)}`).join('\n');
  const today = `${MONTHS_EN[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const system = [
    'Ты составляешь запросы для поисковика (Google/Bing), чтобы ассистент ответил на сообщение пользователя актуальными фактами.',
    `Сегодня ${today}.`,
    'Правила:',
    '— Пиши ключевые слова, как опытный человек в строке поиска: без «найди», «напиши мне», «пожалуйста», вопросительных слов и местоимений.',
    '— Язык по теме: технологии, ИИ, софт, гаджеты, игры, наука, мировые новости, зарубежные люди и компании — по-английски; Россия, СНГ, русскоязычные люди, местные цены, законы, расписания — по-русски.',
    `— Если важна свежесть («лучший», «сейчас», цены, версии, рейтинги, новости, статистика) — добавь месяц и год (${today}) или год.`,
    '— Если просят написать текст (реферат, эссе, доклад) — ищи факты, статистику и свежие события по теме, а не «как написать реферат».',
    '— Учитывай прошлые реплики: «а у него?», «а сколько стоит?» — подставь, о ком/чём речь.',
    '— 1 запрос; второй — только если тема явно двусторонняя или нужен запрос на другом языке. Каждый до 10 слов.',
    'Ответ — ТОЛЬКО JSON: {"queries":["..."]}'
  ].join('\n');
  const user = [turns ? `Прошлые реплики:\n${turns}` : '', `Сообщение: ${text}`].filter(Boolean).join('\n\n');
  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    // Основная служебная модель бывает недоступна (pro-ai «fetch failed») — ждём её недолго и сразу берём запасную.
    { maxTokens: 120, temperature: 0.1, timeoutMs: 2500, fallbackOnTimeout: true, fallbackTimeoutMs: 3500, envNames: ['SEARCH_PLAN_MODEL', 'AGENT_MODEL'], lowReasoning: true });
  const list = Array.isArray(parsed?.queries) ? parsed.queries : [];
  return list.map(q => clean(q).replace(/["«»]/g, '').slice(0, 140)).filter(q => q.length >= 3).slice(0, 2);
}

/* Описание для видеомодели: просьба пользователя → подробный английский
   промпт (модели понимают английский лучше), формат кадра и проверка.
   allowed=false — откровенное, насилие с кровью, реальные люди в
   компрометирующих сценах, дети в любом сомнительном контексте.
   → {allowed, prompt, aspect:'16:9'|'9:16', reason} или null при сбое. */
export async function prepareVideoPrompt(text = '') {
  const msg = clean(text).slice(0, 1200);
  if (!msg) return null;
  const system = [
    'Ты готовишь описание для нейросети, которая делает 5-секундные видеоролики.',
    'Перепиши просьбу пользователя в один подробный английский промпт (до 70 слов): кто/что в кадре, действие, окружение, свет, движение камеры, стиль.',
    'Не выдумывай сюжет сверх просьбы. Убери служебные слова («сгенерируй видео», «сделай ролик»).',
    'aspect: "9:16" — если просят вертикальное, для телефона, сторис, TikTok, Reels, Shorts; иначе "16:9".',
    'allowed=false только для: откровенного/сексуального, жестокости с кровью, реальных известных людей в унизительных или ложных сценах, детей в сомнительном контексте, инструкций к оружию. reason — коротко по-русски.',
    'Ответ — ТОЛЬКО JSON: {"allowed":true,"prompt":"...","aspect":"16:9","reason":""}'
  ].join('\n');
  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: msg }],
    { maxTokens: 260, temperature: 0.3, timeoutMs: 9000, envNames: ['VIDEO_PROMPT_MODEL', 'AGENT_MODEL'], lowReasoning: true });
  if (!parsed || typeof parsed.allowed !== 'boolean') return null;
  return {
    allowed: parsed.allowed,
    prompt: clean(parsed.prompt || '').slice(0, 900),
    aspect: parsed.aspect === '9:16' ? '9:16' : '16:9',
    reason: clean(parsed.reason || '').slice(0, 200)
  };
}

/* АВТОМАТИЧЕСКАЯ ПАМЯТЬ. По сообщению пользователя (и началу ответа для
   контекста) служебная модель решает, есть ли в нём устойчивый факт о самом
   пользователе, который пригодится в будущих разговорах. Уже сохранённые
   факты передаются с номерами: модель не дублирует их, а если пользователь
   просит забыть или факт изменился — возвращает номер старого в forget.
   → {save:[{text, scope:'user'|'chat'}], forget:[номер]} или null при сбое. */
export async function extractMemoryFacts({ message = '', reply = '', facts = [] } = {}) {
  const text = clean(message).replace(/\[ФАЙЛ \d+:[\s\S]*$/, '').slice(0, 1500);
  if (!text) return null;
  const known = (Array.isArray(facts) ? facts : []).slice(0, 40)
    .map((f, i) => `${i}. ${clean(f).slice(0, 160)}`).join('\n');
  const system = [
    'Ты ведёшь долговременную память ассистента HarmonyAI о пользователе.',
    'Сохраняй ТОЛЬКО устойчивые факты о самом пользователе, полезные в будущих разговорах:',
    'имя, возраст, город, учёба (класс, курс, музыкальная школа, колледж), профессия, инструменты и уровень игры,',
    'любимые жанры и исполнители, цели (поступление, экзамен, конкурс), постоянные предпочтения к ответам',
    '(язык, длина, стиль, формат), важные обстоятельства. А также всё, что пользователь прямо просит запомнить.',
    'НЕ сохраняй: разовые задачи и вопросы («реши задачу», «найди трек»), содержание ответа ассистента,',
    'временное состояние («сегодня устал»), предположения, факты о других людях без связи с пользователем,',
    'пароли, ключи, токены, номера карт, адреса и телефоны.',
    'Формулируй каждый факт коротко, в третьем лице, по-русски: «Пользователя зовут Аня», «Учится в 7 классе музыкальной школы по классу фортепиано».',
    'Если факт уже есть в списке сохранённых — не повторяй его. Если пользователь просит забыть факт или факт изменился —',
    'укажи номер старого в forget (и при изменении добавь новый в save).',
    'scope "chat" — только если пользователь прямо сказал «запомни в этом чате»; иначе "user".',
    'Чаще всего сохранять нечего — тогда верни пустые списки.',
    'Ответ — ТОЛЬКО JSON: {"save":[{"text":"...","scope":"user"}],"forget":[]}'
  ].join('\n');
  const user = [
    known ? `Уже сохранено:\n${known}` : 'Уже сохранено: ничего.',
    `Сообщение пользователя: ${text}`,
    reply ? `Начало ответа ассистента (только для контекста): ${clean(reply).slice(0, 400)}` : ''
  ].filter(Boolean).join('\n\n');
  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 300, temperature: 0.1, timeoutMs: 12000, fallbackOnTimeout: true, fallbackTimeoutMs: 12000, envNames: ['MEMORY_MODEL', 'AGENT_MODEL'], lowReasoning: true });
  if (!parsed || typeof parsed !== 'object') return null;
  const save = (Array.isArray(parsed.save) ? parsed.save : [])
    .map((x) => (typeof x === 'string' ? { text: x } : x || {}))
    .map((x) => ({ text: clean(x.text || '').slice(0, 300), scope: x.scope === 'chat' ? 'chat' : 'user' }))
    .filter((x) => x.text.length >= 8)
    .slice(0, 4);
  const max = (Array.isArray(facts) ? facts.length : 0);
  const forget = (Array.isArray(parsed.forget) ? parsed.forget : [])
    .map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n >= 0 && n < max).slice(0, 5);
  return { save, forget };
}

/* ЖИВЫЕ СТАТУСЫ. Пока основная модель готовит ответ, приложение показывает
   переливающиеся строки «что я сейчас делаю». Их придумывает служебная модель
   под конкретный запрос: «Сверяю аккорды…», «Собираю презентацию…»,
   «Перечитываю вашу память…» — вместо одного и того же «Думаю».
   → ['…','…','…'] или [] (тогда остаются обычные подписи). */
export async function planStatusPhrases({ message = '', context = {} } = {}) {
  const text = clean(message).replace(/\[ФАЙЛ \d+:[\s\S]*$/, '').slice(0, 600);
  if (!text) return [];
  const c = context && typeof context === 'object' ? context : {};
  const what = [
    c.search ? 'будет поиск в интернете' : '',
    c.think ? 'включено глубокое размышление' : '',
    c.image ? 'пользователь прислал фото' : '',
    c.file ? 'пользователь прислал файл/документ' : '',
    c.memory ? 'ассистент смотрит память о пользователе' : '',
    c.fileOut ? 'нужно создать файл' : ''
  ].filter(Boolean).join('; ');
  const system = [
    'Придумай 4 коротких статуса — что ассистент HarmonyAI делает прямо сейчас, готовя ответ ИМЕННО на это сообщение.',
    'Каждый статус: 2–4 слова, глагол в 1-м лице настоящего времени, конкретно по теме запроса, в конце «…».',
    'Порядок — как идёт работа: понять → найти/посчитать → собрать → проверить.',
    'Примеры: «Вспоминаю теорию ладов…», «Сверяю аккорды по кругу…», «Собираю слайды…», «Подбираю рифмы…», «Перечитываю вашу память…», «Проверяю расчёты…».',
    'Без кавычек, эмодзи, имён моделей и обещаний. Язык — как у пользователя.',
    'Ответ — ТОЛЬКО JSON: {"phrases":["…","…","…","…"]}'
  ].join('\n');
  const user = `Сообщение: ${text}${what ? `\nКонтекст: ${what}` : ''}`;
  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 120, temperature: 0.9, timeoutMs: 3500, envNames: ['STATUS_MODEL', 'AGENT_MODEL'], lowReasoning: true });
  const list = Array.isArray(parsed?.phrases) ? parsed.phrases : [];
  return list.map((p) => clean(p).replace(/["«»]/g, '').replace(/\.{3}$/, '…').slice(0, 48))
    .filter((p) => p.length >= 4 && p.split(/\s+/).length <= 6)
    .map((p) => (/[…!?]$/.test(p) ? p : p + '…'))
    .slice(0, 4);
}
