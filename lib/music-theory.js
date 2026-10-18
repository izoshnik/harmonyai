/* ============================================================================
   MUSIC THEORY ENGINE — детерминированное «музыкальное ядро» HarmonyAI.
   ----------------------------------------------------------------------------
   Языковая модель в уме путает энгармонизмы (Соль-диез ↔ Ля-бемоль), забывает
   ключевые знаки и ошибается в разрешениях. Здесь всё считается строго:

   • нота = { step, alter, oct }:
       step  — диатоническая ступень 0..6 (До Ре Ми Фа Соль Ля Си),
       alter — альтерация −2..+2 (дубль-бемоль … дубль-диез),
       oct   — октава (4 = первая октава, До4 — «до первой октавы»);
   • любой интервал строится СНАЧАЛА по ступеням (терция = 3 ступени), и только
     потом доводится знаком до нужного числа полутонов. Большая терция от Ми —
     всегда Соль-диез, а не Ля-бемоль;
   • 30 тональностей квинтового круга (до 7 знаков), натуральный /
     гармонический / мелодический вид;
   • аккорды в русской школьной номенклатуре (T53, S6, D64, D7, D65, D43, D2,
     МVII7, УмVII7, II7, умVII53, увIII53 …) и их классические разрешения;
   • каждый результат сопровождается ABC-нотацией — чат рисует её нотным станом.

   Модуль без зависимостей и без побочных эффектов; лежит в /lib и не расходует
   лимит функций Vercel.
   ============================================================================ */

const STEP_RU = ['До', 'Ре', 'Ми', 'Фа', 'Соль', 'Ля', 'Си'];
const STEP_LETTER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const FIFTHS_BASE = [0, 2, 4, -1, 1, 3, 5]; // позиция ступени на «линии квинт»: C=0, G=1, F=−1 …
const ALTER_RU = { '-2': 'дубль-бемоль', '-1': 'бемоль', '1': 'диез', '2': 'дубль-диез' };
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // фа до соль ре ля ми си
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];  // си ми ля ре соль до фа
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/* ---------------------------- ноты ---------------------------- */

export function note(step, alter = 0, oct = 4) { return { step, alter, oct }; }

export function noteName(n) {
  return STEP_RU[n.step] + (n.alter ? '-' + ALTER_RU[String(n.alter)] : '');
}

/* Абсолютная высота в полутонах (До4 = 48) и абсолютный номер ступени. */
export function absSemis(n) { return n.oct * 12 + NATURAL_SEMIS[n.step] + n.alter; }
export function absStep(n) { return n.oct * 7 + n.step; }
export function sameNote(a, b) { return a.step === b.step && a.alter === b.alter; }

function fromAbsStep(dia, targetSemis) {
  const step = ((dia % 7) + 7) % 7;
  const oct = Math.floor(dia / 7);
  const alter = targetSemis - (oct * 12 + NATURAL_SEMIS[step]);
  if (alter < -2 || alter > 2) return null; // тройных знаков в школьной теории нет
  return { step, alter, oct };
}

/* ---------------------------- тональности ---------------------------- */

/* Число ключевых знаков: >0 диезы, <0 бемоли. */
export function keySignature(key) {
  return FIFTHS_BASE[key.tonic.step] + 7 * key.tonic.alter + (key.mode === 'minor' ? -3 : 0);
}

export function isValidKey(key) {
  const sig = keySignature(key);
  return Math.abs(sig) <= 7;
}

function sigAlter(sig, step) {
  if (sig > 0) return SHARP_ORDER.indexOf(step) < sig ? 1 : 0;
  if (sig < 0) return FLAT_ORDER.indexOf(step) < -sig ? -1 : 0;
  return 0;
}

export function keySignatureNotes(key) {
  const sig = keySignature(key);
  if (sig > 0) return SHARP_ORDER.slice(0, sig).map((s) => note(s, 1));
  if (sig < 0) return FLAT_ORDER.slice(0, -sig).map((s) => note(s, -1));
  return [];
}

export function keyName(key) {
  return `${noteName(key.tonic)} ${key.mode === 'major' ? 'мажор' : 'минор'}`;
}

