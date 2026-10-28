/* ============================================================================
   РОУТЕР МУЗЫКАЛЬНОГО ЯДРА: вопрос ученика → точный расчёт → контекст модели.
   ----------------------------------------------------------------------------
   Работает ДО запроса к модели и без дополнительных вызовов LLM: регулярные
   выражения находят в вопросе тональность / ноту / интервал / аккорд, ядро
   (music-theory.js) считает, а результат (с ABC-нотацией) уходит в системный
   контекст как проверенные факты. Поэтому точность одинакова на всех моделях,
   включая бесплатные, а ответ не замедляется.

   Если вопрос музыкальный, но распознать задачу не удалось, модель получает
   только общее правило «строй по ступеням, затем по полутонам».
   ============================================================================ */
import * as M from './music-theory.js';
import * as P from './music-progressions.js';
import { buildSolfeggioContext } from './solfeggio-knowledge.js';

const NOTE_SRC = '(до|ре|ми|фа|соль|ля|си)(?:[\\s-]*(дубль[\\s-]*)?(диез|бемол)[а-яё]*)?';
const STEP_INDEX = { 'до': 0, 'ре': 1, 'ми': 2, 'фа': 3, 'соль': 4, 'ля': 5, 'си': 6 };

function noteFromMatch(base, dbl, acc) {
  const step = STEP_INDEX[String(base).toLowerCase()];
  let alter = 0;
  if (acc) alter = /^диез/i.test(acc) ? 1 : -1;
  if (dbl && alter) alter *= 2;
  return { step, alter, oct: 4 };
}

/* «си-бемоль» и «си бемоль», но не «до» как предлог: ноты ищем только в
   устойчивых конструкциях (от …, … мажор/минор, между … и …). */
const RE_KEY_RU = new RegExp(`(?:^|[^а-яё])${NOTE_SRC}[\\s-]*(мажор|минор)[а-яё]*`, 'gi');
const RE_KEY_DE = /(?:^|[^a-z])([a-h])(isis|eses|is|es|s)?-(dur|moll)\b/gi;
const RE_FROM_NOTE = new RegExp(`от\\s+(?:ноты\\s+|звука\\s+)?${NOTE_SRC}(?![а-яё])`, 'gi');
const RE_BETWEEN = new RegExp(`между\\s+${NOTE_SRC}\\s+и\\s+${NOTE_SRC}(?![а-яё])`, 'i');

const QUALITY_WORDS = [
  [/^чист/, 'ч'], [/^больш/, 'б'], [/^мал/, 'м'], [/^увелич/, 'ув'], [/^уменьш/, 'ум']
];
const NUM_WORDS = [
  [/^прим/, 1], [/^секунд/, 2], [/^терци/, 3], [/^кварт(?!д)/, 4], [/^квинт(?!д)/, 5], [/^секст/, 6],
  [/^септим/, 7], [/^октав/, 8], [/^нон/, 9], [/^децим/, 10]
];

function germanKey(letter, acc, mode) {
  const l = letter.toLowerCase();
  const step = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, h: 6, b: 6 }[l];
  let alter = 0;
  const a = (acc || '').toLowerCase();
  if (l === 'b') alter = -1;
  if (a === 'is') alter = 1; else if (a === 'isis') alter = 2;
  else if (a === 'es' || a === 's') alter = -1; else if (a === 'eses') alter = -2;
  return { tonic: { step, alter }, mode: mode.toLowerCase() === 'dur' ? 'major' : 'minor' };
}

function findKeys(text) {
  const keys = [];
  let m;
  RE_KEY_RU.lastIndex = 0;
  while ((m = RE_KEY_RU.exec(text))) {
    const n = noteFromMatch(m[1], m[2], m[3]);
    keys.push({ tonic: { step: n.step, alter: n.alter }, mode: /^мажор/i.test(m[4]) ? 'major' : 'minor' });
  }
  RE_KEY_DE.lastIndex = 0;
  while ((m = RE_KEY_DE.exec(text))) keys.push(germanKey(m[1], m[2], m[3]));
  return keys;
}

