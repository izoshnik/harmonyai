/* ============================================================================
   ГАРМОНИЧЕСКИЕ ОБОРОТЫ: T–D–T, T–S–T, T–S–D–T, каденции, D7 → T …
   ----------------------------------------------------------------------------
   Модель в уме ведёт голоса неверно (параллельные квинты, лишние скачки), поэтому
   оборот строит алгоритм, а модель только объясняет.

   • Трёхголосие (как в учебнике сольфеджио): аккорды в тесном расположении в
     скрипичном ключе, оборот проводится от трёх положений тоники — T53, T6, T64.
     Общие звуки остаются на месте, остальные голоса идут к ближайшему звуку;
     при равенстве вариантов голоса движутся против движения основных тонов
     (S → D: «вниз»). Обращение каждого аккорда получается само и подписывается
     римской цифрой с цифровкой: I, V₆, IV₆₄ …
   • Четырёхголосие «бас + три голоса» (если в обороте есть септаккорд, K64 или
     явно заданные обращения): бас в басовом ключе берётся по цифровке, верхние
     голоса — тесное расположение, септима D7 разрешается вниз, вводный тон —
     вверх в тонику (допускается неполная T с утроенной примой).
   • Каждый оборот сразу превращается в ABC-нотацию с подписями под аккордами.
   ============================================================================ */
import * as M from './music-theory.js';

const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const sub = (s) => String(s || '').split('').map((c) => SUB[c] || c).join('');
const ROMAN = M.RU.ROMAN;

/* Октава в music-theory: До первой октавы (C4) = 48 полутонов. */
const C4 = 48;
const LO3 = 43;  // Соль малой октавы — ниже трёхголосие не опускается
const HI3 = 74;  // Ре третьей октавы
const LO_BASS = 28, HI_BASS = 45; // Ми большой октавы … Ля малой: бас не залезает к верхним голосам

/* ---------------------------- разбор записи ---------------------------- */

const TOKEN_RE = /^(ум|ув|Ум|Ув|М|Б|м|б)?(DD|K|N|VII|VI|IV|V|III|II|I|[TtSsDd])(53|64|65|43|6|7|2)?$/;

function normToken(t) {
  return String(t || '').trim()
    .replace(/^ДД|^дд|^dd/, 'DD')
    .replace(/^[Кк](?=\s*64)/, 'K')
    .replace(/^Т/, 'T').replace(/^т/, 't')
    .replace(/^С/, 'S').replace(/^с/, 's')
    .replace(/^Д/, 'D').replace(/^д/, 'd');
}