/* Немецкое (буквенное) обозначение: Fis-dur, es-moll, B-dur, h-moll. */
export function keyNameGerman(key) {
  const { step, alter } = key.tonic;
  const base = ['c', 'd', 'e', 'f', 'g', 'a', 'h'][step];
  let s;
  if (alter === 0) s = base;
  else if (alter > 0) s = base + 'is'.repeat(alter);
  else if (step === 6) s = alter === -1 ? 'b' : 'heses';
  else if (step === 2 || step === 5) s = base + 's' + 'es'.repeat(-alter - 1);
  else s = base + 'es'.repeat(-alter);
  if (key.mode === 'major') return s[0].toUpperCase() + s.slice(1) + '-dur';
  return s + '-moll';
}

export function relativeKey(key) {
  if (key.mode === 'major') {
    const t = buildInterval({ ...key.tonic, oct: 4 }, 'м3', 'down');
    return { tonic: { step: t.step, alter: t.alter }, mode: 'minor' };
  }
  const t = buildInterval({ ...key.tonic, oct: 4 }, 'м3', 'up');
  return { tonic: { step: t.step, alter: t.alter }, mode: 'major' };
}

export function parallelKey(key) {
  return { tonic: { ...key.tonic }, mode: key.mode === 'major' ? 'minor' : 'major' };
}

/* Энгармонически равная тональность (Фа-диез мажор ↔ Соль-бемоль мажор), если есть. */
export function enharmonicKey(key) {
  const sig = keySignature(key);
  if (Math.abs(sig) < 5) return null;
  const pc = ((NATURAL_SEMIS[key.tonic.step] + key.tonic.alter) % 12 + 12) % 12;
  for (let step = 0; step < 7; step++) {
    for (const alter of [-1, 0, 1]) {
      if (step === key.tonic.step) continue;
      if (((NATURAL_SEMIS[step] + alter) % 12 + 12) % 12 !== pc) continue;
      const k = { tonic: { step, alter }, mode: key.mode };
      if (isValidKey(k)) return k;
    }
  }
  return null;
}

/* Ступени лада 0..6 (без октавы) с учётом вида.
   major: natural | harmonic (♭VI) | melodic (вниз ♭VI и ♭VII)
   minor: natural | harmonic (♯VII) | melodic (вверх ♯VI и ♯VII, вниз — натуральный) */
export function scaleDegrees(key, type = 'natural', direction = 'up') {
  const sig = keySignature(key);
  const degs = [];
  for (let i = 0; i < 7; i++) {
    const step = (key.tonic.step + i) % 7;
    degs.push({ step, alter: sigAlter(sig, step) });
  }
  if (key.mode === 'major') {
    if (type === 'harmonic') degs[5].alter -= 1;
    if (type === 'melodic' && direction === 'down') { degs[5].alter -= 1; degs[6].alter -= 1; }
  } else {
    if (type === 'harmonic') degs[6].alter += 1;
    if (type === 'melodic' && direction === 'up') { degs[5].alter += 1; degs[6].alter += 1; }
  }
  return degs;
}

/* Звук ступени d (может быть <0 или >6 — соседние октавы) в октаве тоники baseOct. */
function degreeNote(key, degs, d, baseOct = 4) {
  const i = ((d % 7) + 7) % 7;
  const dia = baseOct * 7 + key.tonic.step + d;
  return { step: degs[i].step, alter: degs[i].alter, oct: Math.floor(dia / 7) };
}

export function scaleNotes(key, type = 'natural', direction = 'up', baseOct = 4) {
  const degs = scaleDegrees(key, type, direction);
  const out = [];
  for (let d = 0; d <= 7; d++) out.push(degreeNote(key, degs, d, baseOct));
  return direction === 'down' ? out.reverse() : out;
}

/* Полный разбор тональности. */
export function describeKey(key, type = 'natural') {
  const sig = keySignature(key);
  const signs = keySignatureNotes(key);
  const res = {
    name: keyName(key),
    german: keyNameGerman(key),
    signatureCount: Math.abs(sig),
    signatureKind: sig > 0 ? 'диезы' : sig < 0 ? 'бемоли' : 'нет знаков',
    signature: signs.map(noteName),
    relative: keyName(relativeKey(key)),
    parallel: keyName(parallelKey(key)),
    type,
    up: scaleNotes(key, type, 'up'),
    down: scaleNotes(key, type, 'down')
  };
  const enh = enharmonicKey(key);
  if (enh) res.enharmonic = keyName(enh);
  return res;
}