function findFromNotes(text) {
  const out = [];
  let m;
  RE_FROM_NOTE.lastIndex = 0;
  while ((m = RE_FROM_NOTE.exec(text))) out.push(noteFromMatch(m[1], m[2], m[3]));
  return out;
}

function findIntervals(text) {
  const low = text.toLowerCase().replace(/ё/g, 'е');
  const set = [];
  const add = (code) => { if (M.parseIntervalCode(code) && !set.includes(code)) set.push(code); };
  let m;
  // «б6» — большая секста, а «Б6» с заглавной — мажорный секстаккорд (его разбирает findShapeCodes).
  const reCode = /(?:^|[^а-яёА-ЯЁa-zA-Z])(ув|ум|Ув|Ум|ч|б|м|Ч|Б|М)\s?(\d{1,2})(?![\d])/g;
  while ((m = reCode.exec(text))) {
    if (/^[БМ]/.test(m[1]) && m[2] === '6') continue;
    if (/^(Ув|Ум)$/.test(m[1]) && m[2] === '6') continue;
    add(m[1].toLowerCase() + m[2]);
  }
  const reWords = /(чист|больш|мал|увеличенн|уменьш[её]нн)[а-яё]*\s+(прим|секунд|терци|кварт|квинт|секст|септим|октав|нон|децим)[а-яё]*/g;
  while ((m = reWords.exec(low))) {
    const q = (QUALITY_WORDS.find(([re]) => re.test(m[1])) || [])[1];
    const n = (NUM_WORDS.find(([re]) => re.test(m[2])) || [])[1];
    if (q && n) add(q + n);
  }
  if (/тритон/.test(low)) { add('ув4'); add('ум5'); }
  if (/характерн[а-яё]*\s+интервал/.test(low)) ['ув2', 'ум7', 'ув5', 'ум4'].forEach(add);
  return set;
}

function findChordCodes(text) {
  const out = [];
  const add = (c) => { if (!out.includes(c)) out.push(c); };
  let m;
  const reFunc = /(?:^|[^A-Za-zА-Яа-яЁё])([TtSsDdТтДдСс])\s?(53|64|65|43|6|7|2)(?!\d)/g;
  while ((m = reFunc.exec(text))) add(m[1] + m[2]);
  const reRoman = /(?:^|[^A-Za-zА-Яа-яЁё])(ум|ув|Ум|Ув|М|м)?(VII|VI|IV|V|III|II)\s?(53|64|65|43|6|7|2)(?!\d)/g;
  while ((m = reRoman.exec(text))) add((m[1] || '') + m[2] + m[3]);
  const low = text.toLowerCase();
  if (/доминант[- ]?септаккорд|доминантсептаккорд/.test(low)) add('D7');
  if (/(обращени[а-яё]*\s+(d7|д7|доминант))|((d7|д7|доминантсептаккорд)[а-яё]*\s+(и\s+|с\s+)?(его\s+)?обращени)/.test(low)) ['D7', 'D65', 'D43', 'D2'].forEach(add);
  if (/главн[а-яё]*\s+трезвучи/.test(low)) {
    ['T53', 'S53', 'D53'].forEach(add);
    if (/обращени/.test(low)) ['T6', 'T64', 'S6', 'S64', 'D6', 'D64'].forEach(add);
  }
  // Двойная доминанта, кадансовый 64, неаполитанский секстаккорд.
  const reDD = /(?:^|[^A-Za-zА-Яа-яЁё])(DD|ДД|dd|дд)\s?(7|65|43|2)(?!\d)/g;
  while ((m = reDD.exec(text))) add('DD' + m[2]);
  if (/(?:^|[^A-Za-zА-Яа-яЁё])[KК]\s?64(?!\d)/.test(text) || /кадансов[а-яё]*\s+квартсекст/.test(low)) add('K64');
  if (/(?:^|[^A-Za-zА-Яа-яЁё])N\s?6(?!\d)/.test(text) || /неаполитанск/.test(low)) add('N6');
  if (/двойн[а-яё]*\s+доминант/.test(low) && !out.some((c) => c.startsWith('DD'))) add('DD7');
  if (/прерванн/.test(low) && !out.includes('D7')) add('D7');
  const withInv = (base) => new RegExp(`(обращени[а-яё]*\\s+(${base}))|((${base})[а-яё]*\\s+(и\\s+|с\\s+)?(его\\s+)?обращени)`).test(low);
  if (withInv('ii7|ii 7|септаккорд[а-яё]* ii|септаккорд[а-яё]* второй')) ['II7', 'II65', 'II43', 'II2'].forEach(add);
  if (withInv('vii7|вводн[а-яё]* септаккорд')) ['VII7', 'VII65', 'VII43', 'VII2'].forEach(add);
  if (withInv('dd7|дд7|двойн[а-яё]* доминант')) ['DD7', 'DD65', 'DD43', 'DD2'].forEach(add);
  if (/вводн[а-яё]*\s+септаккорд/.test(low) && !out.some((c) => /VII/.test(c))) add('VII7');
  return out;
}

