import test from 'node:test';
import assert from 'node:assert/strict';
import { solveTasks, looksLikeTicket, normalizeTaskText } from '../lib/music-tasks.js';

const TICKET = `Экзаменационный билет № 1.
1. Теория: А) Спеть ↑ a moll натур., ↓ A dur мелодич.
Б) Спеть в A dur все увеличенные интервалы с разрешением (тритоны и характерные).
В) Спеть от звука a по цепочке: ↑ Б₆, ↓ Ув ₅₃.
Г) В тональности fis moll спеть и объяснить: I ₅₃ – II₂ – ум VIIᵍ₇ – V₆₅ - I ₅₃ – [VI₆ = III₆] – К ₆₄ – V₇ – I ⁻⁵ ₅₃.
2. Пение с листа: А) 1-голосие с дирижир.
3. Практика: Подбор аккомпанемента «с листа».`;

test('нормализация значков с фото', () => {
  const t = normalizeTaskText(TICKET);
  assert.match(t, /умVII7\(г\)/);
  assert.match(t, /I53\(без5\)/);
  assert.match(t, /Ув53/);
});

test('билет решается по пунктам', () => {
  assert.equal(looksLikeTicket(TICKET), true);
  const r = solveTasks(TICKET);
  const by = (l) => r.filter((x) => x.label === l).map((x) => x.text).join('\n');
  assert.match(by('А)'), /Ля – Си – До – Ре – Ми – Фа – Соль – Ля/);
  assert.match(by('А)'), /мелодический вид — вниз: Ля – Соль – Фа – Ми – Ре – До-диез – Си – Ля/);
  assert.match(by('Б)'), /ув4 на IV ступени .*Ре – Соль-диез → м6/);
  assert.match(by('Б)'), /ув2 на VI ступени .*Фа – Соль-диез → ч4/);
  assert.match(by('В)'), /↑Б6 от Ля.*Ля – До – Фа/);
  assert.match(by('В)'), /↓Ув53 от Фа.*Фа – Ре-бемоль – Си-дубль-бемоль/);
  const g = by('Г)');
  assert.match(g, /умVII7 \(fis-moll\): Ми-диез – Соль-диез – Си – Ре/);
  assert.match(g, /VI6 в fis-moll = III6 в h-moll/);
  assert.match(g, /V7 \(h-moll\): Фа-диез – Ля-диез – До-диез – Ми/);
});