/* ---------------------------- интервалы ---------------------------- */

const INTERVAL_NOUN = ['прима', 'секунда', 'терция', 'кварта', 'квинта', 'секста', 'септима', 'октава',
  'нона', 'децима', 'ундецима', 'дуодецима', 'терцдецима', 'квартдецима', 'квинтдецима'];
const QUALITY_ADJ = { 'ч': 'чистая', 'б': 'большая', 'м': 'малая', 'ув': 'увеличенная', 'ум': 'уменьшённая',
  'дв.ув': 'дважды увеличенная', 'дв.ум': 'дважды уменьшённая' };
const PERFECT_SIMPLE = { 1: 0, 4: 5, 5: 7 };
const MAJOR_SIMPLE = { 2: 2, 3: 4, 6: 9, 7: 11 };

/* «б3», «ув4», «ч8», «м9» → { num, q } */
export function parseIntervalCode(code) {
  const m = /^(дв\.?\s*ув|дв\.?\s*ум|ув|ум|ч|б|м)\s*(\d{1,2})$/i.exec(String(code || '').trim());
  if (!m) return null;
  let q = m[1].toLowerCase().replace(/\s+/g, '');
  if (q === 'дввув' || q === 'дв.ув' || q === 'двув') q = 'дв.ув';
  if (q === 'дв.ум' || q === 'двум') q = 'дв.ум';
  const num = Number(m[2]);
  if (num < 1 || num > 15) return null;
  return intervalSemis(num, q) == null ? null : { num, q };
}

export function intervalSemis(num, q) {
  const simple = ((num - 1) % 7) + 1;
  const octs = Math.floor((num - 1) / 7);
  let s;
  if (simple in PERFECT_SIMPLE) {
    const b = PERFECT_SIMPLE[simple];
    s = { 'ч': b, 'ув': b + 1, 'ум': b - 1, 'дв.ув': b + 2, 'дв.ум': b - 2 }[q];
  } else {
    const b = MAJOR_SIMPLE[simple];
    s = { 'б': b, 'м': b - 1, 'ув': b + 1, 'ум': b - 2, 'дв.ув': b + 2, 'дв.ум': b - 3 }[q];
  }
  if (s == null) return null;
  if (num === 1 && s < 0) return null; // уменьшённой примы нет
  return s + 12 * octs;
}

export function intervalCode(num, q) { return q + num; }
export function intervalFullName(num, q) {
  return `${QUALITY_ADJ[q]} ${INTERVAL_NOUN[num - 1] || num}`;
}

/* Построение интервала от ноты вверх/вниз. Возвращает ноту или null. */
export function buildInterval(from, code, direction = 'up') {
  const iv = typeof code === 'string' ? parseIntervalCode(code) : code;
  if (!iv) return null;
  const semis = intervalSemis(iv.num, iv.q);
  const sign = direction === 'down' ? -1 : 1;
  return fromAbsStep(absStep(from) + sign * (iv.num - 1), absSemis(from) + sign * semis);
}

/* Название интервала между двумя нотами (порядок не важен). */
export function analyzeInterval(a, b) {
  let lo = a, hi = b;
  if (absStep(b) < absStep(a) || (absStep(b) === absStep(a) && absSemis(b) < absSemis(a))) { lo = b; hi = a; }
  const num = absStep(hi) - absStep(lo) + 1;
  const semis = absSemis(hi) - absSemis(lo);
  const simple = ((num - 1) % 7) + 1;
  const octs = Math.floor((num - 1) / 7);
  const rest = semis - 12 * octs;
  let q = null;
  if (simple in PERFECT_SIMPLE) {
    q = { 0: 'ч', 1: 'ув', '-1': 'ум', 2: 'дв.ув', '-2': 'дв.ум' }[rest - PERFECT_SIMPLE[simple]];
  } else {
    q = { 0: 'б', '-1': 'м', 1: 'ув', '-2': 'ум', 2: 'дв.ув', '-3': 'дв.ум' }[rest - MAJOR_SIMPLE[simple]];
  }
  return { num, q: q || '?', semis, code: q ? q + num : '?', name: q ? intervalFullName(num, q) : 'нестандартный интервал', low: lo, high: hi };
}