/* «T-D-T», «T S D7 T», «I–IV–V–I», «t s K64 D7 t» → массив аккордов. */
export function parseProgression(raw) {
  const parts = String(raw || '').replace(/[→>]+/g, ' ').split(/[\s,;–—-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 12) return null;
  const out = [];
  for (const p of parts) {
    const tok = parseChordToken(p);
    if (!tok) return null;
    out.push(tok);
  }
  return out;
}

/* Один аккорд: «T53», «D7», «умVII7», «K64», «II2», «I». null — не аккорд. */
export function parseChordToken(p) {
  const t = normToken(p);
  const m = TOKEN_RE.exec(t);
  if (!m) return null;
  const q = m[1] || '', letter = m[2], fig = m[3] || '';
  if (q && !/^(VII|VI|IV|V|III|II|I)$/.test(letter)) return null;
  const code = (letter === 'K' && !fig) ? 'K64' : (letter === 'DD' && !fig) ? 'DD7' : q + letter + fig;
  const spec = M.parseChordCode(code);
  if (!spec) return null;
  return { token: t, letter: q + letter, fig, explicit: Boolean(fig), spec };
}

/* Подпись цепочки для заголовка: «T-S-D-T». */
export function progressionTitle(tokens) {
  return tokens.map((t) => t.letter + (t.explicit ? t.fig : '')).join('-');
}

/* ---------------------------- вспомогательное ---------------------------- */

const semis = (n) => M.absSemis(n);
const pc = (n) => ((semis(n) % 12) + 12) % 12;

function placeAscending(order, oct) {
  const out = [];
  let prev = null;
  for (const m of order) {
    const n = { step: m.step, alter: m.alter, oct: prev ? prev.oct : oct, member: m.idx };
    if (prev) while (M.absStep(n) <= M.absStep(prev)) n.oct += 1;
    out.push(n);
    prev = n;
  }
  return out;
}

function chordFor(key, tok) {
  let type = M.defaultTypeFor(key, tok.spec, 'auto');
  // «умVII7» в мажоре — из гармонического мажора, «мVII7» — из натурального.
  if (tok.spec.degree === 6 && tok.spec.kind === 'seventh' && !tok.spec.special) type = key.mode === 'minor' || tok.spec.quality === 'ум' ? 'harmonic' : 'natural';
  if (tok.harmonic) type = 'harmonic';
  const built = M.chordInKey(key, type, tok.spec);
  const members = built.members.map((m, idx) => ({ step: m.step, alter: m.alter, idx }));
  return { ...tok, key, members, size: members.length, rootPc: pc({ ...members[0], oct: 4 }) };
}

/* Параллельные квинты и октавы между любыми двумя голосами. */
function parallels(prev, next) {
  let bad = 0;
  for (let i = 0; i < prev.length; i++) for (let j = i + 1; j < prev.length; j++) {
    const a = ((semis(prev[j]) - semis(prev[i])) % 12 + 12) % 12;
    const b = ((semis(next[j]) - semis(next[i])) % 12 + 12) % 12;
    const moved = semis(prev[i]) !== semis(next[i]) || semis(prev[j]) !== semis(next[j]);
    if (moved && a === b && (a === 7 || a === 0)) bad++;
  }
  return bad;
}

function motionCost(prev, next, rootDir) {
  let cost = 0, sum = 0;
  for (let i = 0; i < prev.length; i++) {
    const d = semis(next[i]) - semis(prev[i]);
    cost += Math.abs(d);
    sum += d;
  }
  cost += 20 * parallels(prev, next);
  // При равной сумме перемещений — против движения основных тонов.
  if (rootDir && Math.sign(sum) === rootDir) cost += 0.5;
  return cost;
}

function rootDirection(a, b) {
  const d = ((b.rootPc - a.rootPc) % 12 + 12) % 12;
  if (d === 0) return 0;
  return d <= 6 ? 1 : -1;
}

/* ---------------------------- трёхголосие ---------------------------- */

function triadCandidates(ch, lo, hi, onlyInv) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    if (onlyInv != null && r !== onlyInv) continue;
    const order = ch.members.slice(r).concat(ch.members.slice(0, r));
    for (let oct = 2; oct <= 6; oct++) {
      const v = placeAscending(order, oct);
      if (semis(v[0]) < lo || semis(v[2]) > hi) continue;
      out.push({ notes: v, inv: r });
    }
  }
  return out;
}

const TRIAD_FIG = ['', '6', '64'];

function functionalLabel3(ch, inv) {
  const letter = ch.spec.special === 'N' ? 'N' : ch.letter;
  return letter + sub(['53', '6', '64'][inv]);
}

function romanLabel(ch, inv) {
  const base = ch.spec.special === 'N' ? 'N' : ROMAN[ch.spec.degree];
  return base + sub(TRIAD_FIG[inv]);
}

function buildThreeVoice(chords, startInv, functional) {
  const seq = [];
  // Первый аккорд — тесное расположение не ниже До первой октавы.
  const first = triadCandidates(chords[0], C4, HI3 + 5, chords[0].explicit ? chords[0].spec.inv : startInv)
    .sort((a, b) => semis(a.notes[0]) - semis(b.notes[0]))[0];
  if (!first) return null;
  seq.push({ chord: chords[0], notes: first.notes, inv: first.inv });
  for (let i = 1; i < chords.length; i++) {
    const prev = seq[i - 1];
    const ch = chords[i];
    const dir = rootDirection(prev.chord, ch);
    const cands = triadCandidates(ch, LO3, HI3, ch.explicit ? ch.spec.inv : null);
    let best = null;
    for (const c of cands) {
      const cost = motionCost(prev.notes, c.notes, dir);
      if (!best || cost < best.cost) best = { ...c, cost };
    }
    if (!best) return null;
    seq.push({ chord: ch, notes: best.notes, inv: best.inv });
  }
  return seq.map((s) => ({ ...s, label: functional ? functionalLabel3(s.chord, s.inv) : romanLabel(s.chord, s.inv) }));
}

