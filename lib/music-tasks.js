/* ============================================================================
   РЕШАТЕЛЬ ЗАДАНИЙ И БИЛЕТОВ ПО СОЛЬФЕДЖИО
   ----------------------------------------------------------------------------
   Текст билета (набранный или распознанный с фото) делится на пункты: «А)», «Б)»,
   «1.», «2.»… Каждый пункт решается музыкальным ядром — без LLM и без ошибок:

     • гаммы: «Спеть ↑ a moll натур., ↓ A dur мелодич.»;
     • интервалы в тональности: «в A dur все увеличенные интервалы с разрешением
       (тритоны и характерные)», «все уменьшённые», «тритоны»;
     • цепочки от звука: «от звука a по цепочке: ↑Б6, ↓Ув53» — каждое следующее
       созвучие строится от последнего спетого звука;
     • последовательности аккордов по цифровке: «в fis moll: I53 – II2 – умVII7 –
       V65 – I53 – VI6=III6 – K64 – V7 – I53(без 5)» — с модуляцией через общий
       аккорд (тональность после «=» находится сама);
     • последовательности ступеней и интервалов по ступеням.

   Модель получает готовые ноты и нотные примеры и только объясняет.
   ============================================================================ */
import * as M from './music-theory.js';
import * as P from './music-progressions.js';

const SUB_D = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const STEP_RU = { 'до': 0, 'ре': 1, 'ми': 2, 'фа': 3, 'соль': 4, 'ля': 5, 'си': 6 };
const TYPE_RU = { natural: 'натуральный', harmonic: 'гармонический', melodic: 'мелодический' };
const L = (ns) => ns.map(M.noteName).join(' – ');

/* ---------------------------- нормализация текста ---------------------------- */

export function normalizeTaskText(raw) {
  let s = String(raw || '').replace(/\r/g, '');
  // «I⁻⁵₅₃», «I^-5 53», «I(-5)53» — тоника без квинты.
  s = s.replace(/\b(I|VI|IV|III|II|V)\s*\^?\s*\(?\s*[-−⁻]\s*[5⁵]\s*\)?\s*([5₅])\s*([3₃])/g, '$153(без5)');
  // «VII^г7», «VIIг7», «VII⁷ᵍ» — гармонический вид.
  s = s.replace(/VII\s*\^?\s*\(?[гГᵍg]\)?\s*([7₇]|65|6₅|₆₅|43|₄₃|2|₂)?/g, (m, f) => 'VII' + (f ? f.replace(/[₀-₉]/g, (c) => SUB_D[c]) : '7') + '(г)');
  s = s.replace(/[₀-₉⁰-⁹¹²³]/g, (c) => SUB_D[c] || c);
  // «ум VII» → «умVII», «Ув 5 3» → «Ув53», «K 6 4» → «K64».
  s = s.replace(/(?<![А-Яа-яЁё])(ум|ув|Ум|Ув|м|б|М|Б)\s+(VII|VI|IV|V|III|II|I)(?![A-Za-z])/g, '$1$2');
  s = s.replace(/(^|[^А-Яа-яA-Za-z])(Ув|Ум|Б|М|I{1,3}|IV|VI{0,2}|V|K|К|T|S|D|Т|С|Д)\s*(\d)\s+(\d)(?!\d)/g, '$1$2$3$4');
  // «Ув 53», «I 53», «К 64», «V 7» — цифровка отдельно от буквы.
  s = s.replace(/(^|[^А-Яа-яA-Za-z])(Ув|Ум|Б|М|VII|VI|IV|V|III|II|I|K|К|T|S|D|Т|С|Д|DD)\s+(53|64|65|43|6|7|2)(?!\d)/g, '$1$2$3');
  s = s.replace(/[\[\]]/g, ' ');
  s = s.replace(/⬆|⇧/g, '↑').replace(/⬇|⇩/g, '↓');
  return s;
}

/* ---------------------------- тональности ---------------------------- */