export function tonesText(semis) {
  const t = semis / 2;
  const whole = Math.floor(t);
  const half = semis % 2 === 1;
  if (!whole && half) return 'полутон';
  const word = (n) => (n % 10 === 1 && n % 100 !== 11) ? 'тон' : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) ? 'тона' : 'тонов';
  return `${whole}${half ? ',5' : ''} ${half ? 'тона' : word(whole)}`;
}

/* ---------------------------- интервалы в ладу и их разрешение ---------------------------- */

const STABLE = new Set([0, 2, 4]);
/* Тяготение неустойчивых ступеней: VII→I (вверх), II→I, IV→III, VI→V (вниз). */
const TENDENCY = { 6: +1, 1: -1, 3: -1, 5: -1 };

function degreeOf(key, degs, n) {
  for (let i = 0; i < 7; i++) if (sameNote(degs[i], n)) return i;
  return -1;
}

/* Разрешение двух звуков лада (нижний, верхний) по тяготениям. */
export function resolveIntervalInKey(key, type, low, high) {
  const degs = scaleDegrees(key, type, 'up');
  const dl = degreeOf(key, degs, low), dh = degreeOf(key, degs, high);
  if (dl < 0 || dh < 0) return null;
  if (STABLE.has(dl) && STABLE.has(dh)) return { stable: true };
  const move = (n, d) => {
    if (STABLE.has(d)) return { ...n };
    const t = d + TENDENCY[d];
    const ti = ((t % 7) + 7) % 7;
    const dia = absStep(n) + TENDENCY[d];
    return { step: degs[ti].step, alter: degs[ti].alter, oct: Math.floor(dia / 7) };
  };
  // Тритоны разрешаются по правилу «ув4 расходится в сексту, ум5 сходится в терцию»:
  // оба звука идут на секунду в противоположные стороны (поэтому II здесь идёт в III).
  const iv = analyzeInterval(low, high);
  const simple = ((iv.num - 1) % 7) + 1;
  const tritone = (iv.q === 'ув' && simple === 4) || (iv.q === 'ум' && simple === 5);
  const stepMove = (n, dir) => {
    const dia = absStep(n) + dir;
    const d = degreeOf(key, degs, n) + dir;
    const ti = ((d % 7) + 7) % 7;
    return { step: degs[ti].step, alter: degs[ti].alter, oct: Math.floor(dia / 7) };
  };
  const rl = tritone ? stepMove(low, iv.q === 'ув' ? -1 : +1) : move(low, dl);
  const rh = tritone ? stepMove(high, iv.q === 'ув' ? +1 : -1) : move(high, dh);
  return { stable: false, from: [low, high], to: [rl, rh], degrees: [ROMAN[dl], ROMAN[dh]], toInterval: analyzeInterval(rl, rh) };
}

/* Все интервалы заданного вида, которые есть в ладу (от каждой ступени вверх). */
export function intervalsInKey(key, type, code) {
  const iv = typeof code === 'string' ? parseIntervalCode(code) : code;
  if (!iv) return [];
  const degs = scaleDegrees(key, type, 'up');
  const out = [];
  for (let d = 0; d < 7; d++) {
    const low = degreeNote(key, degs, d, 4);
    const high = buildInterval(low, iv, 'up');
    if (!high) continue;
    const dh = degreeOf(key, degs, high);
    if (dh < 0) continue;
    out.push({ code: iv.q + iv.num, name: intervalFullName(iv.num, iv.q), degrees: [ROMAN[d], ROMAN[dh]], low, high, resolution: resolveIntervalInKey(key, type, low, high) });
  }
  return out;
}

/* ---------------------------- аккорды ---------------------------- */

const TRIAD_INV = { '53': 0, '6': 1, '64': 2 };
const SEVENTH_INV = { '7': 0, '65': 1, '43': 2, '2': 3 };
const FUNC_DEGREE = { T: 0, S: 3, D: 4 };

