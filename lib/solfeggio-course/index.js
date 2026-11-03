/* ============================================================================
   КУРС HARMONYAI ПО СОЛЬФЕДЖИО — собственный «учебник» ИИ.

   ~40 глав по программе ДМШ 1–9 класс (+ подготовка к колледжу) и справочные
   таблицы. Главы — продолжение коротких карточек lib/solfeggio-knowledge.js:
   алгоритмы построения, разборы в разных тональностях, типичные ошибки,
   образцы ответов на экзамене, методика диктанта и пения.
   Все ноты в примерах и таблицах считает музыкальное ядро (lib/music-theory.js)
   при загрузке модуля — вручную набранных нот в курсе нет.

   К вопросу подбираются 1–2 главы (по ключевым словам и классу) — до ~6000
   символов; к длинному билету — до трёх. Базы данных курс не требует: он
   живёт в коде и обновляется вместе с приложением.
   ========================================================================== */
import g13 from './grades-1-3.js';
import g45 from './grades-4-5.js';
import g69 from './grades-6-9.js';
import practice from './practice.js';
import tables from './tables.js';

/* Обобщённые главы (экзамен, ошибки, «как подготовиться») — только рядом с
   музыкальными словами: иначе «ошибка в коде» притянула бы сольфеджио. */
const WEAK = new Set(['p-exams', 'p-mistakes', 'p-home', 'p-ticket', 'g7-form', 'g1-rhythm', 'g1-meter']);
const MUSIC = /сольфеджио|музык|(?:^|[^а-яё])нот|аккорд|интервал|тональн|(?:^|[^а-яё])лад(?:а|у|ом|ы|ов)?(?![а-яё])|гамм|ритм|диктант|дмш|дши|музыкалк|гармони|мажор|минор|трезвучи|септаккорд|тритон|ступен|квинт|терци|секст|септим|синкоп|размер\s+\d|\d\/(?:2|4|8)/;

export const COURSE = [...g13, ...g45, ...g69, ...practice, ...tables];

const GRADE_WORD = { перв: 1, втор: 2, трет: 3, четв: 4, пят: 5, шест: 6, седьм: 7, восьм: 8, девят: 9 };
function gradeOf(low) {
  const m = low.match(/(?:^|[^\d])([1-9])\s*(?:-?(?:й|ой|ом|ый|ом))?\s*класс/);
  if (m) return Number(m[1]);
  const w = low.match(/(перв|втор|трет|четв|пят|шест|седьм|восьм|девят)[а-яё]*\s+класс/);
  return w ? GRADE_WORD[w[1]] : null;
}

export function pickChapters(query, { maxChars = 6000, maxChapters = 2 } = {}) {
  const low = String(query || '').toLowerCase().replace(/ё/g, 'е').slice(0, 5000);
  if (!low.trim()) return [];
  if (low.length > 500) { maxChars = Math.max(maxChars, 9000); maxChapters = Math.max(maxChapters, 3); }
  const musical = MUSIC.test(low);
  const grade = gradeOf(low);
  const scored = [];
  for (const c of COURSE) {
    const flags = c.re.flags.includes('g') ? c.re.flags : c.re.flags + 'g';
    const hits = c.table ? (c.re.test(low) ? 1 : 0) : (low.match(new RegExp(c.re.source, flags)) || []).length;
    if (!hits) continue;
    if (WEAK.has(c.id) && !musical) continue;
    let score = Math.min(hits, 3) * 10 + (c.table ? 5 : 0);
    if (grade && c.grades.includes(grade)) score += 4;
    if (WEAK.has(c.id)) score -= 4;   // общие главы уступают тематическим
    scored.push({ c, score, at: low.search(c.re) });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  const out = [];
  let size = 0;
  for (const { c } of scored) {
    if (out.length >= maxChapters) break;
    if (size + c.text.length > maxChars) continue;
    out.push(c);
    size += c.text.length;
  }
  return out;
}

const gradesLabel = (g) => (g.length > 1 ? `${g[0]}–${g[g.length - 1]} класс` : `${g[0]} класс`);

/* Блок для системного контекста модели ('' — если в курсе нет подходящей главы). */
export function buildCourseContext(query, opts = {}) {
  const list = pickChapters(query, opts);
  if (!list.length) return '';
  return [
    'КУРС HARMONYAI ПО СОЛЬФЕДЖИО (главы учебника; ноты в примерах проверены музыкальным ядром). Объясняй по этим правилам своими словами, по шагам, на уровне ученика; если в учебнике ученика правило сформулировано иначе — скажи об этом.',
    ...list.map((c) => `Глава «${c.title}» (${gradesLabel(c.grades)}):\n${c.text}`)
  ].join('\n\n');
}