/* ---------------------------- бас + три голоса ---------------------------- */

const SEVENTH_FIG = ['7', '65', '43', '2'];

function bassMemberIdx(ch) {
  if (ch.spec.special === 'K') return 2;
  return ch.spec.inv || 0;
}

/* Варианты баса: нужный звук аккорда в басовом диапазоне, не дальше октавы от
   предыдущего баса. Какой выбрать, решает общая цена вместе с верхними голосами. */
function bassOptions(ch, prevBass) {
  const m = ch.members[bassMemberIdx(ch)];
  const out = [];
  for (let oct = 1; oct <= 4; oct++) {
    const n = { step: m.step, alter: m.alter, oct, member: m.idx };
    const s = semis(n);
    if (s < LO_BASS || s > HI_BASS) continue;
    if (prevBass && Math.abs(s - semis(prevBass)) > 12) continue;
    out.push(n);
  }
  if (!prevBass) out.sort((a, b) => Math.abs(semis(a) - (C4 - 12)) - Math.abs(semis(b) - (C4 - 12)));
  return out;
}

/* Наборы звуков для трёх верхних голосов: полный аккорд (для трезвучия — все
   три звука, бас удваивает свой), для септаккорда — три звука без баса. После
   септаккорда трезвучие может быть неполным (утроенная прима, без квинты). */
function upperSets(ch, afterSeventh) {
  const idx = ch.members.map((m) => m.idx);
  if (ch.size === 4) return [idx.filter((i) => i !== bassMemberIdx(ch))];
  // «I⁻⁵₅₃» — тоника без квинты (утроенная прима и терция).
  if (ch.noFifth) return [[0, 0, 1], [0, 1, 1]];
  const sets = [idx.slice()];
  if (afterSeventh) sets.push([0, 0, 1]);
  // Прерванный оборот D7 → VI: в VI удваивается терция (вводный тон идёт в тонику).
  if (afterSeventh && ch.spec.degree === 5 && !ch.spec.special) sets.push([1, 1, 2]);
  return sets;
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const x = a.slice().sort(), y = b.slice().sort();
  return x.every((v, i) => v === y[i]);
}

function upperCandidates(ch, bass, afterSeventh) {
  const pool = [];
  for (const m of ch.members) for (let oct = 3; oct <= 6; oct++) {
    const n = { step: m.step, alter: m.alter, oct, member: m.idx };
    const s = semis(n);
    if (s > semis(bass) && s >= LO3 && s <= HI3 + 3) pool.push(n);
  }
  pool.sort((a, b) => semis(a) - semis(b));
  const sets = upperSets(ch, afterSeventh);
  const out = [];
  for (let a = 0; a < pool.length; a++) for (let b = a; b < pool.length; b++) for (let c = b; c < pool.length; c++) {
    const v = [pool[a], pool[b], pool[c]];
    if (semis(v[2]) - semis(v[0]) > 12) continue;          // верхние голоса — тесно, в пределах октавы
    if (a === b && b === c) continue;
    const mem = v.map((n) => n.member);
    const set = sets.find((s) => sameMultiset(s, mem));
    if (!set) continue;
    out.push({ notes: v, incomplete: set !== sets[0] });
  }
  return out;
}