function triadQuality(notes) {
  const r = notes[0];
  const third = analyzeInterval(r, notes[1]).code;
  const fifth = analyzeInterval(r, notes[2]).code;
  if (third === 'б3' && fifth === 'ч5') return 'Б';
  if (third === 'м3' && fifth === 'ч5') return 'М';
  if (third === 'м3' && fifth === 'ум5') return 'Ум';
  if (third === 'б3' && fifth === 'ув5') return 'Ув';
  return '?';
}

function seventhQuality(notes) {
  const t = triadQuality(notes.slice(0, 3));
  const sev = analyzeInterval(notes[0], notes[3]).code;
  if (t === 'Б' && sev === 'м7') return 'малый мажорный';
  if (t === 'М' && sev === 'м7') return 'малый минорный';
  if (t === 'Ум' && sev === 'м7') return 'малый уменьшённый';
  if (t === 'Ум' && sev === 'ум7') return 'уменьшённый';
  if (t === 'Б' && sev === 'б7') return 'большой мажорный';
  if (t === 'М' && sev === 'б7') return 'большой минорный';
  if (t === 'Ув' && sev === 'б7') return 'большой увеличенный';
  return 'септаккорд';
}

const TRIAD_NAME = { 'Б': 'большое (мажорное) трезвучие', 'М': 'малое (минорное) трезвучие', 'Ум': 'уменьшённое трезвучие', 'Ув': 'увеличенное трезвучие' };
const INV_NAME = { 0: 'основной вид', 1: 'первое обращение', 2: 'второе обращение', 3: 'третье обращение' };
const TRIAD_INV_NAME = { 0: '53 — основной вид', 1: '6 — секстаккорд', 2: '64 — квартсекстаккорд' };
const SEVENTH_INV_NAME = { 0: '7 — септаккорд', 1: '65 — квинтсекстаккорд', 2: '43 — терцквартаккорд', 3: '2 — секундаккорд' };

/* Тесное расположение: каждый следующий звук — ближайший выше предыдущего. */
function closeVoicing(members, bassOct = 4) {
  const out = [];
  let prev = null;
  for (const m of members) {
    let n = { step: m.step, alter: m.alter, oct: prev ? prev.oct : bassOct };
    if (prev) while (absStep(n) <= absStep(prev)) n.oct += 1;
    out.push(n);
    prev = n;
  }
  return out;
}

/* Ближайшая по ступеням нота с заданной ступенью лада. */
function nearestTo(from, target) {
  let best = null;
  for (const dOct of [-1, 0, 1]) {
    const n = { step: target.step, alter: target.alter, oct: from.oct + dOct };
    const dist = Math.abs(absStep(n) - absStep(from));
    if (!best || dist < best.dist) best = { n, dist };
  }
  return best.n;
}

/* Разбор кода аккорда: T53, t6, S64, D7, D65, II7, умVII53, МVII7, УмVII7, VI6 … */
export function parseChordCode(raw) {
  let s = String(raw || '').trim()
    .replace(/[Тт](?=\s*\d)/g, (c) => c === 'Т' ? 'T' : 't')
    .replace(/[Дд](?=\s*\d)/g, (c) => c === 'Д' ? 'D' : 'd')
    .replace(/[Сс](?=\s*\d)/g, (c) => c === 'С' ? 'S' : 's')
    .replace(/\s+/g, '');
  let m = /^([TtSsDd])(53|64|65|43|6|7|2)?$/.exec(s);
  if (m) {
    const fn = m[1].toUpperCase();
    const fig = m[2] || '53';
    if (fig in SEVENTH_INV && fn !== 'D') return null;
    return { kind: fig in SEVENTH_INV ? 'seventh' : 'triad', func: fn, degree: FUNC_DEGREE[fn], fig, inv: fig in SEVENTH_INV ? SEVENTH_INV[fig] : TRIAD_INV[fig], label: fn + fig };
  }
  m = /^(ум|ув|м|б|Ум|Ув|М|Б)?(VII|VI|IV|V|III|II|I)(53|64|65|43|6|7|2)?$/.exec(s.replace(/^(Мал|мал)/, 'М'));
  if (m) {
    const degree = ROMAN.indexOf(m[2]);
    const fig = m[3] || '53';
    const kind = fig in SEVENTH_INV ? 'seventh' : 'triad';
    let quality = m[1] ? m[1].toLowerCase() : '';
    return { kind, degree, fig, inv: kind === 'seventh' ? SEVENTH_INV[fig] : TRIAD_INV[fig], quality, label: (m[1] || '') + m[2] + fig };
  }
  return null;
}

