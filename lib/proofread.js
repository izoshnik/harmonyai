/* ============================================================================
   ВЫЧИТКА РУССКОГО ТЕКСТА
   Бесплатные модели OpenRouter иногда теряют буквы и слипаются словами
   («быстрый,ный ритм», «по нтам»), вставляют английские слова посреди
   русской фразы («Это seems like куплеты») и ломают Markdown
   («**Структура.**По» — жирный не включается без пробела после звёздочек).
   Ответ пользователь видит потоком сразу, а перед финальным событием
   сервер прогоняет текст через быструю модель-корректор — исправленная
   версия тихо заменяет показанную.

   Корректору запрещено менять смысл, порядок, Markdown-разметку, код и ноты.
   Результат принимается, только если блоки ``` совпали байт в байт, а длина
   изменилась не больше чем на 12 %. Иначе остаётся исходный текст.
   ========================================================================== */
import { providerForModel } from './models.js';

const DEFAULT_PROOF_MODEL = 'google/gemma-4-31b-it:free';
const PROOF_TIMEOUT_MS = 9000;
const MAX_PROOF_CHARS = 9000;

function readEnv(name) { return String(process.env[name] || '').trim(); }

function fencedBlocks(text) {
  return String(text || '').match(/```[\s\S]*?```/g) || [];
}

/* Стоит ли вообще вычитывать: только русский текст разумной длины. */
export function needsProofread(text) {
  const t = String(text || '');
  if (t.length < 40 || t.length > MAX_PROOF_CHARS) return false;
  const prose = t.replace(/```[\s\S]*?```/g, ' ');
  const cyr = (prose.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (prose.match(/[A-Za-z]/g) || []).length;
  return cyr >= 30 && cyr > lat;
}

/* Безопасные правки без модели: жирный и курсив, к которым прилипла буква. */
export function fixMarkdownSpacing(text) {
  return String(text || '')
    // «**Структура.**По» → «**Структура.** По»
    .replace(/(\*\*[^*\n]{1,120}?[.,:;!?»)])\*\*(?=[A-Za-zА-Яа-яЁё0-9«(])/g, '$1** ');
}

export async function proofreadRussian(text, { model, timeoutMs = PROOF_TIMEOUT_MS } = {}) {
  const original = fixMarkdownSpacing(text);
  if (!needsProofread(original)) return original;
  const name = model || readEnv('ADAN_PROOF_MODEL') || DEFAULT_PROOF_MODEL;
  const provider = providerForModel(name);
  if (!provider.apiKey) return original;

  const system = [
    'Ты корректор русского текста. Тебе дают готовый ответ ассистента.',
    'Исправь ТОЛЬКО: опечатки и пропущенные буквы в словах, слипшиеся слова, лишние или пропущенные пробелы,',
    'случайные иероглифы и обрывки слов, английские слова посреди русской фразы (замени точным русским словом),',
    'грамматику и согласование. Термины, названия, имена, единицы (BPM, dBFS) и обозначения аккордов не трогай.',
    'НЕ меняй смысл, факты, числа, порядок абзацев, списки, заголовки и Markdown-разметку.',
    'Блоки в тройных обратных кавычках (код, ноты ABC, тесты) копируй символ в символ.',
    'Не добавляй ничего от себя, не сокращай, не объясняй правки. Верни только исправленный текст.'
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model: name,
      messages: [{ role: 'system', content: system }, { role: 'user', content: original }],
      temperature: 0,
      max_tokens: Math.min(8000, Math.ceil(original.length / 2) + 400),
      stream: false
    };
    if (provider.openrouter) body.reasoning = { enabled: false };
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
      body: JSON.stringify(body)
    });
    if (!res.ok) return original;
    const data = await res.json().catch(() => null);
    let fixed = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!fixed) return original;
    // Модель иногда заворачивает весь ответ в ```…``` — снимаем такую обёртку.
    const wrap = fixed.match(/^```(?:markdown|md|text)?\n([\s\S]*)\n```$/);
    if (wrap && !fencedBlocks(original).length) fixed = wrap[1].trim();
    fixed = fixMarkdownSpacing(fixed);
    const ratio = fixed.length / original.length;
    if (ratio < 0.88 || ratio > 1.12) return original;
    const a = fencedBlocks(original), b = fencedBlocks(fixed);
    if (a.length !== b.length || a.some((blk, i) => blk !== b[i])) return original;
    return fixed;
  } catch (e) {
    return original;
  } finally {
    clearTimeout(timer);
  }
}
