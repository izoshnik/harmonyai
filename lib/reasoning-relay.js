/* ============================================================================
   НАСТОЯЩИЕ РАССУЖДЕНИЯ МОДЕЛИ → ПОЛЬЗОВАТЕЛЮ, НА ЯЗЫКЕ ВОПРОСА
   ----------------------------------------------------------------------------
   Модели присылают ход мыслей отдельным полем (delta.reasoning / reasoning_content).
   Раньше сервер его прятал и показывал только короткую «сводку», которую модель
   писала уже после размышлений: 15 секунд пользователь видел пустое «Думаю».

   Теперь мысли идут в блок «Думаю» по мере появления — как у Claude и ChatGPT.
   Модель просим думать на языке пользователя; если она всё равно думает
   по-английски, а вопрос на русском, мысли переводятся кусками (по абзацам)
   быстрой бесплатной моделью. Переводы идут параллельно, а клиенту уходят строго
   по порядку. Ответ перевода не ждёт: недоперевёденный хвост дописывается в
   свёрнутый блок, пока печатается ответ. Перевод не удался — показываем оригинал.
   ============================================================================ */
import { providerForModel } from './models.js';

function readEnv(name) { return String(process.env[name] || '').trim(); }

const TRANSLATE_DEFAULT = ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'];
function translateModels() {
  const v = readEnv('REASONING_TRANSLATE_MODEL').split(',').map((x) => x.trim()).filter(Boolean);
  return v.length ? v : TRANSLATE_DEFAULT;
}

const CYR = /[А-Яа-яЁё]/g;
const LAT = /[A-Za-z]/g;
const count = (s, re) => (String(s || '').match(re) || []).length;

/* Язык вопроса: 'ru', если в нём кириллица преобладает. */
export function queryLanguage(query) {
  const c = count(query, CYR), l = count(query, LAT);
  return c >= 3 && c >= l ? 'ru' : 'other';
}

/* Кусок рассуждений «не на русском»: латиницы заметно больше кириллицы. */
export function looksForeign(text) {
  const c = count(text, CYR), l = count(text, LAT);
  return l >= 40 && l > c * 2;
}

const TRANSLATE_SYSTEM = [
  'Переведи на русский язык фрагмент внутренних рассуждений ассистента.',
  'Пиши живым русским языком от первого лица («Пользователь спрашивает…», «Проверю…», «Значит…»).',
  'Сохраняй смысл, порядок мыслей, абзацы и заголовки вида **Заголовок** (их тоже переводи).',
  'Ноты, аккорды, обозначения (T53, D7, ув4), формулы, код, числа, названия и имена не меняй.',
  'Ничего не добавляй и не сокращай, без пояснений. Верни только перевод.'
].join('\n');

let translatorDownUntil = 0;

async function translateChunk(text, timeoutMs = 12000) {
  if (Date.now() < translatorDownUntil) return '';
  for (const model of translateModels()) {
    const p = providerForModel(model);
    if (!p.apiKey || !p.baseUrl) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body = { model, messages: [{ role: 'system', content: TRANSLATE_SYSTEM }, { role: 'user', content: text }], temperature: 0.2, max_tokens: Math.min(4000, Math.ceil(text.length / 2) + 200) };
      if (p.openrouter) body.reasoning = { enabled: false };
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`, ...(p.headers || {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (r.status === 429) { translatorDownUntil = Date.now() + 60_000; continue; }
      if (!r.ok) continue;
      const data = await r.json().catch(() => ({}));
      const out = String(data?.choices?.[0]?.message?.content || '').trim();
      // Перевод должен быть русским и не короче половины оригинала.
      if (out && count(out, CYR) > count(out, LAT) && out.length > text.length * 0.45) return out;
    } catch (e) { /* следующая модель */ } finally { clearTimeout(timer); }
  }
  return '';
}

/* Ретранслятор: push(текст мыслей) по мере прихода, flush(ms) — дождаться
   отправки (не дольше ms). emit(text) отправляет клиенту событие reasoning.
   maxTranslateChars — сколько мыслей переводить; дальше одна пометка, без
   англоязычного текста. translator — подмена перевода в тестах. */
export function createReasoningRelay({ emit, query, translate = true, maxTranslateChars = 14000, translator = translateChunk }) {
  const wantRu = translate && queryLanguage(query) === 'ru';
  let decided = !wantRu;     // для не-русских вопросов показываем как есть
  let translateMode = false;
  let sample = '';
  let buf = '';
  let chain = Promise.resolve();
  let lastCut = Date.now();
  let emitted = 0;
  let sentChars = 0;
  let capped = false;

  const out = (t) => { if (t) { emitted += t.length; emit(t); } };

  function enqueue(chunk) {
    if (!chunk) return;
    lastCut = Date.now();
    if (sentChars >= maxTranslateChars) {
      if (!capped) { capped = true; chain = chain.then(() => out('\n\n_…дальше модель продолжала размышлять в том же направлении._\n\n')); }
      return;
    }
    sentChars += chunk.length;
    const tail = /\n\s*$/.test(chunk) ? '\n\n' : ' ';
    // Перевод стартует сразу, а отправка — по очереди: порядок мыслей не путается.
    const p = translator(chunk.trim()).catch(() => '');
    chain = chain.then(() => p).then((ru) => out((ru || chunk.trim()) + tail));
  }

  /* Режем буфер по абзацу или предложению: перевод связный, а вызовов немного. */
  function cut(force) {
    if (!buf) return;
    const quiet = Date.now() - lastCut > 2500;
    if (!force && buf.length < 450 && !(quiet && buf.length > 120)) return;
    let at = buf.lastIndexOf('\n\n');
    if (at < 150) { const m = [...buf.matchAll(/[.!?](\s)/g)].pop(); at = m ? m.index + 1 : -1; }
    if (force || at < 100) at = buf.length;
    const chunk = buf.slice(0, at);
    buf = buf.slice(at).replace(/^[ \t]+/, '');
    enqueue(chunk + (/\n\s*$/.test(chunk) || /^\n/.test(buf) ? '\n' : ''));
  }

  return {
    get emitted() { return emitted; },
    get translating() { return translateMode; },
    push(text) {
      if (!text) return;
      if (!decided) {
        sample += text;
        if (sample.length < 220 && !/\n\n/.test(sample)) return;
        decided = true;
        translateMode = looksForeign(sample);
        text = sample;
        sample = '';
      }
      if (!translateMode) { out(text); return; }
      buf += text;
      cut(false);
    },
    /* Отдать всё накопленное и дождаться отправки (не дольше maxWaitMs). */
    async flush(maxWaitMs = 9000) {
      if (!decided && sample) { decided = true; translateMode = looksForeign(sample); if (translateMode) buf += sample; else out(sample); sample = ''; }
      if (translateMode) cut(true);
      await Promise.race([chain, new Promise((r) => setTimeout(r, Math.max(0, maxWaitMs)))]);
    }
  };
}

/* Модели, которые думают по-настоящему (отдают поток рассуждений). Для них в
   режиме «Думать» показываем настоящие мысли, а не просим «сводку». */
export function isNativeReasoner(model) {
  const m = String(model || '');
  if (/^claude/i.test(m)) return false;
  return true;
}