/* Звуки аккорда в ладу (снизу вверх в тесном расположении) + описание. */
function chordInKey(key, type, spec) {
  const degs = scaleDegrees(key, type, 'up');
  const size = spec.kind === 'seventh' ? 4 : 3;
  const members = [];
  for (let k = 0; k < size; k++) {
    const d = spec.degree + 2 * k;
    members.push({ ...degs[((d % 7) + 7) % 7], degree: ((d % 7) + 7) % 7 });
  }
  const rootPos = closeVoicing(members, 4);
  const inverted = members.slice(spec.inv).concat(members.slice(0, spec.inv));
  const voiced = closeVoicing(inverted, 4).map((n, i) => ({ ...n, degree: inverted[i].degree }));
  const quality = size === 3 ? triadQuality(rootPos) : seventhQuality(rootPos);
  return { members, voiced, quality };
}

/* Тип лада по умолчанию для аккорда (школьная практика). */
function defaultTypeFor(key, spec, requested) {
  if (requested && requested !== 'auto') return requested;
  if (key.mode === 'minor' && (spec.func === 'D' || spec.degree === 4 || spec.degree === 6)) return 'harmonic';
  return 'natural';
}

/* Карта разрешения голосов «ступень аккорда → ступень цели». */
function resolutionPlan(spec, quality) {
  // Доминантсептаккорд и обращения: VII→I, II→I, IV→III; V в басу → I, V вверху остаётся.
  if (spec.kind === 'seventh' && spec.degree === 4) {
    const target = { 4: 'stay', 6: 0, 1: 0, 3: 2 };
    const result = { 0: 'неполное T53 с утроенным основным тоном', 1: 'T53 (полное) с удвоенным основным тоном', 2: 'T53 (полное) с удвоенным основным тоном', 3: 'T6 с удвоенным основным тоном' }[spec.inv];
    return { target, bassV: 0, result };
  }
  // Вводные септаккорды: VII→I, II→III (вверх, чтобы не было параллельных квинт), IV→III, VI→V.
  if (spec.kind === 'seventh' && spec.degree === 6 && spec.inv === 0) {
    return { target: { 6: 0, 1: 2, 3: 2, 5: 4 }, result: 'T53 с удвоенным терцовым тоном' };
  }
  return null;
}

function resolveChord(key, type, spec, voiced) {
  const plan = resolutionPlan(spec, null);
  if (!plan) return null;
  const degs = scaleDegrees(key, type, 'up');
  const to = voiced.map((n, i) => {
    let t = plan.target[n.degree];
    if (t === 'stay') t = (i === 0 && plan.bassV === 0) ? 0 : 'stay';
    if (t === 'stay' || t === undefined) return { step: n.step, alter: n.alter, oct: n.oct, degree: n.degree };
    // Бас D7 (V→I) идёт вниз на квинту — так тоника не сливается с верхними голосами.
    if (i === 0 && n.degree === 4 && t === 0) {
      let r = { step: degs[0].step, alter: degs[0].alter, oct: n.oct };
      while (absStep(r) >= absStep(n)) r.oct -= 1;
      return { ...r, degree: 0 };
    }
    const r = nearestTo(n, degs[t]);
    return { ...r, degree: t };
  });
  return { to, result: plan.result };
}

/* Построить аккорд в тональности по школьному коду (с разрешением, если оно есть).
   type: 'natural' | 'harmonic' | 'melodic' | 'auto' */
