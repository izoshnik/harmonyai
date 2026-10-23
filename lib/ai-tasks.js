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
