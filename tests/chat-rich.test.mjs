import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/hm-rich.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, children: [], setAttribute() {},
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); }
  };
}
function loadRich() {
  const window = {};
  vm.runInNewContext(source, { window, document: { createElement: element }, URL, URLSearchParams });
  return window.HmRich;
}

test('systems and boxed answers survive markdown with their LaTeX commands preserved', () => {
  const rich = loadRich();
  const raw = String.raw`**ОДЗ**

$$\begin{cases}x+3\ge 0\\7-x\ge 0\end{cases}$$

\boxed{x\in[-3;6)}`;
  const html = rich.mdToHtml(raw);
  assert.match(html, /hm-tex-cases/);
  assert.match(html, /hm-tex-box/);
  assert.match(html, /data-tex="\\begin\{cases\}/);
  assert.doesNotMatch(html.replace(/data-tex="[^"]*"/g, ''), /begincases|boxedx/);
  const bare = rich.mdToHtml(String.raw`Дано

k_{\text{общ}}=300+600=900\text{ Н/м}`);
  assert.match(bare, /data-tex="k_\{\\text\{общ\}\}=300\+600=900\\text\{ Н\/м\}"/);
});

test('route links preserve the order, mode and intermediate points of a route', () => {
  const rich = loadRich();
  const host = element('div');
  const points = ['Москва, Красная площадь', 'Москва, Зарядье', 'Москва, Китай-город'];
  const card = rich.render('route', JSON.stringify({ mode: 'walking', points }), host);
  const [yandex, google] = card.children.at(-1).children.slice(1).map(link => new URL(link.href));
  assert.equal(yandex.host, 'yandex.ru');
  assert.equal(yandex.searchParams.get('rtext'), points.join('~'));
  assert.equal(yandex.searchParams.get('rtt'), 'pd');
  assert.equal(google.host, 'www.google.com');
  assert.equal(google.searchParams.get('origin'), points[0]);
  assert.equal(google.searchParams.get('destination'), points[2]);
  assert.equal(google.searchParams.get('waypoints'), points[1]);
  assert.equal(google.searchParams.get('travelmode'), 'walking');
});

test('an answer can interleave a solution, multiple graphs and a geometry figure', () => {
  const rich = loadRich();
  const input = ['### Решение','~~~chart','{}','~~~','Пересечения','~~~chart','{}','~~~','~~~figure','{}','~~~'].join('\n').replaceAll('~~~','\x60\x60\x60');
  assert.equal(rich.splitRich(input).filter(part => part.kind).map(part => part.kind).join(','), 'chart,chart,figure');
});