/* Структурные аккорды «от ноты»: Б53, М6, Ум53, Ув64, Д7 … */
function findShapeCodes(text) {
  const out = [];
  let m;
  const re = /(?:^|[^A-Za-zА-Яа-яЁё])(Б|М|Ум|Ув|б|м|ум|ув)\s?(53|64|6)(?!\d)/g;
  while ((m = re.exec(text))) {
    if (m[2] === '6' && /^[бму]/.test(m[1])) continue; // строчные «б6/м6» — интервалы
    const q = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    if (!out.includes(q + m[2])) out.push(q + m[2]);
  }
  return out;
}

function modeType(low) {
  if (/гармоническ/.test(low)) return 'harmonic';
  if (/мелодическ/.test(low)) return 'melodic';
  if (/натуральн/.test(low)) return 'natural';
  return null;
}

const TYPE_RU = { natural: 'натуральный', harmonic: 'гармонический', melodic: 'мелодический' };
const L = (notes) => notes.map(M.noteName).join(' — ');
/* «в Ля миноре», «в Ре мажоре» */
const inKey = (key) => `в ${M.noteName(key.tonic)} ${key.mode === 'major' ? 'мажоре' : 'миноре'}`;

/* ---------------------------- задачи ---------------------------- */

function taskKey(key, type) {
  const t = type || 'natural';
  const d = M.describeKey(key, t);
  const lines = [
    `Тональность ${d.name} (${d.german}). Ключевые знаки: ${d.signatureCount ? `${d.signatureCount} (${d.signatureKind}) — ${d.signature.join(', ')}` : 'нет'}.`,
    `Параллельная тональность: ${d.relative}. Одноимённая: ${d.parallel}.${d.enharmonic ? ` Энгармонически равная: ${d.enharmonic}.` : ''}`,
    `Гамма, ${TYPE_RU[t]} вид, вверх: ${L(d.up)}; вниз: ${L(d.down)}.`
  ];
  const abc = M.toAbc({ title: `${d.name}, ${TYPE_RU[t]} вид`, key, bars: [d.up, d.down] });
  return { text: lines.join('\n'), abc };
}

function taskIntervalFromNote(from, code, dir) {
  const iv = M.parseIntervalCode(code);
  const to = M.buildInterval(from, iv, dir);
  if (!to) return { text: `${code} от ${M.noteName(from)} ${dir === 'down' ? 'вниз' : 'вверх'} без тройных знаков не строится.` };
  const semis = M.intervalSemis(iv.num, iv.q);
  const text = `${code} (${M.intervalFullName(iv.num, iv.q)}, ${iv.num} ступ., ${M.tonesText(semis)}) от ${M.noteName(from)} ${dir === 'down' ? 'вниз' : 'вверх'}: ${M.noteName(from)} — ${M.noteName(to)}.`;
  return { text, abc: M.toAbc({ title: `${code} от ${M.noteName(from)} ${dir === 'down' ? 'вниз' : 'вверх'}`, bars: [[from, to], [[from, to]]], noteLen: '2' }) };
}

