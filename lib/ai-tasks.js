/* ============================================================================
   СЛУЖЕБНЫЕ ЗАДАЧИ МОДЕЛИ, у которых нет своей функции на Vercel
   (лимит Hobby — 12 функций), поэтому они живут здесь и подключаются из
   существующих api/util.js и api/music.js:

     • summarizeUserProfile — краткая сводка «о пользователе» для Персонализации;
     • planPlaylist        — идеи треков для плейлиста по описанию.

   Обе — один нестриминговый вызов служебной модели с JSON-ответом и
   fail-closed по смыслу: при сбое возвращаем пустой результат, а не выдумку.
   ============================================================================ */
import { utilityEndpoint, utilityModel, fastReasoningEffort, noteUnaskedReasoning, responseHasReasoning } from './models.js';

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

async function callJson(messages, { maxTokens = 600, temperature = 0.3, timeoutMs = 25000, envNames = [] } = {}) {
  const { apiKey, baseUrl } = utilityEndpoint();
  if (!apiKey || !baseUrl) return null;
  const model = utilityModel(envNames);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...(fastReasoningEffort(model) ? { reasoning_effort: 'low' } : {})
      })
    });
    if (!response.ok) { console.warn('[ai-tasks] model HTTP', response.status); return null; }
    const data = await response.json().catch(() => ({}));
    if (responseHasReasoning(data)) noteUnaskedReasoning(model);
    const parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    if (!parsed) console.warn('[ai-tasks] model returned no JSON');
    return parsed;
  } catch (e) {
    console.warn('[ai-tasks] model call failed:', String(e?.message || e).slice(0, 200));
    return null;
  } finally {
    clearTimeout(timer);
  }
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

export async function planPlaylist(prompt, count) {
  const want = Math.max(PLAYLIST_MIN, Math.min(PLAYLIST_MAX, Number(count) || 15));
  // Просим с запасом: часть треков в каталоге не найдётся или окажется дублем.
  const ask = Math.min(PLAYLIST_MAX + 10, want + Math.max(5, Math.ceil(want * 0.4)));
  const sys =
    'Ты музыкальный редактор. По просьбе пользователя составь плейлист из РЕАЛЬНО существующих треков, ' +
    'которые есть в Яндекс Музыке. Верни строго JSON: ' +
    '{"title":"короткое название плейлиста (2–5 слов)","description":"одно предложение о настроении",' +
    '"tracks":[{"artist":"Исполнитель","title":"Название трека"}]}. ' +
    `В tracks ровно ${ask} позиций, без повторов, не больше 2 треков одного исполнителя, ` +
    'выстрой порядок как в хорошем плейлисте (плавное нарастание, без резких скачков). ' +
    'Пиши оригинальные названия (латиницей, если они латиницей), без годов, без «feat.» и без пояснений.';
  const out = await callJson(
    [{ role: 'system', content: sys }, { role: 'user', content: clean(prompt).slice(0, 600) }],
    { maxTokens: 1800, temperature: 0.7, timeoutMs: 35000, envNames: ['PLAYLIST_MODEL', 'INTENT_MODEL'] }
  );
  if (!out || !Array.isArray(out.tracks)) return null;
  const seen = new Set();
  const tracks = out.tracks
    .map((t) => ({ artist: clean(t?.artist).slice(0, 80), title: clean(t?.title).slice(0, 120) }))
    .filter((t) => t.artist && t.title)
    .filter((t) => {
      const k = (t.artist + '|' + t.title).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    title: clean(out.title).replace(/["«»]/g, '').slice(0, 60) || 'Плейлист от HarmonyAI',
    description: clean(out.description).slice(0, 200),
    want,
    tracks
  };
}