function fourVoiceCost(prevAll, nextAll, prevCh, nextCh, rootDir, key) {
  let cost = motionCost(prevAll.slice(1), nextAll.slice(1), rootDir);
  cost += 20 * parallels(prevAll, nextAll) - 20 * parallels(prevAll.slice(1), nextAll.slice(1));
  const k = nextCh.key || key;
  const degs = M.scaleDegrees(k, k.mode === 'minor' ? 'harmonic' : 'natural', 'up');
  for (let i = 1; i < prevAll.length; i++) {
    const p = prevAll[i], n = nextAll[i];
    const d = semis(n) - semis(p);
    // Септима септаккорда разрешается вниз на секунду.
    if (prevCh.size === 4 && p.member === 3 && !(d === -1 || d === -2)) cost += 10;
    // Повышенная IV ступень в DD7 (терция аккорда) идёт на полтона.
    if (prevCh.spec.special === 'DD' && p.member === 1 && Math.abs(d) !== 1) cost += 4;
    // Вводный тон доминанты идёт вверх в тонику.
    const leading = degs[6];
    if (prevCh.spec.degree === 4 && !prevCh.spec.special && (nextCh.spec.degree === 0 || nextCh.spec.degree === 5) && !nextCh.spec.special
      && p.step === leading.step && p.alter === leading.alter && d !== 1) cost += 6;
  }
  return cost;
}

function figureLabel(ch, explicitLabels) {
  if (explicitLabels) {
    const fig = ch.spec.special === 'K' ? '64' : ch.size === 4 ? SEVENTH_FIG[ch.spec.inv || 0] : TRIAD_FIG[ch.spec.inv || 0] || '53';
    const letter = ch.spec.special === 'DD' ? 'DD' : ch.spec.special === 'K' ? 'K' : ch.spec.special === 'N' ? 'N' : ch.letter;
    return letter + sub(fig === '' ? '53' : fig);
  }
  const base = ch.spec.special === 'N' ? 'N' : ROMAN[ch.spec.degree];
  const fig = ch.size === 4 ? SEVENTH_FIG[ch.spec.inv || 0] : TRIAD_FIG[ch.spec.special === 'K' ? 2 : (ch.spec.inv || 0)];
  return base + sub(fig);
}

function buildFourVoice(chords, sopranoMember, key, functionalLabels) {
  const seq = [];
  const c0 = chords[0];
  const bass0 = bassOptions(c0, null)[0];
  if (!bass0) return null;
  const firstCands = upperCandidates(c0, bass0, false).filter((c) => !c.incomplete && c.notes[2].member === sopranoMember)
    .sort((a, b) => Math.abs(semis(a.notes[1]) - 56) - Math.abs(semis(b.notes[1]) - 56));
  if (!firstCands.length) return null;
  seq.push({ chord: c0, notes: [bass0, ...firstCands[0].notes] });
  for (let i = 1; i < chords.length; i++) {
    const prev = seq[i - 1];
    const ch = chords[i];
    const dir = rootDirection(prev.chord, ch);
    let best = null;
    for (const bass of bassOptions(ch, prev.notes[0])) {
      const bassMove = Math.abs(semis(bass) - semis(prev.notes[0]));
      for (const c of upperCandidates(ch, bass, prev.chord.size === 4)) {
        const all = [bass, ...c.notes];
        const cost = fourVoiceCost(prev.notes, all, prev.chord, ch, dir, key) + (c.incomplete ? 1.5 : 0) + bassMove * 0.15;
        if (!best || cost < best.cost) best = { all, cost };
      }
    }
    if (!best) return null;
    seq.push({ chord: ch, notes: best.all });
  }
  return seq.map((s) => ({ ...s, label: figureLabel(s.chord, functionalLabels) }));
}

/* ---------------------------- ABC ---------------------------- */