function taskIntervalsInKey(key, codes, type) {
  const types = type ? [type] : (key.mode === 'major' ? ['natural', 'harmonic'] : ['natural', 'harmonic']);
  const lines = [];
  const bars = [];
  for (const code of codes) {
    for (const t of types) {
      const list = M.intervalsInKey(key, t, code);
      // в гармоническом виде показываем только то, чего нет в натуральном
      const natural = t !== 'natural' && types.includes('natural') ? M.intervalsInKey(key, 'natural', code).map((x) => x.degrees.join('-') + M.noteName(x.low)) : [];
      for (const x of list) {
        if (natural.includes(x.degrees.join('-') + M.noteName(x.low))) continue;
        const r = x.resolution;
        const res = !r ? '' : r.stable ? ' — устойчивый, разрешения не требует.' : ` → разрешение ${L(r.to)} (${r.toInterval.code}, ${r.toInterval.name}).`;
        lines.push(`${x.code} ${inKey(key)} (${TYPE_RU[t]} вид): ${x.degrees.join('–')} ступени, ${L([x.low, x.high])}${res}`);
        if (bars.length < 8) {
          bars.push([[x.low, x.high]]);
          if (r && !r.stable) bars.push([[r.to[0], r.to[1]]]);
        }
      }
    }
    if (!types.some((t) => M.intervalsInKey(key, t, code).length)) lines.push(`${code} ${inKey(key)} (${types.map((t) => TYPE_RU[t]).join(' и ')} вид): нет.`);
  }
  return { text: lines.join('\n'), abc: bars.length ? M.toAbc({ title: `${codes.join(', ')} ${inKey(key)}`, key, bars, noteLen: '2' }) : '' };
}

function chordLine(r) {
  let s = `${r.label} ${inKey(r.keyObj)} (${TYPE_RU[r.type]} вид): ${L(r.notes)} (снизу вверх; ${r.quality}; ${r.inversion}; строится на ${r.degree} ступени от звука ${M.noteName(r.root)}).`;
  const paths = r.resolutions || (r.resolution ? [{ label: 'разрешение', steps: [r.resolution] }] : []);
  for (const p of paths) {
    s += `\n   Разрешение (${p.label}): ` + p.steps.map((st) => `${L(st.to)} (${st.result})`).join(' → ') + '.';
  }
  return s;
}

function taskChordsInKey(key, codes, type) {
  const lines = [];
  const bars = [];
  for (const code of codes) {
    const r = M.buildChordInKey(key, code, type || 'auto');
    if (r.error) { lines.push(r.error + '.'); continue; }
    lines.push(chordLine(r));
    if (bars.length < 14) {
      bars.push([r.notes]);
      for (const p of (r.resolutions || [])) for (const st of p.steps) bars.push([st.to]);
    }
  }
  return { text: lines.join('\n'), abc: bars.length ? M.toAbc({ title: `${codes.join(', ')} ${inKey(key)}`, key, bars, noteLen: '2' }) : '' };
}

function taskChordFromNote(from, code) {
  const r = M.buildChordFromNote(from, code);
  if (r.error) return { text: r.error + '.' };
  if (r.notes) {
    return {
      text: `${r.code} от ${r.from}: ${L(r.notes)} (интервалы от нижнего звука: ${r.intervals.join(', ')}).`,
      abc: M.toAbc({ title: `${r.code} от ${r.from}`, bars: [[r.notes]], noteLen: '2' })
    };
  }
  const lines = [`${r.code} от звука ${r.from}:`];
  const bars = [];
  for (const v of r.variants) {
    if (v.error) { lines.push(`— ${v.error}.`); continue; }
    lines.push('— ' + chordLine(v));
    bars.push([v.notes]);
    if (v.resolution) bars.push([v.resolution.to]);
  }
  return { text: lines.join('\n'), abc: bars.length ? M.toAbc({ title: `${r.code} от ${r.from}`, bars, noteLen: '2' }) : '' };
}