const DE_KEY = /(^|[^A-Za-zА-Яа-я])([A-Ha-h])(isis|eses|is|es|s)?[\s-]+(dur|moll)(?![a-z])/g;
const RU_KEY = /(^|[^а-яё])(до|ре|ми|фа|соль|ля|си)(?:[\s-]*(диез|бемоль))?[\s-]+(мажор|минор)[а-яё]*/gi;

function deKey(letter, acc, mode) {
  const l = letter.toLowerCase();
  const step = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, h: 6, b: 6 }[l];
  let alter = 0;
  const a = (acc || '').toLowerCase();
  if (l === 'b') alter = -1;
  if (a === 'is') alter = 1; else if (a === 'isis') alter = 2;
  else if (a === 'es' || a === 's') alter = -1; else if (a === 'eses') alter = -2;
  return { tonic: { step, alter }, mode: mode.toLowerCase() === 'dur' ? 'major' : 'minor' };
}

/* Все тональности в тексте с позициями. */
function findKeysAt(text) {
  const out = [];
  let m;
  DE_KEY.lastIndex = 0;
  while ((m = DE_KEY.exec(text))) out.push({ at: m.index + m[1].length, end: DE_KEY.lastIndex, key: deKey(m[2], m[3], m[4]) });
  RU_KEY.lastIndex = 0;
  while ((m = RU_KEY.exec(text))) {
    const alter = m[3] ? (/^диез/i.test(m[3]) ? 1 : -1) : 0;
    out.push({ at: m.index + m[1].length, end: RU_KEY.lastIndex, key: { tonic: { step: STEP_RU[m[2].toLowerCase()], alter }, mode: /^мажор/i.test(m[4]) ? 'major' : 'minor' } });
  }
  return out.filter((k) => M.isValidKey(k.key)).sort((a, b) => a.at - b.at);
}

/* ---------------------------- пункты ---------------------------- */

const ITEM_RE = /(?:^|\n|\s)(?:(\d{1,2})[.)]|([А-ЕA-E])\))\s/g;

export function splitTaskItems(text) {
  const marks = [];
  let m;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(text))) marks.push({ at: m.index, label: m[1] ? m[1] + '.' : m[2] + ')' });
  if (!marks.length) return [{ label: '', text }];
  const items = [];
  if (marks[0].at > 0 && text.slice(0, marks[0].at).trim()) items.push({ label: '', text: text.slice(0, marks[0].at) });
  marks.forEach((mk, i) => items.push({ label: mk.label, text: text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length).trim() }));
  // «1. Теория: А) …» — номер без содержимого склеиваем с первым подпунктом как заголовок.
  return items.filter((it) => it.text.replace(/^\s*(?:\d{1,2}[.)]|[А-ЕA-E]\))\s*/, '').trim().length > 2);
}

/* ---------------------------- гаммы ---------------------------- */

function scaleType(word) {
  const w = String(word || '').toLowerCase();
  if (/^гарм/.test(w)) return 'harmonic';
  if (/^мелод/.test(w)) return 'melodic';
  return 'natural';
}

