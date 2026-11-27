import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/hm-rich.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, children: [], setAttribute() {}, addEventListener() {},
    style: { setProperty() {} },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); }
  };
}
function loadRich() {
  const window = {};
  vm.runInNewContext(source, { window, document: { createElement: element }, console });
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

test('an answer can interleave a solution, multiple graphs and a geometry figure', () => {
  const rich = loadRich();
  const input = ['### Решение','~~~chart','{}','~~~','Пересечения','~~~chart','{}','~~~','~~~figure','{}','~~~'].join('\n').replaceAll('~~~','\x60\x60\x60');
  assert.equal(rich.splitRich(input).filter(part => part.kind).map(part => part.kind).join(','), 'chart,chart,figure');
});

test('a graph marks a branch boundary, intersection, asymptote and axis units', () => {
  const rich = loadRich();
  const card = rich.render('chart', JSON.stringify({
    x: [-3, 3], y: [-4, 4], xLabel: 't, с', yLabel: 's, м',
    functions: [{ expr: 'x', domain: [-1, 2], openStart: true }, { expr: '1/x', breaks: [0] }],
    points: [{ x: 1, y: 1, label: 'A (1; 1)' }],
    guides: [{ axis: 'x', value: 0, label: 'x = 0' }]
  }), element('div'));
  const svg = card.children[0].innerHTML;
  assert.match(svg, /hmr-plot-guide.*x = 0/);
  assert.match(svg, /hmr-plot-point.*A \(1; 1\)/);
  assert.match(svg, /hmr-plot-end[^>]+fill="var\(--bg2\)"/);
  assert.match(svg, /hmr-plot-end[^>]+fill="#4f7cff"/);
  assert.match(svg, /d="M[^"M]+M[^"M]+" fill="none" stroke="#f97316"/);
  assert.match(svg, /t, с/);
  assert.match(svg, /s, м/);
});

test('a spring system and a geometry figure render from exact coordinates', () => {
  const rich = loadRich();
  const physics = rich.render('figure', JSON.stringify({
    springs: [{ from: [0, 2], to: [3, 2], label: 'k₁' }, { from: [3, 2], to: [5, 2], label: 'k₂' }],
    supports: [{ from: [0, 0], to: [0, 3] }]
  }), element('div'));
  const svg = physics.children[0].innerHTML;
  assert.equal((svg.match(/hmr-fig-spring/g) || []).length, 2);
  assert.match(svg, /hmr-fig-support/);
  assert.match(svg, /k₁/);
  const geometry = rich.render('figure', JSON.stringify({
    points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 4, y: 0 }, { id: 'C', x: 0, y: 3 }],
    polygons: [{ points: ['A', 'B', 'C'] }],
    angles: [{ vertex: 'A', from: 'B', to: 'C', right: true }]
  }), element('div'));
  assert.match(geometry.children[0].innerHTML, /hmr-fig-poly.*hmr-fig-ang/);
});

test('school charts and diagrams use the interactive renderer by default', () => {
  const rich = loadRich();
  for (const request of ['Построй график y = x²', 'Нарисуй чертёж треугольника', 'Изобрази схему соединения пружин']) {
    assert.equal(rich.isTechnicalVisualRequest(request), true, request);
  }
  assert.equal(rich.isTechnicalVisualRequest('Нарисуй кота на дереве'), false);
});

test('fallback LaTeX suppresses delimiter and space commands when CDN rendering is unavailable', () => {
  const html=loadRich().mdToHtml('$$\\bigl(\\sqrt{7-x}\\bigr)\\qquad a$$');
  const visible=html.replace(/data-tex="[^"]*"/g,'');
  assert.doesNotMatch(visible,/bigl|bigr|qquad/);
  assert.match(visible,/hm-tsqrt/);
});

test('explicit MP3 upload wins over a stem classifier false positive', async () => {
  const app=readFileSync(new URL('../app.html',import.meta.url),'utf8');
  const start=app.indexOf('async function hmAgentRoute(text)');
  const script=app.slice(start,app.indexOf('/* ИИ ДОБАВЛЯЕТ ТРЕК',start));
  const actions=[];
  const route=vm.runInNewContext(script+';hmAgentRoute',{
    pendingAttachments:[{kind:'audio',name:'test.mp3'}],
    hmRecentAudioList:()=>[],window:{MusicClient:{},HmStems:{parse:()=>true}},
    hmAgentRun:async action=>actions.push(action)
  });
  assert.equal(await route('Загрузи только приложенный тестовый MP3 в Яндекс Музыку. Это синтетический файл.'),true);
  assert.equal(await route('Убери вокал из приложенного MP3.'),true);
  assert.deepEqual(actions,['upload_track','separate_stems']);
});