function taskAnalyze(a, b) {
  const r = M.analyzeInterval(a, b);
  return {
    text: `Интервал между ${M.noteName(a)} и ${M.noteName(b)} (вверх от ${M.noteName(r.low)}): ${r.code} — ${r.name}, ${r.num} ступ., ${M.tonesText(r.semis)}.`,
    abc: M.toAbc({ title: `${M.noteName(r.low)} — ${M.noteName(r.high)}`, bars: [[r.low, r.high], [[r.low, r.high]]], noteLen: '2' })
  };
}

/* ---------------------------- обороты ----------------------------
   «T-D-T», «T–S–D7–T», «I-IV-V-I», «Т-С-Д-Т», «t s K64 D7 t» (через пробел —
   только если рядом слово «оборот/последовательность/каденция»). */
const PTOK = '(?:DD|ДД|[KК]64|[KК]|N6|VII|VI|IV|V|III|II|I|[TtSsDdТтСсДд])(?:53|64|65|43|6|7|2)?';
const RE_SEQ_DASH = new RegExp(`(?<![A-Za-zА-Яа-яЁё0-9])${PTOK}(?:\\s*[-–—→]\\s*${PTOK}){1,11}(?![A-Za-zА-Яа-яЁё0-9])`, 'g');
const RE_SEQ_SPACE = new RegExp(`(?<![A-Za-zА-Яа-яЁё0-9])${PTOK}(?:[ \\t]+${PTOK}){2,11}(?![A-Za-zА-Яа-яЁё0-9])`, 'g');
const PROG_WORDS = /оборот|ступен|последовательн|каденц|цепочк|аккорд[а-яё]*\s+(?:подряд|по\s+порядку)|гармонизац|сыграй|построй|подпиши/;

function findProgressions(text) {
  const low = text.toLowerCase().replace(/ё/g, 'е');
  const out = [];
  const add = (raw) => {
    const toks = P.parseProgression(raw);
    if (!toks || toks.length < 2) return;
    // «V-I», «I-V» без слова «оборот» — слишком похоже на обычный текст.
    if (toks.length < 3 && !PROG_WORDS.test(low)) return;
    const key = P.progressionTitle(toks);
    if (!out.some((t) => P.progressionTitle(t) === key)) out.push(toks);
  };
  let m;
  RE_SEQ_DASH.lastIndex = 0;
  while ((m = RE_SEQ_DASH.exec(text))) add(m[0]);
  if (PROG_WORDS.test(low)) {
    RE_SEQ_SPACE.lastIndex = 0;
    while ((m = RE_SEQ_SPACE.exec(text))) {
      // Только явные функции/ступени латиницей или кириллицей — без слов «и», «в».
      if (/^(?:[TtSsDdТтСсДдKКN]|DD|ДД|[IV]+)/.test(m[0])) add(m[0]);
    }
  }
  for (const [re, seq] of P.NAMED_PROGRESSIONS) if (re.test(low)) add(seq);
  return out.slice(0, 4);
}

function taskProgression(key, toks, low) {
  const voices = /четыр[её]хголос|4-?х?\s*голос|с\s+басом|бас\s+и\s+три/.test(low) ? 4 : /тр[её]хголос|3-?х?\s*голос/.test(low) ? 3 : undefined;
  const r = P.buildProgression(key, toks, { voices });
  if (r.error) return { text: `Оборот ${P.progressionTitle(toks)} ${inKey(key)}: ${r.error}.` };
  return { text: r.text, abc: r.abc, progression: true };
}

/* ---------------------------- точка входа ---------------------------- */