function solveScales(item, keysAt) {
  const t = item.text;
  if (!/(спе|сыгра|гамм|построй|построить|напиши|написать|звукоряд)/i.test(t)) return [];
  if (/интервал|аккорд|тритон|по\s+цепочке|ступен/i.test(t) && !/гамм|звукоряд/i.test(t)) return [];
  const out = [];
  for (const k of keysAt) {
    const before = t.slice(Math.max(0, k.at - 8), k.at);
    const after = t.slice(k.end, k.end + 18);
    const arrow = /↑|вверх/i.test(before) ? 'up' : /↓|вниз/i.test(before) ? 'down' : '';
    const tm = /^\s*\.?\s*(натур[а-яё]*|гарм[а-яё]*|мелод[а-яё]*)/i.exec(after);
    if (!arrow && !tm && !/гамм|звукоряд/i.test(t)) continue;
    const type = tm ? scaleType(tm[1]) : 'natural';
    const dirs = arrow ? [arrow] : ['up', 'down'];
    const bars = dirs.map((d) => M.scaleNotes(k.key, type, d, 4));
    const name = `${M.keyName(k.key)} (${M.keyNameGerman(k.key)}), ${TYPE_RU[type]} вид`;
    const text = `Гамма ${name}${arrow ? (arrow === 'up' ? ' — вверх' : ' — вниз') : ''}: ` + bars.map((b, i) => (dirs.length > 1 ? (dirs[i] === 'up' ? 'вверх ' : 'вниз ') : '') + L(b)).join('; ') + '.' +
      (type !== 'natural' ? ` (${type === 'harmonic' ? (k.key.mode === 'minor' ? 'повышена VII ступень' : 'понижена VI ступень') : (k.key.mode === 'minor' ? 'вверх повышены VI и VII, вниз — натуральный вид' : 'вниз понижены VI и VII ступени')})` : '');
    out.push({ text, abc: M.toAbc({ title: name, key: k.key, bars, length: '1/4' }).replace('X:1\n', `X:1\n%caption: ${M.keyNameGerman(k.key)} ${TYPE_RU[type]}${arrow ? (arrow === 'up' ? ' ↑' : ' ↓') : ''}\n`) });
  }
  return out;
}

/* ---------------------------- интервалы в тональности ---------------------------- */

function intervalSet(t) {
  const low = t.toLowerCase();
  const set = new Set();
  const aug = /увеличенн/.test(low), dim = /уменьш[её]нн/.test(low);
  const tri = /тритон/.test(low), chr = /характерн/.test(low);
  if (tri) { if (aug && !dim) set.add('ув4'); else if (dim && !aug) set.add('ум5'); else { set.add('ув4'); set.add('ум5'); } }
  if (chr) {
    if (aug && !dim) { set.add('ув2'); set.add('ув5'); } else if (dim && !aug) { set.add('ум7'); set.add('ум4'); } else ['ув2', 'ум7', 'ув5', 'ум4'].forEach((c) => set.add(c));
  }
  if (!tri && !chr) { if (aug) ['ув4', 'ув2', 'ув5'].forEach((c) => set.add(c)); if (dim) ['ум5', 'ум7', 'ум4'].forEach((c) => set.add(c)); }
  return Array.from(set);
}

function solveIntervalsInKey(item, keysAt) {
  const t = item.text;
  if (!keysAt.length || !/интервал|тритон|характерн/i.test(t) || /по\s+цепочке|от\s+(?:звука|ноты)/i.test(t)) return [];
  const codes = intervalSet(t);
  if (!codes.length) return [];
  const key = keysAt[0].key;
  const lines = [];
  const bars = [];
  for (const code of codes) {
    const types = /^(ув2|ум7|ув5|ум4)$/.test(code) ? ['harmonic'] : ['natural', 'harmonic'];
    const seen = new Set();
    for (const type of types) {
      for (const x of M.intervalsInKey(key, type, code)) {
        const id = x.degrees.join('-') + M.noteName(x.low) + M.noteName(x.high);
        if (seen.has(id)) continue;
        seen.add(id);
        const r = x.resolution;
        const res = r && !r.stable ? ` → ${r.toInterval.code} (${L(r.to)})` : '';
        lines.push(`${x.code} на ${x.degrees[0]} ступени (${x.degrees.join('–')}, ${TYPE_RU[type]} вид): ${L([x.low, x.high])}${res}`);
        bars.push([[x.low, x.high]]);
        if (r && !r.stable) bars.push([[r.to[0], r.to[1]]]);
      }
    }
  }
  if (!lines.length) return [];
  return [{
    text: `${codes.join(', ')} в ${M.keyName(key)} (${M.keyNameGerman(key)}) с разрешением (увеличенные расходятся, уменьшённые сходятся):\n` + lines.map((l) => '— ' + l).join('\n'),
    abc: M.toAbc({ title: `${codes.join(', ')} ${M.keyNameGerman(key)}`, key, bars: bars.slice(0, 16), noteLen: '2' }).replace('X:1\n', `X:1\n%caption: ${M.keyNameGerman(key)}: ${codes.join(', ')} с разрешением\n`)
  }];
}

