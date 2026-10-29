/* ============================================================================
   СЛУЖЕБНЫЕ ЗАДАЧИ МОДЕЛИ, у которых нет своей функции на Vercel
   (лимит Hobby — 12 функций), поэтому они живут здесь и подключаются из
   существующих api/util.js и api/music.js:

     • summarizeUserProfile — краткая сводка «о пользователе» для Персонализации;
     • planPlaylist        — идеи треков для плейлиста по описанию.

   Обе — один нестриминговый вызов служебной модели с JSON-ответом и
   fail-closed по смыслу: при сбое возвращаем пустой результат, а не выдумку.
   ============================================================================ */
import { utilityEndpoint, utilityModel, fastReasoningEffort, noteUnaskedReasoning, responseHasReasoning, supportsReasoningEffort } from './models.js';

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
   длинным ответом lowReasoning=true просит думать по минимуму сразу. */
async function callModel(messages, { maxTokens = 600, temperature = 0.3, timeoutMs = 25000, envNames = [], json = true, lowReasoning = false } = {}) {
  const { apiKey, baseUrl } = utilityEndpoint();
  if (!apiKey || !baseUrl) return { text: '', reason: 'no_key' };
  const model = utilityModel(envNames);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const effort = (lowReasoning && supportsReasoningEffort(model)) || fastReasoningEffort(model) ? 'low' : '';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ...(effort ? { reasoning_effort: effort } : {})
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn('[ai-tasks] model HTTP', response.status, body.slice(0, 200));
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
export const AGENT_ACTIONS = ['upload_track', 'analyze_track', 'identify_track', 'transcribe_track', 'ask_audio', 'limits', 'connect_yandex', 'chat'];

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
    'Понимай смысл, а не слова: «закинь в я муз», «добавь его ко мне в плейлист», «сохрани трек в яндекс» — это загрузка;',
    '«что за песня», «кто это поёт», «как называется» — узнать трек; «разбери», «какая тональность», «темп» — разбор;',
    '«запиши ноты», «сделай партитуру мелодии» — ноты; «сколько у меня осталось», «когда обновятся лимиты» — лимиты.',
    'Действия:',
    'upload_track — загрузить аудиофайл пользователя в его Яндекс Музыку (плейлист HarmonyAI). Нужен прикреплённый или недавний трек.',
    'analyze_track — разобрать трек: темп, тональность, лад, динамика, структура, характер.',
    'identify_track — узнать, что за трек (название, исполнитель).',
    'transcribe_track — расшифровать мелодию трека в ноты.',
    'ask_audio — пользователь прислал трек БЕЗ понятной просьбы: спросить, что с ним сделать.',
    'limits — рассказать, сколько осталось лимитов сообщений и когда сброс.',
    'connect_yandex — подключить аккаунт Яндекс Музыки.',
    'chat — обычный ответ: вопрос, беседа, файл/документ, картинка, просьба включить музыку и всё остальное.',
    'Если действие про трек, а трека нет ни сейчас, ни недавно — всё равно выбери это действие (приложение попросит прислать файл).',
    'reply — 1–2 коротких живых предложения от лица ассистента (мужской род), на «ты», можно по имени, без канцелярита.',
    'Для upload_track пример: «Без проблем! Сейчас подключу плагин Яндекс Музыки и загружу твой трек в плейлист HarmonyAI.»',
    'Для ask_audio — тёплый вопрос, что сделать с треком. Для chat reply — пустая строка.',
    'Отвечай ТОЛЬКО JSON: {"action":"…","reply":"…"}'
  ].join('\n');
  const user = [
    `Сообщение: ${text || '(пустое — только вложение)'}`,
    `Прикреплено аудио сейчас: ${audioNow}`,
    recent.length ? `Недавние треки в этом чате: ${recent.join('; ')}` : 'Недавних треков нет',
    `Яндекс Музыка подключена: ${ctx.yandexConnected ? 'да' : 'нет'}`,
    name ? `Имя пользователя: ${name}` : '',
    turns ? `Последние реплики:\n${turns}` : ''
  ].filter(Boolean).join('\n');

  const parsed = await callJson([{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 220, temperature: 0.4, timeoutMs: 12000, envNames: ['AGENT_MODEL'], lowReasoning: true });
  const action = AGENT_ACTIONS.includes(parsed?.action) ? parsed.action : '';
  if (!action) return null;
  return { action, reply: clean(parsed?.reply || '').slice(0, 400) };
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
    'reply — одна короткая живая фраза от ассистента (мужской род, на «ты»), например «Включаю „Интерстеллар“ в дубляже.».',
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