const MUSIC_HINT_RE = /(интервал|тритон|аккорд|трезвучи|септаккорд|секстаккорд|квартсекст|гамм|тональност|ключев[а-яе]*\s+знак|диез|бемол|мажор|минор|ступен[ьи]|сольфеджио|обращени|разреши|разрешени|-dur\b|-moll\b|(?:^|[^а-яa-z])(?:ув|ум|ч|б|м)\s?\d{1,2}(?!\d)|(?:^|[^а-яa-z])[tsdтдс]\s?(?:53|64|65|43|6|7|2)(?!\d)|(?:^|[^а-яa-z])(?:vii|vi|iv|iii|ii|v)\s?(?:53|64|65|43|6|7|2)(?!\d))/i;

export function analyzeMusicQuery(query) {
  const text = String(query || '').slice(0, 2000);
  const low = text.toLowerCase().replace(/ё/g, 'е');
  const progressions = findProgressions(text);
  if (!MUSIC_HINT_RE.test(low) && !progressions.length) return { musical: false, tasks: [] };

  const keys = findKeys(text).filter(M.isValidKey);
  const badKeys = findKeys(text).filter((k) => !M.isValidKey(k));
  const fromNotes = findFromNotes(text);
  const intervals = findIntervals(text);
  const chords = findChordCodes(text);
  const shapes = findShapeCodes(text);
  const type = modeType(low);
  const dir = /вниз/.test(low) ? 'down' : 'up';
  const tasks = [];

  for (const k of badKeys) tasks.push({ text: `Тональности ${M.keyName(k)} нет среди 30 тональностей квинтового круга (больше 7 ключевых знаков). ${M.enharmonicKey(k) ? `Используют энгармонически равную: ${M.keyName(M.enharmonicKey(k))}.` : ''}`.trim() });

  const between = RE_BETWEEN.exec(text);
  if (between) tasks.push(taskAnalyze(noteFromMatch(between[1], between[2], between[3]), noteFromMatch(between[4], between[5], between[6])));

  if (progressions.length) {
    // Без тональности — До мажор (если просят минор — ля минор), как в учебнике.
    const pKeys = keys.length ? keys.slice(0, 3) : [{ tonic: { step: /минор|moll|minor/.test(low) && !/мажор|dur|major/.test(low) ? 5 : 0, alter: 0 }, mode: /минор|moll|minor/.test(low) && !/мажор|dur|major/.test(low) ? 'minor' : 'major' }];
    for (const toks of progressions) for (const k of pKeys) {
      if (tasks.length >= 6) break;
      tasks.push(taskProgression(k, toks, low));
    }
    return { musical: true, tasks: tasks.filter((t) => t && t.text).slice(0, 6) };
  }

  if (keys.length) {
    const key = keys[0];
    if (chords.length) tasks.push(taskChordsInKey(key, chords.slice(0, 9), type));
    if (intervals.length) tasks.push(taskIntervalsInKey(key, intervals.slice(0, 4), type));
    const wantsKeyInfo = /(гамм|ключев|знак|ступен|параллельн|одноим|тональност|энгармон)/.test(low);
    if (wantsKeyInfo || (!chords.length && !intervals.length)) {
      tasks.push(taskKey(key, type));
      if (keys[1] && keys.length <= 3) tasks.push(taskKey(keys[1], type));
    }
  } else if (fromNotes.length) {
    const from = fromNotes[0];
    for (const code of intervals.slice(0, 4)) tasks.push(taskIntervalFromNote(from, code, dir));
    for (const code of shapes.slice(0, 4)) tasks.push(taskChordFromNote(from, code));
    for (const code of chords.filter((c) => M.normalizeShapeCode(c.replace(/^[Тт]/, 'T'))).slice(0, 4)) tasks.push(taskChordFromNote(from, code));
  }

  return { musical: true, tasks: tasks.filter((t) => t && t.text).slice(0, 6) };
}

