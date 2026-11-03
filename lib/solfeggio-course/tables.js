/* Справочные таблицы курса — целиком считаются музыкальным ядром при загрузке
   модуля (ни одной ноты вручную). Попадают в ответ, только когда просят
   таблицу / «во всех тональностях» по конкретной теме. */
import { key, kn, kg, chord, ivlAt, T } from './helpers.js';

const MAJORS = ['C', 'G', 'D', 'A', 'E', 'H', 'Fis', 'Cis', 'F', 'B', 'Es', 'As', 'Des', 'Ges', 'Ces'];
const minorOf = (g) => { const r = T.relativeKey(key(g)); return T.keyNameGerman(r).replace('-moll', ''); };
const signs = (g) => { const n = T.keySignature(key(g)); return n === 0 ? 'без знаков' : `${Math.abs(n)}${n > 0 ? '♯' : '♭'}`; };
const ALL = (/* табличный вопрос */) => '(?:таблиц|во\\s+всех|все\\s+тональност|в\\s+каждой|по\\s+всем|список|перечисли)';
const re = (topic) => new RegExp(`(?=[\\s\\S]*${ALL()})(?=[\\s\\S]*(?:${topic}))`);

function rows(fn) { return MAJORS.map(fn).join('\n'); }

export default [
  {
    id: 't-keys', grades: [2, 3, 4, 5, 6, 7, 8, 9], title: 'Таблица: все тональности, знаки, параллели', table: true,
    re: re('ключев[а-яё]*\\s+знак|знак[а-яё]*\\s+(?:в\\s+)?(?:ключ|тональност)|параллельн|буквенн|какие\\s+(?:есть\\s+)?тональност|сколько\\s+знаков'),
    text: 'Мажор (буквенное) / параллельный минор — ключевые знаки:\n' + rows((g) => `${kn(g)} (${kg(g)}) / ${kn(minorOf(g))} (${minorOf(g)}-moll) — ${signs(g)}`)
  },
  {
    id: 't-main', grades: [3, 4, 5, 6], title: 'Таблица: главные трезвучия T, S, D', table: true,
    re: re('главн|трезвучи|\\bt\\b|\\bs\\b|\\bd\\b|тоник|субдоминант'),
    text: 'Мажор: T | S | D; гармонический минор: t | s | D.\n' + rows((g) => {
      const m = minorOf(g);
      return `${kn(g)}: ${chord(g, 'T53')} | ${chord(g, 'S53')} | ${chord(g, 'D53')}; ${kn(m)}: ${chord(m, 'T53')} | ${chord(m, 'S53')} | ${chord(m, 'D53', 'harmonic')}`;
    })
  },
  {
    id: 't-d7', grades: [4, 5, 6, 7, 8], title: 'Таблица: D7 во всех тональностях', table: true,
    re: re('d7|д7|доминантсепт|доминант[а-яё]*\\s+септ'),
    text: 'D7 одинаков в мажоре и одноимённом (гармоническом) миноре (если такой минор существует):\n' + rows((g) => `${kn(g)}${T.isValidKey(key(g.toLowerCase())) ? ' / ' + kn(g.toLowerCase()) : ''}: ${chord(g, 'D7')}`)
  },
  {
    id: 't-vii7', grades: [5, 6, 7, 8], title: 'Таблица: вводные септаккорды', table: true,
    re: re('vii7|вводн|уменьш[её]нн[а-яё]*\\s+септ'),
    text: 'МVII7 — натуральный мажор; УмVII7 — гармонический мажор и одноимённый гармонический минор:\n' + rows((g) => `${kn(g)}: МVII7 ${chord(g, 'МVII7')}; УмVII7 ${chord(g, 'умVII7', 'harmonic')}`)
  },
  {
    id: 't-tritones', grades: [5, 6, 7, 8], title: 'Таблица: тритоны с разрешением', table: true,
    re: re('тритон|ув\\.?\\s?4|ум\\.?\\s?5'),
    text: 'Натуральный мажор (ув4 на IV, ум5 на VII) и параллельный гармонический минор (ув4 на IV, ум5 на ♯VII):\n' + rows((g) => {
      const m = minorOf(g);
      return `${kn(g)}: ${ivlAt(g, 'natural', 'ув4', 'IV')}; ${ivlAt(g, 'natural', 'ум5', 'VII')} | ${kn(m)}: ${ivlAt(m, 'harmonic', 'ув4', 'IV')}; ${ivlAt(m, 'harmonic', 'ум5', 'VII')}`;
    })
  },
  {
    id: 't-characteristic', grades: [6, 7, 8, 9], title: 'Таблица: характерные интервалы в гармоническом миноре', table: true,
    re: re('характерн|ув\\.?\\s?2|ум\\.?\\s?7|ув\\.?\\s?5|ум\\.?\\s?4'),
    text: 'Гармонический минор — ув2 (VI), ум7 (♯VII), ув5 (III), ум4 (♯VII), с разрешением:\n' + MAJORS.map((g) => {
      const m = minorOf(g);
      return `${kn(m)}: ${ivlAt(m, 'harmonic', 'ув2', 'VI')}; ${ivlAt(m, 'harmonic', 'ум7', 'VII')}; ${ivlAt(m, 'harmonic', 'ув5', 'III')}; ${ivlAt(m, 'harmonic', 'ум4', 'VII')}`;
    }).join('\n')
  }
];