function abcNotesBar(events, key, voice) {
  // events: [{notes, label}], voice: 'upper' | 'bass' | 'all'; один «такт» на положение.
  const sig = M.keySignature(key);
  const state = new Map();
  const one = (n) => {
    const k = n.step + ':' + n.oct;
    const expected = state.has(k) ? state.get(k) : M.sigAlter(sig, n.step);
    let acc = '';
    if (n.alter !== expected) {
      acc = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' }[String(n.alter)];
      state.set(k, n.alter);
    }
    return acc + M.abcPitch(n);
  };
  return events.map((e) => {
    const ns = voice === 'bass' ? [e.notes[0]] : voice === 'upper' ? e.notes.slice(1) : e.notes;
    const uniq = ns.filter((n, i) => ns.findIndex((m) => semis(m) === semis(n)) === i);
    const label = e.label && voice !== 'upper' ? `"_${e.label}"` : '';
    return label + (uniq.length > 1 ? '[' + uniq.map(one).join('') + ']' : one(uniq[0]));
  }).join(' ');
}

function abcForGroups(groups, key, four, caption) {
  const head = ['X:1', `%caption: ${caption}`, '%hm:exact', 'M:none', 'L:1'];
  if (!four) {
    head.push(`K:${M.abcKeyName(key)} clef=treble`);
    head.push(groups.map((g) => abcNotesBar(g, key, 'all')).join(' || ') + ' ||');
    return head.join('\n');
  }
  head.push('%%staves {1 2}', `K:${M.abcKeyName(key)}`);
  head.push('V:1 clef=treble');
  head.push(groups.map((g) => abcNotesBar(g, key, 'upper')).join(' || ') + ' ||');
  head.push('V:2 clef=bass');
  head.push(groups.map((g) => abcNotesBar(g, key, 'bass')).join(' || ') + ' ||');
  return head.join('\n');
}

/* ---------------------------- точка входа ---------------------------- */

const POS_NAME3 = ['первый аккорд в основном виде', 'первый аккорд — секстаккорд', 'первый аккорд — квартсекстаккорд'];
const POS_NAME4 = ['мелодическое положение примы (сверху — основной тон)', 'положение терции', 'положение квинты'];

export function keyGermanTitle(key) { return M.keyNameGerman(key); }

/* key — {tonic:{step,alter},mode}; tokens — результат parseProgression.
   Возвращает { text, abc, voices } или { error }. */
export function buildProgression(key, tokens, opts = {}) {
  if (!tokens || tokens.length < 2) return { error: 'нужно хотя бы два аккорда' };
  // В миноре тоника и субдоминанта пишутся строчными: t, s.
  if (key.mode === 'minor') tokens = tokens.map((t) => (/^[TS]$/.test(t.letter) ? { ...t, letter: t.letter.toLowerCase() } : t));
  let chords;
  try { chords = tokens.map((t) => chordFor(key, t)); } catch (e) { return { error: 'не удалось построить аккорды оборота' }; }
  const four = opts.voices === 4 || chords.some((c) => c.size === 4 || c.spec.special === 'K' || c.spec.special === 'DD');
  // Подписи: если ученик пишет функциями с цифровкой (T53, D6) — так же и подписываем,
  // иначе — римскими цифрами, как в учебнике (I, V₆, IV₆₄).
  const functional = tokens.some((t) => /^[TtSsDdK]$|^DD$/.test(t.letter)) && (four || tokens.some((t) => t.explicit));
  const groups = [];
  const names = [];
  if (!four) {
    const starts = chords[0].explicit ? [chords[0].spec.inv] : [0, 1, 2];
    for (const s of starts) {
      const g = buildThreeVoice(chords, s, functional);
      if (g) { groups.push(g); names.push(POS_NAME3[s]); }
    }
  } else {
    // Мелодические положения: сверху основной тон, терция, квинта первого аккорда.
    for (const sop of [0, 1, 2]) {
      const g = buildFourVoice(chords, sop, key, functional);
      if (g) { groups.push(g); names.push(POS_NAME4[sop]); }
    }
  }
  if (!groups.length) return { error: 'оборот не удалось провести без нарушений голосоведения' };
  const title = `${M.keyNameGerman(key)}: ${progressionTitle(tokens)}`;
  const L = (ns) => ns.map(M.noteName).join('–');
  const lines = [`Оборот ${progressionTitle(tokens)} в тональности ${M.keyName(key)} (${M.keyNameGerman(key)}), ${four ? 'четырёхголосие: бас в басовом ключе + три голоса в скрипичном' : 'трёхголосие в скрипичном ключе, тесное расположение'}:`];
  groups.forEach((g, i) => {
    lines.push(`${i + 1}) ${names[i]}: ` + g.map((e) => `${e.label.replace(/[₀-₉]/g, (c) => '0123456789'['₀₁₂₃₄₅₆₇₈₉'.indexOf(c)])} (${L(four ? [e.notes[0], ...e.notes.slice(1)] : e.notes)})`).join(' → '));
  });
  lines.push('Голосоведение: общие звуки соседних аккордов остаются на месте, остальные голоса идут плавно к ближайшему звуку; там, где общих звуков нет, верхние голоса движутся против баса.');
  return { text: lines.join('\n'), abc: abcForGroups(groups, key, four, title), voices: four ? 4 : 3, title, groups };
}