export function buildChordInKey(key, code, type = 'auto') {
  const spec = typeof code === 'string' ? parseChordCode(code) : code;
  if (!spec) return { error: `не понимаю обозначение аккорда «${code}»` };
  // VII7 в мажоре: «МVII7» — натуральный, «УмVII7» — гармонический; в миноре — только гармонический.
  let tryTypes = [defaultTypeFor(key, spec, type)];
  if (spec.quality) tryTypes = Array.from(new Set(tryTypes.concat(['natural', 'harmonic', 'melodic'])));
  // Вводные септаккорды: МVII7 — только натуральный мажор, УмVII7 — гармонические мажор и минор.
  if (spec.kind === 'seventh' && spec.degree === 6) {
    if (key.mode === 'minor') tryTypes = ['harmonic'];
    else if (spec.quality === 'м') tryTypes = ['natural'];
    else if (spec.quality === 'ум') tryTypes = ['harmonic'];
  }
  let built = null, usedType = tryTypes[0];
  for (const t of tryTypes) {
    const b = chordInKey(key, t, spec);
    if (!spec.quality || qualityMatches(spec, b.quality)) { built = b; usedType = t; break; }
  }
  if (!built) return { error: `в тональности ${keyName(key)} нет аккорда ${spec.label}` };
  const res = resolveChord(key, usedType, spec, built.voiced);
  const invName = spec.kind === 'seventh' ? SEVENTH_INV_NAME[spec.inv] : TRIAD_INV_NAME[spec.inv];
  const qualityName = spec.kind === 'seventh' ? `${built.quality} септаккорд` : TRIAD_NAME[built.quality] || '';
  return {
    label: spec.label,
    key: keyName(key),
    keyObj: key,
    type: usedType,
    degree: ROMAN[spec.degree],
    inversion: invName,
    quality: qualityName,
    notes: built.voiced,
    root: built.members[0],
    resolution: res
  };
}

function qualityMatches(spec, quality) {
  const q = spec.quality;
  if (spec.kind === 'triad') return ({ 'ум': 'Ум', 'ув': 'Ув', 'м': 'М', 'б': 'Б' })[q] === quality;
  if (q === 'м') return quality === 'малый уменьшённый';
  if (q === 'ум') return quality === 'уменьшённый';
  return true;
}

/* ---------------------------- аккорды от ноты ---------------------------- */

/* Трезвучия и обращения от звука: интервалы от баса. */
const SHAPES_FROM_NOTE = {
  'Б53': ['б3', 'ч5'], 'М53': ['м3', 'ч5'], 'Ум53': ['м3', 'ум5'], 'Ув53': ['б3', 'ув5'],
  'Б6': ['м3', 'м6'], 'Б64': ['ч4', 'б6'], 'М6': ['б3', 'б6'], 'М64': ['ч4', 'м6'],
  'Ум6': ['м3', 'б6'], 'Ум64': ['ув4', 'б6'], 'Ув6': ['б3', 'м6'], 'Ув64': ['ум4', 'м6'],
  'Б7': ['б3', 'ч5', 'б7'], 'М7': ['м3', 'ч5', 'м7'], 'Мм7': ['б3', 'ч5', 'м7'],
  'МУм7': ['м3', 'ум5', 'м7'], 'Ум7': ['м3', 'ум5', 'ум7']
};

/* Септаккорды-«функции» от звука: какой ступенью лада является данный звук. */
const FUNCTIONAL_FROM_NOTE = {
  D7: { degree: 4, inv: 0 }, D65: { degree: 6, inv: 1 }, D43: { degree: 1, inv: 2 }, D2: { degree: 3, inv: 3 },
  'МVII7': { degree: 6, inv: 0, quality: 'м' }, 'УмVII7': { degree: 6, inv: 0, quality: 'ум' }
};

export function normalizeShapeCode(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '')
    .replace(/^Д(?=\d)/, 'D').replace(/^д(?=\d)/, 'D');
  if (s in FUNCTIONAL_FROM_NOTE) return s;
  const low = s.toLowerCase();
  for (const k of Object.keys(FUNCTIONAL_FROM_NOTE)) if (k.toLowerCase() === low) return k;
  for (const k of Object.keys(SHAPES_FROM_NOTE)) if (k.toLowerCase() === low) return k;
  return null;
}

