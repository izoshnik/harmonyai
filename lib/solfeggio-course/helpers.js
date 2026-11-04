/* Помощники курса: ноты, тональности, аккорды и интервалы считает музыкальное
   ядро (lib/music-theory.js) — примеры в главах не набираются вручную, поэтому
   в них не может оказаться ошибочной ноты. Тональности и звуки задаются
   буквами: 'C' — До мажор, 'a' — ля минор, 'Fis', 'es', 'B' (си-бемоль), 'H'. */
import * as T from '../music-theory.js';

const STEP = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, h: 6 };

export function key(g) {
  const minor = g[0] === g[0].toLowerCase();
  const s = g.toLowerCase();
  let step; let alter = 0;
  if (s === 'b') { step = 6; alter = -1; } else {
    step = STEP[s[0]];
    const rest = s.slice(1);
    if (rest === 'is') alter = 1; else if (rest === 'isis') alter = 2;
    else if (rest === 'es' || rest === 's') alter = -1; else if (rest === 'eses' || rest === 'ses') alter = -2;
  }
  if (step == null) throw new Error('bad key ' + g);
  return { tonic: { step, alter }, mode: minor ? 'minor' : 'major' };
}
export const pitch = (g, oct = 4) => { const k = key(g.toUpperCase() === g ? g : g[0].toUpperCase() + g.slice(1)); return T.note(k.tonic.step, k.tonic.alter, oct); };

export function nm(x) {
  return T.noteName(x).toLowerCase()
    .replace('-дубль-диез', '𝄪').replace('-дубль-бемоль', '𝄫').replace('-диез', '♯').replace('-бемоль', '♭');
}
export const seq = (arr) => arr.map(nm).join('–');
// «Соль мажор», «ми минор» (минор — со строчной, как в учебниках).
export const kn = (g) => { const k = key(g); const n = T.keyName(k); return k.mode === 'minor' ? n[0].toLowerCase() + n.slice(1) : n; };
export const kg = (g) => T.keyNameGerman(key(g));                 // «G-dur»
export const scale = (g, type = 'natural', dir = 'up') => T.scaleNotes(key(g), type, dir).map(nm).join(' ');

/* Аккорд в тональности: «ре–фа♯–ля–до». */
export function chord(g, code, type = 'auto') {
  return seq(T.buildChordInKey(key(g), code, type).notes);
}
/* Аккорд с разрешением: «соль–си–ре–фа → до–до–до–ми». */
export function chordRes(g, code, type = 'auto') {
  const r = T.buildChordInKey(key(g), code, type);
  const steps = (r.resolutions && r.resolutions[0] && r.resolutions[0].steps) || [];
  return [seq(r.notes), ...steps.map((s) => seq(s.to))].join(' → ');
}
/* Интервал в тональности с разрешением: «фа–си → ми–до». */
export function ivl(g, type, code) {
  return T.intervalsInKey(key(g), type, code).map((x) => {
    const to = x.resolution && x.resolution.to;
    return `${nm(x.low)}–${nm(x.high)}` + (to ? ` → ${nm(to[0])}–${nm(to[1])}` : '');
  }).join('; ');
}
/* Интервал на конкретной ступени: ivlAt('a','harmonic','ув4','IV') → «ре–соль♯ → до–ля». */
export function ivlAt(g, type, code, deg) {
  return T.intervalsInKey(key(g), type, code).filter((x) => x.degrees && x.degrees[0] === deg).map((x) => {
    const to = x.resolution && x.resolution.to;
    return `${nm(x.low)}–${nm(x.high)}` + (to ? ` → ${nm(to[0])}–${nm(to[1])}` : '');
  }).join('; ');
}
/* Интервал от звука: «ми–соль♯». */
export function up(n, code) { const p = pitch(n); return `${nm(p)}–${nm(T.buildInterval(p, code, 'up'))}`; }
export function down(n, code) { const p = pitch(n); return `${nm(p)}–${nm(T.buildInterval(p, code, 'down'))}`; }
/* Аккорд от звука (первый вариант ядра): «ля–до♯–ми–соль». */
export function fromNote(n, code) {
  const r = T.buildChordFromNote(pitch(n), code);
  const v = r && (r.variants ? r.variants[0] : r);
  return v && v.notes ? seq(v.notes) : '';
}
/* Тональности, где аккорд от звука встречается: «Ре мажор, ре минор». */
export function keysOf(n, code) {
  const r = T.buildChordFromNote(pitch(n), code);
  const low = (n) => (/ минор$/.test(n) ? n[0].toLowerCase() + n.slice(1) : n);
  return [...new Set(((r && r.variants) || []).map((v) => low(v.key)))].join(', ');
}
export { T };