/* Готовые названия оборотов. */
export const NAMED_PROGRESSIONS = [
  [/автентическ[а-яё]*\s+(оборот|каденц)/, 'T-D-T'],
  [/плагальн[а-яё]*\s+(оборот|каденц)/, 'T-S-T'],
  [/полн[а-яё]*\s+(гармоническ[а-яё]*\s+)?(оборот|каденц)/, 'T-S-D-T'],
  [/прерванн[а-яё]*\s+(оборот|каденц)/, 'T-S-D7-VI'],
  [/кадансов[а-яё]*\s+оборот|оборот[а-яё]*\s+с\s+кадансов/, 'T-S-K64-D7-T']
];


/* ---------------------------- последовательность по цифровке ----------------------------
   «I53 – II2 – умVII7 – V65 – I53 – VI6=III6 – K64 – V7 – I53» (с модуляцией через
   общий аккорд): items = [{ key, tok, label, noFifth }] — у каждого аккорда своя
   тональность. Бас по цифровке, три верхних голоса — плавно, септимы вниз. */
export function buildChordSequence(items, { title = '', sigKey = null } = {}) {
  if (!items || items.length < 2) return { error: 'нужно хотя бы два аккорда' };
  let chords;
  try { chords = items.map((it) => ({ ...chordFor(it.key, it.tok), noFifth: Boolean(it.noFifth), shownLabel: it.label || '' })); }
  catch (e) { return { error: 'не удалось построить аккорды' }; }
  const key0 = items[0].key;
  let best = null;
  for (const sop of [0, 1, 2]) {
    const g = buildFourVoice(chords, sop, key0, true);
    if (!g) continue;
    let cost = 0;
    for (let i = 1; i < g.length; i++) cost += motionCost(g[i - 1].notes.slice(1), g[i].notes.slice(1), 0);
    if (!best || cost < best.cost) best = { g, cost };
  }
  if (!best) return { error: 'последовательность не удалось провести без нарушений голосоведения' };
  const g = best.g.map((e) => ({ ...e, label: e.chord.shownLabel || e.label }));
  const sk = sigKey || key0;
  const head = ['X:1', `%caption: ${title}`, '%hm:exact', 'M:none', 'L:1', '%%staves {1 2}', `K:${M.abcKeyName(sk)}`];
  head.push('V:1 clef=treble', g.map((e) => abcNotesBar([e], sk, 'upper')).join(' | ') + ' ||');
  head.push('V:2 clef=bass', g.map((e) => abcNotesBar([e], sk, 'bass')).join(' | ') + ' ||');
  const L = (ns) => ns.map(M.noteName).join('–');
  const text = g.map((e, i) => `${i + 1}) ${e.label.replace(/[₀-₉]/g, (c) => '0123456789'['₀₁₂₃₄₅₆₇₈₉'.indexOf(c)])}: бас ${M.noteName(e.notes[0])}, верхние голоса ${L(e.notes.slice(1))}`).join('\n');
  return { text, abc: head.join('\n'), events: g };
}