/* ---------------------------- цепочка от звука ---------------------------- */

const NOTE_DE = /^([a-hA-H])(isis|eses|is|es|s)?$/;
function parseStartNote(s) {
  const v = String(s || '').trim().replace(/[«»"]/g, '');
  let m = NOTE_DE.exec(v);
  if (m) {
    const l = m[1].toLowerCase();
    let step = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, h: 6, b: 6 }[l], alter = l === 'b' ? -1 : 0;
    const a = (m[2] || '').toLowerCase();
    if (a === 'is') alter = 1; else if (a === 'isis') alter = 2; else if (a === 'es' || a === 's') alter = -1; else if (a === 'eses') alter = -2;
    return { step, alter, oct: 4 };
  }
  m = /^(до|ре|ми|фа|соль|ля|си)(?:[\s-]*(диез|бемоль))?$/i.exec(v);
  if (m) return { step: STEP_RU[m[1].toLowerCase()], alter: m[2] ? (/^диез/i.test(m[2]) ? 1 : -1) : 0, oct: 4 };
  return null;
}

const INTERVAL_CODE = /^(ч|м|б|ув|ум)(\d{1,2})$/;
const SHAPE_CODE = /^(Б|М|Ум|Ув)(53|6|64)$|^(V|D|Д)(7|65|43|2)$|^(Б7|М7|Мм7|МУм7|Ум7|МVII7|УмVII7)$/;

function chordUp(from, code) {
  const c = code.replace(/^V/, 'D').replace(/^Д/, 'D');
  const r = M.buildChordFromNote(from, c);
  if (r.error) return { error: r.error };
  if (r.notes) return { notes: r.notes };
  const v = (r.variants || []).find((x) => !x.error);
  return v ? { notes: v.notes, keys: (r.variants || []).filter((x) => !x.error).map((x) => x.key) } : { error: 'не строится' };
}

/* Аккорд вниз от звука: данный звук — верхний; находим бас по крайнему интервалу. */
const SHAPE_SPAN = { 'Б53': 'ч5', 'М53': 'ч5', 'Ум53': 'ум5', 'Ув53': 'ув5', 'Б6': 'м6', 'М6': 'б6', 'Ум6': 'б6', 'Ув6': 'м6', 'Б64': 'б6', 'М64': 'м6', 'Ум64': 'б6', 'Ув64': 'м6', 'D7': 'м7', 'D65': 'м6', 'D43': 'б6', 'D2': 'б6' };
function chordDown(top, code) {
  const c = code.replace(/^V/, 'D').replace(/^Д/, 'D');
  const span = SHAPE_SPAN[c];
  if (!span) return { error: `${code} вниз пока не строю` };
  const bass = M.buildInterval(top, span, 'down');
  if (!bass) return { error: 'не строится без тройных знаков' };
  return chordUp(bass, c);
}

function solveChain(item) {
  const t = item.text;
  const m = /от\s+(?:звука|ноты)\s+«?([a-hA-H](?:isis|eses|is|es|s)?|до|ре|ми|фа|соль|ля|си)(?:[\s-]*(диез|бемоль))?»?/i.exec(t);
  if (!m) return [];
  let cur = parseStartNote(m[1] + (m[2] ? '-' + m[2] : ''));
  if (!cur) return [];
  const rest = t.slice(m.index + m[0].length);
  const re = /(↑|↓|вверх|вниз)?\s*((?:ч|м|б|ув|ум)\d{1,2}|(?:Б|М|Ум|Ув)(?:53|64|6)|(?:V|D|Д)(?:7|65|43|2)|МУм7|Ум7|Мм7|МVII7|УмVII7)(?![\dА-Яа-яA-Za-z])/g;
  const steps = [];
  let x;
  while ((x = re.exec(rest))) steps.push({ dir: /↓|вниз/.test(x[1] || '') ? 'down' : 'up', code: x[2] });
  if (!steps.length) return [];
  const start = { ...cur };
  const lines = [];
  const bars = [];
  for (const st of steps) {
    const iv = INTERVAL_CODE.exec(st.code);
    if (iv) {
      const to = M.buildInterval(cur, st.code, st.dir);
      if (!to) { lines.push(`${st.dir === 'up' ? '↑' : '↓'}${st.code} от ${M.noteName(cur)} — не строится без тройных знаков`); continue; }
      lines.push(`${st.dir === 'up' ? '↑' : '↓'}${st.code} от ${M.noteName(cur)}: ${M.noteName(cur)} – ${M.noteName(to)}`);
      bars.push([cur, to]);
      cur = to;
      continue;
    }
    const r = st.dir === 'up' ? chordUp(cur, st.code) : chordDown(cur, st.code);
    if (r.error) { lines.push(`${st.dir === 'up' ? '↑' : '↓'}${st.code} от ${M.noteName(cur)} — ${r.error}`); continue; }
    const notes = r.notes;
    const sung = st.dir === 'up' ? notes : notes.slice().reverse();
    lines.push(`${st.dir === 'up' ? '↑' : '↓'}${st.code} от ${M.noteName(cur)} (${st.dir === 'up' ? 'данный звук — нижний' : 'данный звук — верхний'}): поём ${L(sung)}`);
    bars.push([...sung, notes]);
    cur = sung[sung.length - 1];
  }
  if (!lines.length) return [];
  return [{
    text: `Цепочка от звука ${M.noteName(start)}: каждое следующее созвучие строится от последнего спетого звука.\n` + lines.map((l) => '— ' + l).join('\n'),
    abc: M.toAbc({ title: 'Цепочка', bars, noteLen: '' , length: '1/4' }).replace('X:1\n', `X:1\n%caption: Цепочка от звука ${M.noteName(start)}: ${steps.map((s) => (s.dir === 'up' ? '↑' : '↓') + s.code).join(', ')}\n`).replace(/^K:C$/m, 'K:C clef=treble')
  }];
}

/* ---------------------------- последовательность аккордов ---------------------------- */

const CHORD_TOKEN = /^(ум|ув|Ум|Ув|М|Б|м|б)?(DD|ДД|K|К|N|VII|VI|IV|V|III|II|I|[TtSsDdТтСсДд])(53|64|65|43|6|7|2)?(\(без5\)|\(г\))*$/;

function parseSeqToken(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  const m = CHORD_TOKEN.exec(s);
  if (!m) return null;
  const noFifth = /\(без5\)/.test(s);
  const harmonic = /\(г\)/.test(s);
  const tok = P.parseChordToken((m[1] || '') + m[2] + (m[3] || ''));
  if (!tok) return null;
  return { ...tok, noFifth, harmonic, label: (m[1] || '') + m[2] + (m[3] || '') };
}

const SUBS = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const subL = (label) => String(label).replace(/(\d+)$/, (d) => d.split('').map((c) => SUBS[c]).join(''));

/* Тональности, в которых аккорд с такими же звуками стоит на нужной ступени. */
function keysForChord(notes, tok) {
  const want = notes.map((n) => n.step + ':' + n.alter).sort().join(',');
  const out = [];
  for (let step = 0; step < 7; step++) for (const alter of [-1, 0, 1]) for (const mode of ['major', 'minor']) {
    const key = { tonic: { step, alter }, mode };
    if (!M.isValidKey(key)) continue;
    for (const type of mode === 'minor' ? ['natural', 'harmonic'] : ['natural', 'harmonic']) {
      let built;
      try { built = M.chordInKey(key, type, tok.spec); } catch (e) { continue; }
      const got = built.members.map((n) => n.step + ':' + n.alter).sort().join(',');
      if (got === want) { out.push({ key, type }); break; }
    }
  }
  return out;
}

function solveSequence(item, keysAt) {
  if (!keysAt.length) return [];
  const t = item.text;
  const after = t.slice(keysAt[0].end).replace(/^[^:]*:/, ' ');
  const parts = after.split(/\s*[–—]\s*|\s+-\s+|\s*-\s*(?=[IVKКумУМБTSDТСД])/).map((x) => x.trim().replace(/[.,;]+$/, '')).filter(Boolean);
  const toks = [];
  for (const p of parts) {
    if (/=/.test(p)) {
      const [a, b] = p.split('=').map((x) => parseSeqToken(x));
      if (!a || !b) break;
      toks.push({ pivot: true, a, b });
    } else {
      const tk = parseSeqToken(p);
      if (!tk) { if (toks.length) break; else continue; }
      toks.push(tk);
    }
  }
  if (toks.length < 3) return [];
  let key = keysAt[0].key;
  const items = [];
  const notesLines = [];
  let modulated = null;
  for (const tk of toks) {
    if (tk.pivot) {
      // звуки аккорда в текущей тональности → ищем тональность, где он стоит на ступени tk.b
      const type = M.defaultTypeFor(key, tk.a.spec, 'auto');
      const built = M.chordInKey(key, type, tk.a.spec);
      const cands = keysForChord(built.members, tk.b).filter((c) => !(c.key.tonic.step === key.tonic.step && c.key.tonic.alter === key.tonic.alter && c.key.mode === key.mode));
      cands.sort((x, y) => Math.abs(M.keySignature(x.key) - M.keySignature(key)) - Math.abs(M.keySignature(y.key) - M.keySignature(key)) || (x.key.mode === key.mode ? -1 : 1));
      items.push({ key, tok: tk.a, label: subL(tk.a.label) + (cands[0] ? '=' + subL(tk.b.label) : '') });
      if (cands[0]) { modulated = { from: key, to: cands[0].key, chord: built.members, a: tk.a.label, b: tk.b.label }; key = cands[0].key; }
      continue;
    }
    items.push({ key, tok: tk, label: subL(tk.label) + (tk.noFifth ? '⁻⁵' : ''), noFifth: tk.noFifth });
  }
  const startKey = keysAt[0].key;
  const r = P.buildChordSequence(items, { title: `${M.keyNameGerman(startKey)}: ${toks.map((x) => x.pivot ? x.a.label + '=' + x.b.label : x.label).join(' – ')}`, sigKey: startKey });
  if (r.error) return [{ text: `Последовательность в ${M.keyName(startKey)}: ${r.error}.` }];
  // Подробности по каждому аккорду: функция, звуки, разрешение.
  for (const it of items) {
    const type = it.tok.harmonic ? 'harmonic' : 'auto';
    const b = M.buildChordInKey(it.key, it.tok.spec, type);
    if (b.error) continue;
    notesLines.push(`${it.label.replace(/[₀-₉]/g, (c) => '0123456789'['₀₁₂₃₄₅₆₇₈₉'.indexOf(c)])} (${M.keyNameGerman(it.key)}): ${L(b.notes)} — ${b.quality}; ${b.inversion}; ступень ${b.degree}${it.noFifth ? '; без квинты (утроенная прима)' : ''}`);
  }
  const mod = modulated ? `\nМодуляция через общий аккорд: ${modulated.a} в ${M.keyNameGerman(modulated.from)} = ${modulated.b} в ${M.keyNameGerman(modulated.to)} (${L(modulated.chord.map((n) => ({ ...n, oct: 4 })))}). Дальше аккорды — уже в ${M.keyName(modulated.to)} (${M.keyNameGerman(modulated.to)}).` : '';
  return [{
    text: `Последовательность в ${M.keyName(startKey)} (${M.keyNameGerman(startKey)}), по цифровке:\n` + notesLines.map((l) => '— ' + l).join('\n') + mod +
      '\nПоём каждый аккорд арпеджио снизу вверх от баса; голосоведение (бас + три голоса):\n' + r.text,
    abc: r.abc
  }];
}

/* ---------------------------- ступени и интервалы по ступеням ---------------------------- */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function solveDegrees(item, keysAt) {
  const t = item.text;
  if (!keysAt.length || !/ступен/i.test(t)) return [];
  const key = keysAt[0].key;
  const after = t.slice(keysAt[0].end);
  const re = /(VII|VI|IV|V|III|II|I)(\s*\(\s*гарм[а-я.]*\s*\)|\s*\(\s*мелод[а-я.]*\s*\))?/g;
  const degs = [];
  let m;
  while ((m = re.exec(after))) degs.push({ d: ROMAN.indexOf(m[1]), type: /гарм/.test(m[2] || '') ? 'harmonic' : /мелод/.test(m[2] || '') ? 'melodic' : 'natural' });
  if (degs.length < 3) return [];
  const notes = degs.map((x) => { const sc = M.scaleNotes(key, x.type, 'up', 4); return sc[x.d]; });
  return [{ text: `Ступени в ${M.keyName(key)}: ${degs.map((x) => ROMAN[x.d] + (x.type !== 'natural' ? '(' + TYPE_RU[x.type].slice(0, 4) + '.)' : '')).join(' – ')} → ${L(notes)}.`, abc: M.toAbc({ title: 'Ступени', key, bars: [notes], length: '1/4' }).replace('X:1\n', `X:1\n%caption: Ступени в ${M.keyNameGerman(key)}\n`) }];
}

function solveIntervalDegrees(item, keysAt) {
  const t = item.text;
  if (!keysAt.length) return [];
  const key = keysAt[0].key;
  const after = t.slice(keysAt[0].end);
  const re = /((?:ч|м|б|ув|ум)\d{1,2})\s*(VII|VI|IV|V|III|II|I)(\s*\(?\s*гарм[а-я.]*\)?)?/g;
  const out = [];
  let m;
  while ((m = re.exec(after))) {
    const type = m[3] ? 'harmonic' : 'natural';
    const low = M.scaleNotes(key, type, 'up', 4)[ROMAN.indexOf(m[2])];
    const high = M.buildInterval(low, m[1], 'up');
    if (!high) continue;
    const r = M.resolveIntervalInKey(key, type, low, high);
    out.push({ code: m[1], deg: m[2], low, high, r });
  }
  if (out.length < 2) return [];
  const bars = out.map((x) => [[x.low, x.high]]);
  return [{
    text: `Интервалы по ступеням в ${M.keyName(key)}:\n` + out.map((x) => `— ${x.code} на ${x.deg}: ${L([x.low, x.high])}${x.r && !x.r.stable ? ` → ${x.r.toInterval.code} (${L(x.r.to)})` : ''}`).join('\n'),
    abc: M.toAbc({ title: 'Интервалы', key, bars, noteLen: '2' }).replace('X:1\n', `X:1\n%caption: Интервалы по ступеням в ${M.keyNameGerman(key)}\n`)
  }];
}

/* ---------------------------- точка входа ---------------------------- */

/* Похоже ли на задание/билет с несколькими пунктами. */
export function looksLikeTicket(text) {
  const t = normalizeTaskText(text);
  const items = splitTaskItems(t);
  const signals = (/билет|задани|спеть|сыграть|построить|по\s+цепочке|по\s+цифровке|разрешени/i.test(t) ? 1 : 0) + (items.length >= 2 ? 1 : 0) + (/[↑↓]/.test(t) ? 1 : 0);
  return signals >= 2;
}

/* → [{label, text, abc}] — решённые пункты. */
export function solveTasks(text) {
  const t = normalizeTaskText(text);
  const items = splitTaskItems(t);
  const out = [];
  for (const it of items) {
    const keysAt = findKeysAt(it.text);
    let res = [];
    try {
      res = res.concat(solveSequence(it, keysAt));
      if (!res.length) res = res.concat(solveChain(it));
      if (!res.length) res = res.concat(solveIntervalsInKey(it, keysAt));
      if (!res.length) res = res.concat(solveScales(it, keysAt));
      if (!res.length) res = res.concat(solveDegrees(it, keysAt));
      if (!res.length) res = res.concat(solveIntervalDegrees(it, keysAt));
    } catch (e) {
      console.warn('[music-tasks] item failed:', e?.message);
    }
    for (const r of res) out.push({ label: it.label, task: it.text.slice(0, 220), ...r });
  }
  return out;
}