export function buildChordFromNote(from, rawCode) {
  const code = normalizeShapeCode(rawCode);
  if (!code) return { error: `не понимаю обозначение «${rawCode}»` };
  if (code in SHAPES_FROM_NOTE) {
    const notes = [from];
    for (const iv of SHAPES_FROM_NOTE[code]) {
      const n = buildInterval(from, iv, 'up');
      if (!n) return { error: `от ноты ${noteName(from)} аккорд ${code} не строится без тройных знаков` };
      notes.push(n);
    }
    return { code, from: noteName(from), notes, intervals: SHAPES_FROM_NOTE[code] };
  }
  // Функциональный септаккорд: данный звук — его бас; находим тональности.
  const f = FUNCTIONAL_FROM_NOTE[code];
  const variants = [];
  const modes = f.quality === 'м' ? [['major', 'natural']] : f.quality === 'ум' ? [['major', 'harmonic'], ['minor', 'harmonic']] : [['major', 'natural'], ['minor', 'harmonic']];
  for (const [mode, type] of modes) {
    // Тоника: бас — ступень f.degree, значит тоника лежит на (7 − degree) ступеней выше.
    const up = (7 - f.degree) % 7;
    let tonic = null;
    for (let semis = 0; semis < 12 && !tonic; semis++) {
      const cand = fromAbsStep(absStep(from) + up, absSemis(from) + semis);
      if (!cand) continue;
      const key = { tonic: { step: cand.step, alter: cand.alter }, mode };
      if (!isValidKey(key)) continue;
      const degs = scaleDegrees(key, type, 'up');
      if (sameNote(degs[f.degree], from)) tonic = key;
    }
    if (!tonic) { variants.push({ mode, error: `${mode === 'major' ? 'мажорной' : 'минорной'} тональности с таким звуком нет среди 30 тональностей` }); continue; }
    const spec = { kind: 'seventh', degree: f.degree === 4 || f.degree === 6 ? f.degree : 4, inv: f.inv, fig: ['7', '65', '43', '2'][f.inv], label: code, quality: f.quality || '' };
    if (code.startsWith('D')) { spec.degree = 4; spec.func = 'D'; }
    variants.push(buildChordInKey(tonic, spec, type));
  }
  return { code, from: noteName(from), variants };
}

/* ---------------------------- ABC-нотация ---------------------------- */

function abcKeyName(key) {
  if (!key) return 'C';
  const acc = key.tonic.alter === 1 ? '#' : key.tonic.alter === -1 ? 'b' : '';
  return STEP_LETTER[key.tonic.step] + acc + (key.mode === 'minor' ? 'm' : '');
}

function abcPitch(n) {
  const letter = STEP_LETTER[n.step];
  if (n.oct >= 5) return letter.toLowerCase() + "'".repeat(n.oct - 5);
  return letter + ','.repeat(Math.max(0, 4 - n.oct));
}

/* events: массив тактов; такт — массив событий; событие — нота или массив нот (аккорд).
   Случайные знаки ставятся только там, где звук отличается от ключа или от
   предыдущего знака в этом такте. */
export function toAbc({ title = '', key = null, bars = [], length = '1/4', noteLen = '' } = {}) {
  const sig = key ? keySignature(key) : 0;
  const lines = ['X:1'];
  if (title) lines.push('T:' + title.replace(/\n/g, ' '));
  lines.push('M:none', 'L:' + length, 'K:' + abcKeyName(key));
  const body = bars.map((bar) => {
    const state = new Map();
    const one = (n) => {
      const k = n.step + ':' + n.oct;
      const expected = state.has(k) ? state.get(k) : sigAlter(sig, n.step);
      let acc = '';
      if (n.alter !== expected) {
        acc = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' }[String(n.alter)];
        state.set(k, n.alter);
      }
      return acc + abcPitch(n);
    };
    const uniq = (ev) => ev.filter((n, i) => ev.findIndex((m) => absStep(m) === absStep(n) && m.alter === n.alter) === i);
    return bar.map((ev) => Array.isArray(ev) ? '[' + uniq(ev).map(one).join('') + ']' + noteLen : one(ev) + noteLen).join(' ');
  }).join(' | ') + ' |]';
  lines.push(body);
  return lines.join('\n');
}

export const RU = { STEP_RU, ROMAN, noteName, keyName };