const ENGINE_RULES = [
  'МУЗЫКАЛЬНОЕ ЯДРО HarmonyAI. Ниже — результат точного алгоритмического расчёта по вопросу ученика. Он верен по определению.',
  '• Используй РОВНО эти ноты, ключевые знаки, интервалы, аккорды и разрешения. Ничего не пересчитывай в уме и не «поправляй».',
  '• Не заменяй ноты энгармонически: Соль-диез и Ля-бемоль — разные ноты. Называй звуки так, как в расчёте.',
  '• Нотный стан: вставь блоки ```abc из расчёта в ответ без изменений (не переписывай abc-код).',
  '• Твоя задача — понятно и доброжелательно объяснить ученику ДМШ, как это построено: по ступеням, затем по полутонам/тонам; почему неустойчивые звуки тянутся в устойчивые.',
  '• Если вопрос шире расчёта и нужно строить что-то ещё, объясни принцип построения, а конкретные ноты, которых нет в расчёте, не выдумывай — предложи ученику уточнить задачу (тональность, ноту, вид лада).',
  '• Точный теоретический расчёт уже выполнен ядром и приведён ниже. Не пересчитывай его заново в рассуждениях — сразу дай чёткий, понятный ответ ученику и выведи нотный блок ```abc.',
  '• Если у аккорда несколько путей разрешения (например, II7 — через доминанту и прямо в тонику), назови оба. Если в разделе «БАЗА ЗНАНИЙ» (учебники) указан предпочтительный способ конкретной школы — выдели именно его и сошлись на учебник.'
].join('\n');

const PROGRESSION_RULES = [
  '• Гармонические обороты построены алгоритмом по правилам голосоведения. Каждый блок ```abc — это готовый нотный пример: строка с подписями аккордов под нотами (I, V₆, IV₆₄ или T₅₃, D₇) и скрипичным/басовым ключом. Вставь КАЖДЫЙ блок целиком, символ в символ, вместе со строками %caption и %hm:exact.',
  '• Под нотами подписи уже есть — не дублируй ноты текстом таблицей; коротко объясни: какие звуки общие и остаются на месте, куда идут остальные голоса, как называется каждый аккорд (секстаккорд, квартсекстаккорд).',
  '• Если ученик просил несколько оборотов или тональностей — выведи все блоки по порядку, как в учебнике.'
].join('\n');

const GENERAL_RULE = 'Музыкальная теория: любой интервал и аккорд строй сначала по ступеням (терция = 3 ступени, квинта = 5), затем доводи до нужного числа тонов знаком альтерации. Не путай энгармонически равные звуки (Соль-диез ≠ Ля-бемоль), учитывай ключевые знаки тональности. Если не уверен в конкретных нотах — попроси уточнить тональность или звук, а не угадывай.';

/* Блок для системного контекста модели (или '' если вопрос не музыкальный):
   точный расчёт ядра + справка из базы знаний по сольфеджио (1–9 класс). */
export function buildMusicTheoryContext(query) {
  let knowledge = '';
  try { knowledge = buildSolfeggioContext(query); } catch (e) { console.warn('[solfeggio-kb] failed:', e?.message); }
  const engine = buildEngineContext(query);
  return [engine, knowledge].filter(Boolean).join('\n\n');
}

function buildEngineContext(query) {
  let res;
  try { res = analyzeMusicQuery(query); } catch (e) {
    console.warn('[music-theory] analyze failed:', e?.message);
    return '';
  }
  if (!res.musical) return '';
  if (!res.tasks.length) return GENERAL_RULE;
  const parts = [ENGINE_RULES, '', 'РАСЧЁТ:'];
  let abcCount = 0;
  const hasProg = res.tasks.some((t) => t.progression);
  if (hasProg) parts.splice(1, 0, PROGRESSION_RULES);
  for (const t of res.tasks) {
    parts.push(t.text);
    if (t.abc && abcCount < (hasProg ? 6 : 4)) { parts.push('```abc\n' + t.abc + '\n```'); abcCount++; }
  }
  return parts.join('\n');
}
