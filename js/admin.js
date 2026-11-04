/* Панель управления сервисом (/management). Данные — /api/account?action=admin.*
   (lib/admin.js), графики — собственные SVG без библиотек. Все строки из базы
   (почты, ники, тексты ошибок) вставляются через esc() или textContent. */
(function () {
  'use strict';
  const $main = () => document.getElementById('admMain');
  const tipEl = () => document.getElementById('admTip');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('ru-RU');
  const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '—' : nf.format(Math.round(Number(n))));
  const fmt1 = (n, d = 1) => (n == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: d }).format(Number(n)));
  const compact = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n)));
  const rub = (n, d = 0) => (n == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d }).format(Number(n)) + ' ₽');
  const rubSmart = (n) => (n == null ? '—' : Math.abs(n) < 10 ? rub(n, 2) : rub(n));
  const usd = (n) => (n == null ? '—' : '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 }).format(Number(n)));
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : '—');
  const dt = (s) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const dshort = (s) => { const d = new Date(String(s).length === 10 ? s + 'T12:00:00' : s); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); };
  const ago = (s) => {
    if (!s) return '—';
    const m = Math.round((Date.now() - Date.parse(s)) / 60000);
    if (m < 2) return 'сейчас';
    if (m < 60) return m + ' мин назад';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' ч назад';
    const d = Math.round(h / 24);
    return d < 31 ? d + ' дн назад' : dt(s);
  };
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  const SOURCE_NAMES = { chat: 'Чат', api: 'Публичный API', image: 'Картинки', video_gen: 'Генерация видео', video_watch: 'Просмотр видео', recognize: 'Распознавание музыки', memory: 'Память', music: 'Музыка', client: 'Браузер', support: 'Поддержка' };
  const KIND_NAMES = { timeout: 'Таймаут', unavailable: 'Модель недоступна', quota: 'Лимит провайдера', network: 'Сеть', policy: 'Правила контента', internal: 'Внутренняя', request: 'Запрос', config: 'Настройка сервера', user_report: 'Сообщение пользователя', other: 'Другое' };
  const MODEL_NAMES = { adanatos: 'Adan', dynatos: 'Dynatos', image: 'Картинки', video_gen: 'Видео' };
  const srcName = (s) => SOURCE_NAMES[s] || s || '—';

  let ROLE = '', FULL = false, USD_RUB = 95;
  let seq = 0;
  const state = { days: { usage: 30, api: 30, errors: 7, finance: 30, providers: 7, features: 30, feedback: 30 }, users: { q: '', filter: 'all', sort: 'created', page: 0 }, errorsQ: '' };

  async function api(action, query, body) {
    const r = await window.hmAuth.account('admin.' + action, body || null, query || null);
    if (!r.ok) {
      const e = new Error(r.error || 'Не удалось загрузить данные');
      e.migration = Boolean(r.data && r.data.error && r.data.error.migration);
      e.status = r.status;
      throw e;
    }
    if (r.data && r.data.role) { ROLE = r.data.role; FULL = ROLE === 'developer' || ROLE === 'admin'; }
    return r.data.data;
  }

  /* ---------------------------------------------------------------- подсказка */
  function showTip(ev, date, rows) {
    const t = tipEl();
    t.replaceChildren();
    if (date) { const d = document.createElement('div'); d.className = 'd'; d.textContent = date; t.appendChild(d); }
    rows.forEach((r) => {
      const row = document.createElement('div'); row.className = 'r';
      if (r.color) { const i = document.createElement('i'); i.style.background = r.color; row.appendChild(i); }
      const b = document.createElement('b'); b.textContent = r.value; row.appendChild(b);
      const s = document.createElement('span'); s.textContent = r.name || ''; row.appendChild(s);
      t.appendChild(row);
    });
    t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY - h - 10;
    if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
    if (y < 8) y = ev.clientY + 16;
    t.style.left = Math.max(8, x) + 'px'; t.style.top = y + 'px';
  }
  const hideTip = () => { const t = tipEl(); if (t) t.hidden = true; };

  /* ---------------------------------------------------------------- графики
     Линии: 2px, общий перекрестный указатель, одна подсказка на все серии.
     Столбцы: скругление 4px сверху, зазор 2px, подсказка на каждом столбце. */
  // На телефоне — узкая система координат, чтобы подписи осей не мельчили.
  const W = (window.innerWidth || 1000) < 640 ? 380 : 640, H = (window.innerWidth || 1000) < 640 ? 200 : 220, PL = 44, PR = 10, PT = 10, PB = 26;
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function axes(max, labels, valueFmt) {
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const y = PT + (H - PT - PB) * (1 - i / 4);
      g += `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}"/><text x="${PL - 6}" y="${y + 4}" text-anchor="end">${esc(valueFmt(max * i / 4))}</text>`;
    }
    const n = labels.length, step = Math.max(1, Math.ceil(n / 7));
    labels.forEach((l, i) => {
      if (i % step && i !== n - 1) return;
      const x = n === 1 ? (PL + W - PR) / 2 : PL + (W - PL - PR) * i / (n - 1);
      g += `<text x="${x}" y="${H - 6}" text-anchor="middle">${esc(dshort(l))}</text>`;
    });
    return g;
  }
  function legend(series, box) {
    if (series.length < 2) return '';
    return '<div class="adm-legend">' + series.map((s, i) => `<span><i class="${box ? 'box' : ''}" style="background:${s.color || SERIES[i]}"></i>${esc(s.name)}</span>`).join('') + '</div>';
  }
  function lineChart(labels, series, opts = {}) {
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    if (!labels.length) return '<p class="adm-muted">Нет данных за период.</p>';
    const vf = opts.fmt || compact;
    const max = niceMax(Math.max(vf === fmt ? 4 : 0, ...series.flatMap((s) => s.values.map(Number)))); // счётчики — целые деления
    const n = labels.length;
    const X = (i) => (n === 1 ? (PL + W - PR) / 2 : PL + (W - PL - PR) * i / (n - 1));
    const Y = (v) => PT + (H - PT - PB) * (1 - Number(v || 0) / max);
    let paths = '';
    series.forEach((s, si) => {
      const color = s.color || SERIES[si];
      const d = s.values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
      if (si === 0 && opts.area !== false) paths += `<path d="${d} L${X(n - 1)} ${H - PB} L${X(0)} ${H - PB} Z" fill="${color}" opacity=".12"/>`;
      paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n <= 3) s.values.forEach((v, i) => { paths += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`; });
    });
    setTimeout(() => {
      const svg = document.getElementById(id);
      if (!svg) return;
      const hair = svg.querySelector('.hair');
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width * W;
        const i = Math.max(0, Math.min(n - 1, Math.round((x - PL) / ((W - PL - PR) / Math.max(1, n - 1)))));
        hair.setAttribute('x1', X(i)); hair.setAttribute('x2', X(i)); hair.style.display = '';
        showTip(ev, dshort(labels[i]), series.map((s, si) => ({ color: s.color || SERIES[si], name: s.name, value: vf(s.values[i]) })));
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerleave', () => { hair.style.display = 'none'; hideTip(); });
    }, 0);
    return legend(series) + `<svg class="adm-chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'График')}">${axes(max, labels, vf)}${paths}<line class="hair" y1="${PT}" y2="${H - PB}" style="display:none"/><rect class="hit" x="${PL}" y="0" width="${W - PL - PR}" height="${H}"/></svg>`;
  }
  function columnChart(labels, values, opts = {}) {
    if (!labels.length) return '<p class="adm-muted">Нет данных за период.</p>';
    const vf = opts.fmt || compact;
    const color = opts.color || SERIES[0];
    const max = niceMax(Math.max(vf === fmt ? 4 : 0, ...values.map(Number)));
    const n = labels.length, slot = (W - PL - PR) / n, bw = Math.max(2, Math.min(28, slot - 2));
    const Y = (v) => PT + (H - PT - PB) * (1 - Number(v || 0) / max);
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    let bars = '';
    values.forEach((v, i) => {
      const x = PL + slot * i + (slot - bw) / 2, y = Y(v), h = H - PB - y;
      if (h <= 0) { bars += `<rect class="hit" data-i="${i}" x="${x}" y="${PT}" width="${bw}" height="${H - PB - PT}"/>`; return; }
      const r = Math.min(4, bw / 2, h);
      bars += `<path class="bar" d="M${x} ${H - PB} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + bw - r} Q${x + bw} ${y} ${x + bw} ${y + r} V${H - PB} Z" fill="${color}"/><rect class="hit" data-i="${i}" x="${PL + slot * i}" y="${PT}" width="${slot}" height="${H - PB - PT}"/>`;
    });
    const axLabels = labels.map((l) => l);
    let ax = '';
    for (let i = 0; i <= 4; i++) { const y = PT + (H - PT - PB) * (1 - i / 4); ax += `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}"/><text x="${PL - 6}" y="${y + 4}" text-anchor="end">${esc(vf(max * i / 4))}</text>`; }
    const step = Math.max(1, Math.ceil(n / 7));
    axLabels.forEach((l, i) => { if (i % step && i !== n - 1) return; ax += `<text x="${PL + slot * i + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(opts.rawLabels ? l : dshort(l))}</text>`; });
    setTimeout(() => {
      const svg = document.getElementById(id);
      if (!svg) return;
      svg.querySelectorAll('.hit').forEach((h) => {
        h.addEventListener('pointermove', (ev) => { const i = Number(h.dataset.i); showTip(ev, opts.rawLabels ? labels[i] : dshort(labels[i]), [{ color, name: opts.name || '', value: vf(values[i]) }]); });
        h.addEventListener('pointerleave', hideTip);
      });
    }, 0);
    return `<svg class="adm-chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Диаграмма')}">${ax}${bars}</svg>`;
  }
  function hbars(items, opts = {}) {
    if (!items.length) return '<p class="adm-muted">Нет данных за период.</p>';
    const max = Math.max(...items.map((x) => Number(x.value) || 0)) || 1;
    const vf = opts.fmt || fmt;
    return '<div class="adm-hbars">' + items.map((x) => `<div class="adm-hbar" title="${esc(x.label)}: ${esc(vf(x.value))}"><span class="k">${esc(x.label)}</span><span class="t"><i style="width:${Math.max(1, (Number(x.value) || 0) / max * 100)}%;background:${x.color || opts.color || SERIES[0]}"></i></span><span class="x">${esc(vf(x.value))}${x.extra ? ' <span class="adm-muted">' + esc(x.extra) + '</span>' : ''}</span></div>`).join('') + '</div>';
  }
  function split(items) {
    const total = items.reduce((a, b) => a + (Number(b.value) || 0), 0);
    if (!total) return '<p class="adm-muted">Нет данных.</p>';
    return legend(items.map((x, i) => ({ name: `${x.label} · ${fmt(x.value)} (${pct(x.value, total)})`, color: x.color || SERIES[i] })), true)
      + '<div class="adm-split">' + items.filter((x) => Number(x.value) > 0).map((x, i) => `<i style="flex:${Number(x.value)};background:${x.color || SERIES[items.indexOf(x)]}" title="${esc(x.label)}: ${fmt(x.value)}"></i>`).join('') + '</div>';
  }
  function heat(cells) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    (cells || []).forEach((c) => { const v = Number(c.n) || 0; grid[(c.dow || 1) - 1][c.h || 0] += v; max = Math.max(max, grid[(c.dow || 1) - 1][c.h || 0]); });
    if (!max) return '<p class="adm-muted">Нет данных за период.</p>';
    const steps = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    let h = '<div class="adm-heat"><span></span>' + Array.from({ length: 24 }, (_, i) => `<span>${i % 3 ? '' : i}</span>`).join('');
    grid.forEach((row, d) => {
      h += `<span>${days[d]}</span>` + row.map((v, hr) => `<i title="${days[d]}, ${hr}:00 — ${fmt(v)} сообщ." style="${v ? 'background:' + steps[Math.min(4, Math.floor(v / max * 4.999))] : ''}"></i>`).join('');
    });
    return h + '</div><p class="cap" style="margin-top:8px">Время московское. Чем ярче клетка — тем больше сообщений.</p>';
  }
  function table(cols, rows, opts = {}) {
    if (!rows.length) return `<p class="adm-muted">${esc(opts.empty || 'Пока пусто.')}</p>`;
    return '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' + cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.t)}</th>`).join('') + '</tr></thead><tbody>'
      + rows.map((r, i) => `<tr${opts.rowAttr ? ' ' + opts.rowAttr(r, i) : ''}>` + cols.map((c) => `<td class="${[c.num ? 'num' : '', c.cls || ''].join(' ')}">${c.html ? c.html(r) : esc(c.v(r))}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  const tile = (l, v, n = '') => `<div class="adm-tile"><div class="l">${esc(l)}</div><div class="v" title="${esc(v)}">${esc(v)}</div>${n ? `<div class="n">${esc(n)}</div>` : ''}</div>`;
  const quad = (l, o, labels = ['час', 'день', 'неделя', 'месяц'], keys = ['hour', 'day', 'week', 'month']) =>
    `<div class="adm-tile"><div class="l">${esc(l)}</div><div class="quad">${keys.map((k, i) => `<div><b>${fmt(o && o[k])}</b><span>${labels[i]}</span></div>`).join('')}</div></div>`;
  const card = (title, body, cap = '') => `<section class="adm-card"><h2>${esc(title)}</h2>${cap ? `<p class="cap">${esc(cap)}</p>` : '<p class="cap"></p>'}${body}</section>`;
  const badgePlan = (u) => {
    const role = String(u.role || '').toLowerCase();
    if (['developer', 'admin', 'moderator'].includes(role)) return `<span class="adm-badge staff">${esc(role)}</span>`;
    return u.pro ? '<span class="adm-badge pro">Pro</span>' : '<span class="adm-badge">Free</span>';
  };
  const daysSelect = (sec, opts = [7, 30, 90, 365]) => `<select data-days="${sec}" aria-label="Период">${opts.map((d) => `<option value="${d}"${state.days[sec] === d ? ' selected' : ''}>${d === 365 ? 'Год' : d === 1 ? 'Сутки' : d + ' дней'}</option>`).join('')}</select>`;
  const head = (title, sub, bar = '') => `<h1 class="adm-h1">${esc(title)}</h1><p class="adm-sub">${esc(sub)}</p>${bar ? `<div class="adm-bar">${bar}</div>` : ''}`;
  const toRub = (usdv) => Number(usdv || 0) * USD_RUB;

  /* ---------------------------------------------------------------- разделы */
  const SECTIONS = {
    async overview() {
      const d = await api('overview');
      USD_RUB = d.usdRub || USD_RUB;
      const s = d.series || [];
      const plans = d.plans || {};
      return head('Общая статистика', 'Пользователи, активность и нагрузка. «День» — с полуночи по Москве, остальные периоды — скользящие.')
        + (d.logSince ? '' : '<div class="adm-note">Подробный учёт запросов (себестоимость, задержки, ошибки) начнётся сразу после выполнения SQL-миграции и первых сообщений. Сообщения и регистрации ниже — из уже существующих таблиц.</div>')
        + '<div class="adm-grid">'
        + tile('Всего пользователей', fmt(d.usersTotal), `Pro: ${fmt(d.pro)} · персонал: ${fmt(d.staff)}`)
        + tile('Онлайн сейчас', fmt(d.online), 'Активность за последние 90 секунд')
        + quad('Новые пользователи', d.usersNew)
        + quad('Активные пользователи', d.usersActive)
        + tile('Сообщений сегодня', fmt(d.messages?.day), `неделя: ${fmt(d.messages?.week)} · месяц: ${fmt(d.messages?.month)}`)
        + tile('Сообщений всего', fmt(d.messages?.total))
        + tile('Токенов сегодня', compact(d.tokens?.day), `месяц: ${compact(d.tokens?.month)} · всего: ${compact(d.tokens?.total)}`)
        + tile('Запросов к моделям за 24 ч', fmt(d.requestsDay), `ошибок: ${fmt(d.errorsDay)}`)
        + tile('Пользователей API за 30 дн', fmt(d.apiUsersMonth))
        + (FULL ? tile('Доход за 30 дней', rub((d.revenueMonthKop || 0) / 100)) + tile('Себестоимость за 30 дней', rubSmart(toRub(d.costMonthUsd)), usd(d.costMonthUsd)) : '')
        + tile('Время в приложении', d.activeSeconds == null ? '—' : fmt(d.activeSeconds / 3600) + ' ч', 'Суммарно у всех пользователей')
        + tile('Файлы', fmt(d.filesProcessed), `обработано · создано: ${fmt(d.filesCreated)}`)
        + tile('Распознавания музыки', fmt(d.recognized))
        + tile('Заблокировано', fmt(d.blocked))
        + '</div><div class="adm-cards">'
        + card('Регистрации и активные пользователи', lineChart(s.map((x) => x.d), [{ name: 'Активные', values: s.map((x) => x.active) }, { name: 'Регистрации', values: s.map((x) => x.reg) }], { fmt, label: 'Регистрации и активные за 30 дней' }), 'Последние 30 дней')
        + card('Сообщения в чате по дням', columnChart(s.map((x) => x.d), s.map((x) => x.messages), { fmt, name: 'сообщений' }), 'Последние 30 дней')
        + '</div><div class="adm-cards">'
        + card('Тарифы', split([{ label: 'Free', value: plans.free, color: 'var(--series-1)' }, { label: 'Pro', value: plans.pro, color: 'var(--series-2)' }, { label: 'Персонал', value: plans.staff, color: 'var(--series-3)' }]), 'Все зарегистрированные аккаунты')
        + '</div>';
    },

    async users() {
      const u = state.users;
      const d = await api('users', { q: u.q, filter: u.filter, sort: u.sort, page: u.page });
      const pages = Math.max(1, Math.ceil((d.total || 0) / 50));
      const bar = `<input type="search" id="admUserQ" placeholder="Почта, ник или id" value="${esc(u.q)}" aria-label="Поиск">`
        + `<select id="admUserF" aria-label="Фильтр">${[['all', 'Все'], ['pro', 'Pro'], ['free', 'Free'], ['staff', 'Персонал'], ['api', 'Пользуются API'], ['blocked', 'Заблокированные']].map(([v, t]) => `<option value="${v}"${u.filter === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`
        + `<select id="admUserS" aria-label="Сортировка">${[['created', 'Сначала новые'], ['active', 'Недавно активные'], ['messages', 'Больше сообщений'], ['cost', 'Дороже обходятся']].map(([v, t]) => `<option value="${v}"${u.sort === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
      const rows = d.rows || [];
      setTimeout(() => {
        const q = document.getElementById('admUserQ');
        let t = null;
        q && q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { u.q = q.value.trim(); u.page = 0; render(); }, 350); });
        const f = document.getElementById('admUserF'); f && (f.onchange = () => { u.filter = f.value; u.page = 0; render(); });
        const so = document.getElementById('admUserS'); so && (so.onchange = () => { u.sort = so.value; u.page = 0; render(); });
        document.querySelectorAll('[data-user]').forEach((tr) => { tr.onclick = () => { location.hash = '#user/' + tr.dataset.user; }; tr.onkeydown = (e) => { if (e.key === 'Enter') location.hash = '#user/' + tr.dataset.user; }; });
        const pv = document.getElementById('admPrev'); pv && (pv.onclick = () => { u.page = Math.max(0, u.page - 1); render(); });
        const nx = document.getElementById('admNext'); nx && (nx.onclick = () => { u.page = Math.min(pages - 1, u.page + 1); render(); });
      }, 0);
      return head('Пользователи', `Найдено: ${fmt(d.total)}. Нажмите на пользователя, чтобы открыть полную статистику.`, bar)
        + table([
          { t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' },
          { t: 'Ник', v: (r) => r.nickname || '—' },
          { t: 'ID', html: (r) => `<span class="mono">${esc(String(r.id).slice(0, 8))}…</span>` },
          { t: 'Тариф', html: (r) => badgePlan(r) + (r.blocked ? ' <span class="adm-badge blocked">блок</span>' : '') },
          { t: 'Сообщения', v: (r) => fmt(r.messages), num: true },
          { t: 'Токены', v: (r) => compact(r.tokens), num: true },
          { t: '≈ Расход', v: (r) => rubSmart(toRub(r.cost_usd)), num: true },
          { t: 'Активность', v: (r) => ago(r.last_active), num: true },
          { t: 'Регистрация', v: (r) => dt(r.created_at), num: true }
        ], rows, { rowAttr: (r) => `class="click" tabindex="0" data-user="${esc(r.id)}"`, empty: 'Никого не найдено.' })
        + `<div class="adm-pager"><button class="adm-btn" id="admPrev"${u.page ? '' : ' disabled'}>←</button><span>Страница ${u.page + 1} из ${pages}</span><button class="adm-btn" id="admNext"${u.page + 1 < pages ? '' : ' disabled'}>→</button></div>`;
    },

    async user(id) {
      const d = await api('user', { id });
      USD_RUB = d.usdRub || USD_RUB;
      const p = d.profile || {}, t = d.totals || {}, c = d.cost || {}, a = d.api || {};
      const role = String(p.role || '').toLowerCase();
      const staff = ['developer', 'admin', 'moderator'].includes(role);
      const badges = (staff ? `<span class="adm-badge staff">${esc(role)}</span>` : p.pro ? `<span class="adm-badge pro">Pro${p.planExpiresAt ? ' до ' + esc(dt(p.planExpiresAt)) : ' бессрочно'}</span>` : '<span class="adm-badge">Free</span>')
        + (p.blockedAt ? ` <span class="adm-badge blocked">заблокирован ${esc(dt(p.blockedAt))}</span>` : '');
      const actions = FULL ? `<div class="adm-actions">
          <input type="number" id="admProDays" min="1" max="3650" value="30" aria-label="Дней Pro"><button class="adm-btn" data-op="grant_pro">Выдать Pro</button>
          ${p.pro && !staff ? '<button class="adm-btn" data-op="revoke_pro">Снять Pro</button>' : ''}
          <button class="adm-btn" data-op="reset_limits">Сбросить лимит</button>
          ${p.blockedAt ? '<button class="adm-btn" data-op="unblock">Разблокировать</button>' : '<button class="adm-btn danger" data-op="block">Заблокировать</button>'}
        </div>` : '';
      setTimeout(() => {
        document.querySelectorAll('[data-op]').forEach((b) => {
          b.onclick = async () => {
            const op = b.dataset.op;
            const body = { target: id, op };
            if (op === 'grant_pro') body.days = Number(document.getElementById('admProDays').value) || 30;
            if (op === 'block') { const r = prompt('Причина блокировки (видна только персоналу):', ''); if (r === null) return; body.reason = r; }
            const names = { grant_pro: `выдать Pro на ${body.days} дн.`, revoke_pro: 'снять Pro', reset_limits: 'сбросить лимиты сообщений', unblock: 'разблокировать', block: 'заблокировать' };
            if (op !== 'block' && !confirm(`Точно ${names[op]} для ${p.email || id}?`)) return;
            b.disabled = true;
            const r = await window.hmAuth.account('admin.action', body);
            b.disabled = false;
            if (!r.ok) { alert(r.error || 'Не получилось'); return; }
            render();
          };
        });
        document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'скопировано'; setTimeout(() => { b.textContent = 'копировать'; }, 1200); }).catch(() => {}); }; });
      }, 0);
      const s = d.series || [];
      return `<a class="adm-back" href="#users">← Все пользователи</a>
        <div class="adm-user-head"><div class="who"><h1>${esc(p.email || '—')}</h1>
          <p>${p.nickname ? esc(p.nickname) + ' · ' : ''}<span class="mono">${esc(p.id)}</span><button class="adm-copy" data-copy="${esc(p.id)}">копировать</button></p>
          <p>${badges}</p>
          <p>Регистрация: ${esc(dt(p.createdAt))} · последний вход: ${esc(ago(p.lastSignInAt))} · вход через: ${esc(p.provider || 'email')}${p.limitsResetAt ? ' · лимит сброшен ' + esc(dt(p.limitsResetAt)) : ''}${p.blockedReason ? ' · причина блокировки: ' + esc(p.blockedReason) : ''}</p>
          <p>Обучение на его чатах: ${p.aiTraining === false ? 'выключено' : 'разрешено'}${d.referral?.invitedBy ? ' · пришёл по приглашению ' + esc(d.referral.invitedBy) : ''}</p>
        </div>${actions}</div>
        <div class="adm-grid">
          ${tile('Сообщений', fmt(t.messages), `токенов: ${compact(t.tokens)}`)}
          ${tile('≈ Потрачено на него', rubSmart(toRub(c.totalUsd)), `${usd(c.totalUsd)} · за 30 дн: ${rubSmart(toRub(c.monthUsd))}`)}
          ${FULL ? tile('Заплатил', rub((d.revenue?.totalKop || 0) / 100), `прибыль: ${rubSmart((d.revenue?.totalKop || 0) / 100 - toRub(c.totalUsd))}`) : ''}
          ${tile('Запросов к моделям', fmt(t.requests), `вход ${compact(t.inputTokens)} · выход ${compact(t.outputTokens)}`)}
          ${tile('Картинки', fmt(t.images), `видео: ${fmt(t.videos)} · просмотров видео: ${fmt(t.videoWatches)}`)}
          ${tile('Чатов', fmt(t.chats), `фактов в памяти: ${fmt(t.memories)}`)}
          ${tile('API', fmt(a.requests) + ' запросов', `ключей: ${fmt(a.keysActive)}${a.balanceMicro != null ? ' · баланс ' + rubSmart(Number(a.balanceMicro) / 1e6) : ''}`)}
          ${tile('Пригласил друзей', fmt(d.referral?.invited))}
        </div>
        <div class="adm-cards">
          ${card('Сообщения по дням', columnChart(s.map((x) => x.d), s.map((x) => x.messages), { fmt, name: 'сообщений' }), 'Последние 30 дней')}
          ${card('Модели и функции', hbars((d.models || []).map((m) => ({ label: MODEL_NAMES[m.model] || m.model, value: m.messages, extra: compact(m.tokens) + ' ток.' }))), 'Сообщения за всё время')}
        </div>
        <div class="adm-cards">
          ${card('На что ушли деньги', hbars((c.bySource || []).map((x) => ({ label: srcName(x.source), value: toRub(x.usd), extra: fmt(x.n) + ' запр.' })), { fmt: rubSmart, color: 'var(--series-2)' }), 'Себестоимость по журналу запросов')}
          ${FULL ? card('Платежи', table([{ t: 'Дата', v: (r) => dt(r.at) }, { t: 'Тип', v: (r) => (r.type === 'subscription' ? 'Подписка' : 'Пополнение API') }, { t: 'Статус', v: (r) => ({ succeeded: 'Оплачен', pending: 'Ожидает', canceled: 'Отменён' }[r.status] || r.status) }, { t: 'Сумма', v: (r) => rub(r.kop / 100), num: true }], d.revenue?.payments || [], { empty: 'Платежей нет.' })) : ''}
        </div>
        <div class="adm-cards">
          ${card('Последние ошибки', table([{ t: 'Когда', v: (r) => dt(r.at) }, { t: 'Код', html: (r) => `<a class="mono" href="#errors/${esc(r.code)}">${esc(r.code)}</a>` }, { t: 'Где', v: (r) => srcName(r.source) }, { t: 'Причина', v: (r) => r.message, cls: 'wrap' }], d.errors || [], { empty: 'Ошибок не было.' }))}
          ${card('Действия персонала', table([{ t: 'Когда', v: (r) => dt(r.at) }, { t: 'Кто', v: (r) => r.admin || (r.action === 'auto_block' ? 'автоматически' : '—') }, { t: 'Действие', v: (r) => ({ grant_pro: 'Выдан Pro', revoke_pro: 'Снят Pro', block: 'Блокировка', unblock: 'Разблокировка', reset_limits: 'Сброс лимита', auto_block: 'Автоблокировка (рейтинг 0)' }[r.action] || r.action) + (r.detail?.days ? ` (${r.detail.days} дн.)` : '') + (r.detail?.reason ? ` — ${r.detail.reason}` : '') }], d.actions || [], { empty: 'Действий не было.' }))}
        </div>
        ${d.moderation ? `<div class="adm-cards">${card('Рейтинг и нарушения', `<p class="adm-trust"><b>${fmt(d.moderation.score)}</b> из 100 · пользователь рейтинга не видит. Оскорбление ИИ −34, попытка обойти защиту −50 (за 30 дней); 0 — блокировка навсегда. Разблокировка прощает нарушения.</p>`
          + table([{ t: 'Когда', v: (r) => dt(r.created_at) }, { t: 'Что', v: (r) => (r.kind === 'insult' ? 'Оскорбление ИИ' : 'Обход защиты') + (r.pardoned ? ' (прощено)' : '') }, { t: 'Сообщение', v: (r) => r.excerpt || '', cls: 'wrap' }, { t: 'Почему', v: (r) => r.reason || '', cls: 'wrap' }], d.moderation.incidents || [], { empty: 'Нарушений нет.' }))}</div>` : ''}`;
    },

    async api() {
      const d = await api('api', { days: state.days.api });
      USD_RUB = d.usdRub || USD_RUB;
      const s = d.series || [];
      const charged = Number(d.chargedMicro || 0) / 1e6, cost = toRub(d.costUsd);
      return head('Использование API', 'Публичный API (/v1/messages): кто пользуется, сколько токенов и денег.', daysSelect('api'))
        + '<div class="adm-grid">'
        + tile('Пользователей API', fmt(d.users), `владельцев активных ключей: ${fmt(d.keyOwners)}`)
        + tile('Запросов', fmt(d.requests), `ошибок: ${fmt(d.errors)} (${pct(d.errors, d.requests)})`)
        + tile('Токенов', compact(Number(d.inputTokens || 0) + Number(d.outputTokens || 0)), `вход ${compact(d.inputTokens)} · выход ${compact(d.outputTokens)}`)
        + tile('Списано с балансов', rubSmart(charged))
        + tile('Себестоимость', rubSmart(cost), usd(d.costUsd))
        + tile('Маржа API', charged ? Math.round((charged - cost) / charged * 100) + '%' : '—', `прибыль ${rubSmart(charged - cost)}`)
        + tile('Пополнения за период', rub((d.topupsKop || 0) / 100))
        + tile('Деньги на балансах', rubSmart(Number(d.balancesMicro || 0) / 1e6), 'Обязательства перед клиентами')
        + tile('Активных ключей', fmt(d.keysActive))
        + tile('Средняя задержка', d.avgLatencyMs ? fmt1(d.avgLatencyMs / 1000) + ' с' : '—')
        + '</div><div class="adm-cards">'
        + card('Запросы по дням', columnChart(s.map((x) => x.d), s.map((x) => x.requests), { fmt, name: 'запросов' }))
        + card('Токены по дням', lineChart(s.map((x) => x.d), [{ name: 'Токены', values: s.map((x) => x.tokens) }], { label: 'Токены API по дням' }))
        + '</div><div class="adm-cards">'
        + card('По моделям', table([{ t: 'Модель', v: (r) => r.model }, { t: 'Запросы', v: (r) => fmt(r.requests), num: true }, { t: 'Вход', v: (r) => compact(r.in), num: true }, { t: 'Выход', v: (r) => compact(r.out), num: true }, { t: 'Списано', v: (r) => rubSmart(Number(r.charged) / 1e6), num: true }, { t: 'Себест.', v: (r) => rubSmart(toRub(r.cost)), num: true }], d.byModel || []))
        + card('Самые активные', table([{ t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' }, { t: 'Запросы', v: (r) => fmt(r.requests), num: true }, { t: 'Токены', v: (r) => compact(r.tokens), num: true }, { t: 'Списано', v: (r) => rubSmart(Number(r.charged) / 1e6), num: true }], d.topUsers || [], { rowAttr: (r) => `class="click" data-user="${esc(r.id)}"` }))
        + '</div>';
    },

    async usage() {
      const d = await api('usage', { days: state.days.usage });
      const s = d.series || [], log = d.log || {};
      const eff = log.effort || {};
      return head('Использование токенов и сообщений', 'Чат Adan и Dynatos. Токены чата — оценка по длине текста (как в лимитах); вход/выход моделей — по журналу запросов.', daysSelect('usage'))
        + '<div class="adm-grid">'
        + tile('Сообщений', fmt(d.messages), `в среднем ${fmt1(d.users ? d.messages / d.users : 0)} на пользователя`)
        + tile('Токенов', compact(d.tokens), `в среднем ${compact(d.messages ? d.tokens / d.messages : 0)} на сообщение`)
        + tile('Писали в чат', fmt(d.users), 'пользователей')
        + tile('Ответов моделей', fmt(log.requests), `вход ${compact(log.inputTokens)} · выход ${compact(log.outputTokens)}`)
        + tile('Время ответа', log.avgLatencyMs ? fmt1(log.avgLatencyMs / 1000) + ' с' : '—', 'в среднем, до конца ответа')
        + tile('С поиском в интернете', pct(log.search, log.requests), `«Думать»: ${pct(log.think, log.requests)}`)
        + '</div><div class="adm-cards">'
        + card('Сообщения по дням', columnChart(s.map((x) => x.d), s.map((x) => x.messages), { fmt, name: 'сообщений' }))
        + card('Токены по дням', lineChart(s.map((x) => x.d), [{ name: 'Токены', values: s.map((x) => x.tokens) }], { label: 'Токены по дням' }))
        + '</div><div class="adm-cards">'
        + card('Активные по дням', lineChart(s.map((x) => x.d), [{ name: 'Пользователи', values: s.map((x) => x.users), color: 'var(--series-3)' }], { fmt, label: 'Пользователи чата по дням' }))
        + card('Когда пишут', heat(d.heat), 'День недели × час')
        + '</div><div class="adm-cards">'
        + card('По моделям и функциям', hbars((d.byModel || []).map((m, i) => ({ label: MODEL_NAMES[m.model] || m.model, value: m.messages, extra: compact(m.tokens) + ' ток. · ' + fmt(m.users) + ' польз.', color: SERIES[i % 5] }))))
        + card('Уровень размышления', hbars(['low', 'medium', 'max', 'extra'].filter((k) => eff[k]).map((k, i) => ({ label: { low: 'Low', medium: 'Medium', max: 'Max', extra: 'Extra' }[k], value: eff[k], color: SERIES[i] }))), 'Ответы чата по журналу запросов')
        + '</div>'
        + card('Больше всего токенов', table([{ t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' }, { t: 'Сообщения', v: (r) => fmt(r.messages), num: true }, { t: 'Токены', v: (r) => compact(r.tokens), num: true }], d.topUsers || [], { rowAttr: (r) => `class="click" data-user="${esc(r.id)}"` }));
    },

    async errors(code) {
      if (code) state.errorsQ = code;
      const d = await api('errors', { days: state.days.errors, q: state.errorsQ });
      const rows = d.rows || [];
      setTimeout(() => {
        const q = document.getElementById('admErrQ');
        let t = null;
        q && q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.errorsQ = q.value.trim(); render(); }, 400); });
        document.querySelectorAll('[data-err]').forEach((tr) => {
          tr.onclick = () => {
            const next = tr.nextElementSibling;
            if (next && next.classList.contains('adm-detail')) { next.remove(); return; }
            const r = rows[Number(tr.dataset.err)];
            const det = document.createElement('tr'); det.className = 'adm-detail';
            const td = document.createElement('td'); td.colSpan = 7;
            const pre = document.createElement('pre');
            const detail = r.detail && typeof r.detail === 'object' ? { ...r.detail } : r.detail;
            const shot = detail && typeof detail.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(detail.image) ? detail.image : null;
            if (detail && detail.image) delete detail.image;
            pre.textContent = `Код: ${r.code}\nКогда: ${dt(r.at)}\nПользователь: ${r.email || r.userId || (detail && detail.contact) || '—'}\nГде: ${srcName(r.source)} · статус ${r.status || '—'} · ${KIND_NAMES[r.kind] || r.kind || ''}\n${r.source === 'support' ? 'Обращение' : 'Причина'}: ${r.message || '—'}\n${r.userText && r.source !== 'support' ? 'Сообщение пользователя: ' + r.userText + '\n' : ''}${detail ? 'Подробности: ' + JSON.stringify(detail, null, 2) : ''}`;
            td.appendChild(pre);
            if (shot) { const img = document.createElement('img'); img.src = shot; img.alt = 'Скриншот пользователя'; img.style.cssText = 'display:block;max-width:min(100%,520px);border-radius:10px;margin-top:10px;border:1px solid var(--line)'; td.appendChild(img); }
            det.appendChild(td); tr.after(det);
          };
        });
        if (code && rows.length === 1) { const tr = document.querySelector('[data-err]'); tr && tr.click(); }
      }, 0);
      const s = d.series || [];
      return head('Ошибки сервиса', 'Пользователь видит только «Ошибка сервиса № код». Здесь — что случилось и при каких обстоятельствах. Нажмите на строку, чтобы раскрыть.',
        `<input type="search" id="admErrQ" placeholder="Код ошибки или текст" value="${esc(state.errorsQ)}" aria-label="Поиск ошибки">` + daysSelect('errors', [1, 7, 30, 90]))
        + '<div class="adm-grid">'
        + tile('Ошибок', fmt(d.total)) + tile('Затронуто пользователей', fmt(d.users))
        + '</div><div class="adm-cards">'
        + card('Ошибки по дням', columnChart(s.map((x) => x.d), s.map((x) => x.n), { fmt, name: 'ошибок', color: 'var(--critical)' }))
        + card('Виды ошибок', hbars((d.byKind || []).map((x, i) => ({ label: KIND_NAMES[x.kind] || x.kind, value: x.n, color: SERIES[i % 5] })))
          + '<p class="cap" style="margin-top:12px">Где возникли</p>' + hbars((d.bySource || []).map((x, i) => ({ label: srcName(x.source), value: x.n, color: SERIES[(i + 2) % 5] }))))
        + '</div>'
        + table([
          { t: 'Когда', v: (r) => dt(r.at) },
          { t: 'Код', html: (r) => `<span class="mono">${esc(r.code)}</span>` },
          { t: 'Где', v: (r) => srcName(r.source) },
          { t: 'Вид', v: (r) => KIND_NAMES[r.kind] || r.kind || '—' },
          { t: 'Статус', v: (r) => r.status || '—', num: true },
          { t: 'Пользователь', v: (r) => r.email || '—', cls: 'wrap' },
          { t: 'Причина', v: (r) => String(r.message || '').slice(0, 160), cls: 'wrap' }
        ], rows, { rowAttr: (r, i) => `class="click" data-err="${i}"`, empty: 'Ошибок нет — отлично.' });
    },

    async finance() {
      const d = await api('finance', { days: state.days.finance });
      USD_RUB = d.usdRub || USD_RUB;
      const rev = (d.revenueKop || 0) / 100, cost = toRub(d.costUsd);
      const fixed = (d.fixed || []).reduce((a, b) => a + (Number(b.rub) || 0), 0) * state.days.finance / 30;
      const profit = rev - cost - fixed;
      const s = d.series || [];
      const mrr = (d.paidPro || 0) * (d.prices?.monthRub || 299);
      const or = d.openrouter;
      return head('Финансы', `Доход — успешные оплаты ЮKassa. Себестоимость — оценка по журналу запросов и тарифам провайдеров (курс ${fmt1(USD_RUB, 2)} ₽/$).`, daysSelect('finance', [7, 30, 90, 365, 3650]).replace('>3650 дней<', '>Всё время<'))
        + '<div class="adm-grid">'
        + tile('Заработано', rub(rev), `подписки ${rub((d.subscriptionKop || 0) / 100)} · API ${rub((d.topupKop || 0) / 100)}`)
        + tile('Потрачено на модели', rubSmart(cost), usd(d.costUsd))
        + tile('Постоянные расходы', rub(fixed), (d.fixed || []).map((f) => `${f.name} ${f.plan}`).join(' · '))
        + tile('Прибыль', rubSmart(profit), rev ? `маржа ${Math.round(profit / rev * 100)}%` : '')
        + tile('Платежей', fmt(d.payments), `платящих: ${fmt(d.payers)} · всего было: ${fmt(d.payersAll)}`)
        + tile('Средний чек', d.payments ? rub(rev / d.payments) : '—', d.payers ? `на платящего: ${rub(rev / d.payers)}` : '')
        + tile('Активных платных Pro', fmt(d.paidPro), `≈ ${rub(mrr)} в месяц при продлении`)
        + tile('Заработано за всё время', rub((d.revenueAllKop || 0) / 100), `себестоимость всего: ${rubSmart(toRub(d.costAllUsd))}`)
        + tile('Остаток OpenRouter', or && !or.error ? usd(or.totalUsd - or.usedUsd) : '—', or && !or.error ? `потрачено ${usd(or.usedUsd)} из ${usd(or.totalUsd)}` : 'Нет данных')
        + '</div><div class="adm-cards">'
        + card('Доход по дням', columnChart(s.map((x) => x.d), s.map((x) => x.rev / 100), { fmt: (v) => rub(v), name: 'доход', color: 'var(--series-3)' }))
        + card('Себестоимость по дням', columnChart(s.map((x) => x.d), s.map((x) => toRub(x.cost)), { fmt: rubSmart, name: 'себестоимость', color: 'var(--series-2)' }))
        + '</div><div class="adm-cards">'
        + card('Расходы по провайдерам', hbars((d.costByProvider || []).map((x, i) => ({ label: x.provider, value: toRub(x.usd), extra: fmt(x.n) + ' запр.', color: SERIES[i % 5] })), { fmt: rubSmart }))
        + card('Расходы по функциям', hbars((d.costBySource || []).map((x, i) => ({ label: srcName(x.source), value: toRub(x.usd), extra: fmt(x.n) + ' запр.', color: SERIES[(i + 1) % 5] })), { fmt: rubSmart })
          + '<p class="cap" style="margin-top:12px">По тарифам</p>' + hbars((d.costByPlan || []).map((x, i) => ({ label: { free: 'Free', pro: 'Pro', staff: 'Персонал', api: 'API' }[x.plan] || x.plan, value: toRub(x.usd), extra: fmt(x.users) + ' польз.', color: SERIES[(i + 3) % 5] })), { fmt: rubSmart }))
        + '</div><div class="adm-cards">'
        + card('Последние оплаты', table([{ t: 'Когда', v: (r) => dt(r.at) }, { t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' }, { t: 'Тип', v: (r) => (r.type === 'subscription' ? 'Подписка' : 'API') }, { t: 'Сумма', v: (r) => rub(r.kop / 100), num: true }], d.recent || [], { empty: 'Оплат пока не было.' }))
        + card('Дороже всего обходятся', table([{ t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' }, { t: 'Себестоимость', v: (r) => rubSmart(toRub(r.usd)), num: true }], d.topCost || [], { rowAttr: (r) => `class="click" data-user="${esc(r.id)}"` })
          + '<p class="cap" style="margin-top:12px">Больше всего заплатили</p>' + table([{ t: 'Почта', v: (r) => r.email || '—', cls: 'wrap' }, { t: 'Сумма', v: (r) => rub(r.kop / 100), num: true }], d.topSpenders || [], { rowAttr: (r) => `class="click" data-user="${esc(r.id)}"` }))
        + '</div>';
    },

    async providers() {
      const d = await api('providers', { days: state.days.providers });
      const s = d.series || [];
      setTimeout(() => {
        const b = document.getElementById('admProbe');
        b && (b.onclick = async () => {
          b.disabled = true; b.textContent = 'Проверяю…';
          const box = document.getElementById('admProbeOut');
          try {
            const r = await api('probe', null, { go: 1 });
            box.innerHTML = table([{ t: 'Модель', v: (x) => x.model }, { t: 'Провайдер', v: (x) => x.provider || '—' }, { t: 'Статус', html: (x) => (x.ok ? '<span class="adm-badge ok">' + okIcon + 'отвечает</span>' : '<span class="adm-badge bad">' + badIcon + 'не отвечает</span>') }, { t: 'Время', v: (x) => (x.ms ? fmt1(x.ms / 1000) + ' с' : '—'), num: true }, { t: 'Ошибка', v: (x) => x.error || '', cls: 'wrap' }], r.models || []);
          } catch (e) { box.innerHTML = `<div class="adm-err">${esc(e.message)}</div>`; }
          b.disabled = false; b.textContent = 'Проверить сейчас';
        });
      }, 0);
      return head('Модели и провайдеры', 'Насколько стабильно отвечают модели: успешность, задержки, переключения на запасные.', daysSelect('providers', [1, 7, 30, 90]) + '<button class="adm-btn primary" id="admProbe">Проверить сейчас</button>')
        + '<div id="admProbeOut" style="margin-bottom:14px"></div>'
        + table([
          { t: 'Провайдер', v: (r) => r.provider },
          { t: 'Модель', v: (r) => r.upstream, cls: 'mono' },
          { t: 'Запросы', v: (r) => fmt(r.n), num: true },
          { t: 'Успешно', html: (r) => `${pct(r.ok, r.n)}`, num: true },
          { t: 'Среднее', v: (r) => (r.avg_ms ? fmt1(r.avg_ms / 1000) + ' с' : '—'), num: true },
          { t: 'p50', v: (r) => (r.p50 ? fmt1(r.p50 / 1000) + ' с' : '—'), num: true },
          { t: 'p95', v: (r) => (r.p95 ? fmt1(r.p95 / 1000) + ' с' : '—'), num: true },
          { t: 'С запасной', v: (r) => fmt(r.fallbacks), num: true },
          { t: 'Себест.', v: (r) => rubSmart(toRub(r.usd)), num: true }
        ], d.byUpstream || [], { empty: 'Журнал запросов пока пуст.' })
        + '<div class="adm-cards" style="margin-top:12px">'
        + card('Запросы и сбои по дням', lineChart(s.map((x) => x.d), [{ name: 'Запросы', values: s.map((x) => x.n) }, { name: 'Сбои', values: s.map((x) => x.fail), color: 'var(--series-2)' }], { fmt, area: false }))
        + card('Среднее время ответа', lineChart(s.map((x) => x.d), [{ name: 'Секунды', values: s.map((x) => (x.ms || 0) / 1000), color: 'var(--series-3)' }], { fmt: (v) => fmt1(v) + ' с' }))
        + '</div>'
        + card('Чаще всего подводили', hbars((d.failedModels || []).map((x) => ({ label: x.model, value: x.n, color: 'var(--series-2)' }))), 'Сколько раз модель не ответила и цепочка перешла к следующей');
    },

    async features() {
      const d = await api('features', { days: state.days.features });
      const chat = d.chat || {};
      const series = d.series || [];
      const labels = [...new Set(series.map((x) => x.d))].sort();
      const srcs = [...new Set(series.map((x) => x.source))].slice(0, 5);
      const lines = srcs.map((src, i) => ({ name: srcName(src), color: SERIES[i], values: labels.map((l) => (series.find((x) => x.d === l && x.source === src) || {}).n || 0) }));
      const metricNames = { file_processed: 'Файлы обработаны', file_created: 'Файлы созданы', recognized: 'Распознавания', image: 'Картинки' };
      return head('Генерации и функции', 'Какими возможностями пользуются и насколько они надёжны.', daysSelect('features'))
        + '<div class="adm-grid">'
        + (d.bySource || []).map((x) => tile(srcName(x.source), fmt(x.n), `пользователей: ${fmt(x.users)} · успешно: ${pct(x.ok, x.n)}`)).join('')
        + tile('Поиск в интернете', pct(chat.search, chat.total), `${fmt(chat.search)} ответов чата`)
        + tile('Режим «Думать»', pct(chat.think, chat.total), `${fmt(chat.think)} ответов чата`)
        + tile('Просмотры видео по ссылке', fmt(d.videoWatches))
        + '</div><div class="adm-cards">'
        + card('Функции по дням', lines.length ? lineChart(labels, lines, { fmt, area: false }) : '<p class="adm-muted">Нет данных за период.</p>', 'Кроме обычного чата')
        + card('Лимитированные функции', hbars((d.usageModels || []).map((m, i) => ({ label: MODEL_NAMES[m.model] || m.model, value: m.n, extra: fmt(m.users) + ' польз.', color: SERIES[i % 5] }))), 'Учёт лимитов (usage_events)')
        + '</div>'
        + card('События приложения', hbars((d.metrics || []).map((m, i) => ({ label: metricNames[m.kind] || m.kind, value: m.n, color: SERIES[(i + 2) % 5] }))));
    },

    async retention() {
      const d = await api('retention');
      const c = d.cohorts || [];
      const cell = (n, e) => (e ? `${pct(n, e)} <span class="adm-muted">(${fmt(n)}/${fmt(e)})</span>` : '<span class="adm-muted">ещё рано</span>');
      const conv = d.conversion || {};
      const ref = d.referrals || {};
      return head('Удержание и источники', 'Возвращаются ли новые пользователи и откуда они приходят.')
        + '<div class="adm-grid">'
        + tile('Конверсия Free → Pro', pct(conv.payers, conv.users), `${fmt(conv.payers)} из ${fmt(conv.users)} оплатили подписку`)
        + tile('Приглашения', fmt(ref.invites), `приняли: ${fmt(ref.redeemed)} · приглашали: ${fmt(ref.inviters)}`)
        + '</div>'
        + card('Когорты по неделям регистрации', table([
          { t: 'Неделя', v: (r) => dshort(r.week) },
          { t: 'Новых', v: (r) => fmt(r.size), num: true },
          { t: 'Начали пользоваться', html: (r) => cell(r.activated, r.size), num: true },
          { t: 'Вернулись на 2-й день', html: (r) => cell(r.d1, r.e1), num: true },
          { t: 'На 2-й неделе', html: (r) => cell(r.d7, r.e7), num: true },
          { t: 'На 2-м месяце', html: (r) => cell(r.d30, r.e30), num: true }
        ], c, { empty: 'За 12 недель регистраций нет.' }), 'Доля от тех, у кого этот срок уже прошёл')
        + '<div class="adm-cards" style="margin-top:12px">'
        + card('Откуда узнали', hbars((d.sources || []).map((x, i) => ({ label: x.source, value: x.users, color: SERIES[i % 5] }))), 'Ответы при регистрации')
        + card('Способ входа', hbars((d.providers || []).map((x, i) => ({ label: x.provider, value: x.n, color: SERIES[(i + 1) % 5] }))))
        + '</div>'
        + ((d.otherSources || []).length ? card('«Другое» — свои ответы', hbars(d.otherSources.map((x) => ({ label: x.text, value: x.users })))) : '');
    },

    async feedback() {
      const d = await api('feedback', { days: state.days.feedback });
      const s = d.series || [];
      const list = (items, render) => (items && items.length ? '<div class="adm-list">' + items.map(render).join('') + '</div>' : '<p class="adm-muted">Пока пусто.</p>');
      return head('Обратная связь', 'Оценки ответов, исправления и сообщения о проблемах.', daysSelect('feedback'))
        + '<div class="adm-grid">'
        + tile('Понравилось', fmt(d.likes)) + tile('Не понравилось', fmt(d.dislikes))
        + tile('Доля положительных', pct(d.likes, (d.likes || 0) + (d.dislikes || 0)))
        + '</div><div class="adm-cards">'
        + card('Оценки по дням', lineChart(s.map((x) => x.d), [{ name: 'Нравится', values: s.map((x) => x.likes), color: 'var(--series-3)' }, { name: 'Не нравится', values: s.map((x) => x.dislikes), color: 'var(--series-2)' }], { fmt, area: false }))
        + card('По моделям', table([{ t: 'Модель', v: (r) => MODEL_NAMES[r.model] || r.model }, { t: '👍', v: (r) => fmt(r.likes), num: true }, { t: '👎', v: (r) => fmt(r.dislikes), num: true }, { t: 'Положительных', v: (r) => pct(r.likes, r.likes + r.dislikes), num: true }], d.byModel || []))
        + '</div><div class="adm-cards">'
        + card('Сообщения о проблемах', list(d.reports, (r) => `<div class="it"><div class="m">${esc(dt(r.at))} · ${esc(r.email || 'без почты')}</div><p>${esc(r.message)}</p></div>`))
        + card('Последние дизлайки', list(d.dislikedRecent, (r) => `<div class="it"><div class="m">${esc(dt(r.at))} · ${esc(MODEL_NAMES[r.model] || r.model || '')} · ${esc(r.email || '')}</div><p>${esc(r.excerpt || '')}</p></div>`))
        + '</div>'
        + card('Исправления ответов', list(d.corrections, (r) => `<div class="it"><div class="m">${esc(dt(r.at))} · ${esc(r.email || '')}</div><p><b>Ответ:</b> ${esc(r.answer || '')}</p><p><b>Исправление:</b> ${esc(r.correction || '')}</p>${r.note ? `<p><b>Комментарий:</b> ${esc(r.note)}</p>` : ''}</div>`));
    },

    /* Почта (lib/mailer.js): служебные письма уходят сами, здесь — рассылки
       тем, кто включил «Новости на почту», с учётом суточного лимита Resend. */
    async mail() {
      const d = await api('mail');
      setTimeout(() => {
        const subj = document.getElementById('admMailSubj'), body = document.getElementById('admMailBody'), msg = document.getElementById('admMailMsg');
        const say = (t, bad) => { msg.textContent = t; msg.className = bad ? 'adm-err' : 'adm-note'; msg.hidden = false; };
        const send = async (action, payload, okText) => {
          document.querySelectorAll('.adm-mail [data-mail]').forEach((b) => { b.disabled = true; });
          const r = await window.hmAuth.account('admin.' + action, payload);
          document.querySelectorAll('.adm-mail [data-mail]').forEach((b) => { b.disabled = false; });
          if (!r.ok) { say(r.error || 'Не получилось', true); return null; }
          const x = r.data && r.data.data;
          say(okText(x || {}));
          return x;
        };
        const tst = document.querySelector('[data-mail=test]'), all = document.querySelector('[data-mail=send]');
        if (tst) tst.onclick = () => send('mail_test', { subject: subj.value, body: body.value }, (x) => 'Тестовое письмо отправлено на ' + (x.sentTo || 'вашу почту') + '.');
        if (all) all.onclick = async () => {
          if (!confirm(`Отправить рассылку подписчикам (${fmt(d.subscribers || 0)})? Отменить будет нельзя.`)) return;
          const x = await send('mail_send', { subject: subj.value, body: body.value }, (r) => `Отправлено ${fmt(r.sent)} из ${fmt(r.total)}.` + (r.left ? ` Осталось ${fmt(r.left)} — суточный лимит писем исчерпан, нажмите «Продолжить» завтра.` : ''));
          if (x) setTimeout(render, 1500);
        };
        document.querySelectorAll('[data-mail=continue]').forEach((b) => {
          b.onclick = async () => { const x = await send('mail_continue', { id: b.dataset.id }, (r) => `Отправлено ещё ${fmt(r.sent)}. Всего ${fmt(r.sentTotal)} из ${fmt(r.total)}.`); if (x) setTimeout(render, 1500); };
        });
      }, 0);
      const status = d.enabled
        ? `Почта подключена · отправитель <span class="mono">${esc(d.from)}</span> · за сутки отправлено ${fmt(d.sent24h)} из ${fmt(d.limit)}`
        : 'Почта не подключена: добавьте переменную <span class="mono">RESEND_API_KEY</span> в Vercel (инструкция — в описании обновления).';
      const camp = (d.campaigns || []);
      return head('Рассылки', 'Письма об оплате и блокировке уходят сами. Здесь — новости тем, кто включил «Новости на почту».', '')
        + `<div class="${d.enabled ? 'adm-note' : 'adm-err'}">${status}</div>`
        + (d.migrated ? '' : '<div class="adm-note">Для рассылок выполните миграцию <span class="mono">supabase/2026-11-04-mail.sql</span>.</div>')
        + '<div class="adm-grid">' + tile('Подписчиков на новости', d.subscribers == null ? '—' : fmt(d.subscribers)) + tile('Писем за сутки', fmt(d.sent24h), 'лимит ' + fmt(d.limit)) + '</div>'
        + '<div class="adm-stack">' + (FULL ? card('Новая рассылка', `<div class="adm-mail">
            <input id="admMailSubj" maxlength="150" placeholder="Тема письма" aria-label="Тема письма">
            <textarea id="admMailBody" rows="9" placeholder="Текст. Пустая строка — новый абзац, **жирный**, [ссылка](https://…)" aria-label="Текст письма"></textarea>
            <div class="adm-actions"><button class="adm-btn" data-mail="test">Отправить тест себе</button><button class="adm-btn danger" data-mail="send">Отправить подписчикам</button></div>
            <div id="admMailMsg" hidden></div></div>`, 'Сначала отправьте тест себе — проверьте, как письмо выглядит.') : '')
        + card('Прошлые рассылки', table([{ t: 'Когда', v: (r) => dt(r.created_at) }, { t: 'Тема', v: (r) => r.subject, cls: 'wrap' }, { t: 'Отправлено', v: (r) => fmt(r.sent) + ' из ' + fmt(r.total), num: true },
          { t: '', html: (r) => (!r.finished_at && FULL ? `<button class="adm-btn" data-mail="continue" data-id="${esc(r.id)}">Продолжить</button>` : (r.finished_at ? 'готово' : '')) }], camp, { empty: 'Рассылок ещё не было.' })) + '</div>';
    }
  };
  const okIcon = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.2 2.2 4.8-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const badIcon = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  /* ---------------------------------------------------------------- маршрут */
  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'overview';
    const [sec, arg] = h.split('/');
    return { sec: SECTIONS[sec] ? sec : 'overview', arg: arg || '' };
  }
  async function render() {
    const { sec, arg } = route();
    const n = ++seq;
    const main = $main();
    hideTip();
    document.querySelectorAll('.adm-links a').forEach((a) => a.classList.toggle('on', a.dataset.sec === (sec === 'user' ? 'users' : sec)));
    main.classList.add('loading');
    if (!main.children.length || main.querySelector('.adm-muted:only-child')) main.innerHTML = '<p class="adm-muted">Загружаем…</p>';
    try {
      const html = await SECTIONS[sec](arg);
      if (n !== seq) return;
      main.innerHTML = html;
      main.querySelectorAll('[data-days]').forEach((sel) => { sel.onchange = () => { state.days[sel.dataset.days] = Number(sel.value); render(); }; });
      if (sec !== 'users') main.querySelectorAll('tr[data-user]').forEach((tr) => { tr.onclick = () => { location.hash = '#user/' + tr.dataset.user; }; });
    } catch (e) {
      if (n !== seq) return;
      main.innerHTML = e.migration
        ? `<h1 class="adm-h1">Нужно обновить базу данных</h1><div class="adm-note">${esc(e.message)}</div><p class="adm-muted">Файл миграции лежит в репозитории: <span class="mono">supabase/2026-11-02-admin.sql</span>. После выполнения обновите страницу.</p>`
        : `<div class="adm-err">${esc(e.message)}</div><p><button class="adm-btn" id="admRetry">Повторить</button></p>`;
      const r = document.getElementById('admRetry'); r && (r.onclick = render);
    } finally {
      if (n === seq) main.classList.remove('loading');
    }
  }

  async function start() {
    const main = $main();
    const auth = window.hmAuth;
    if (!auth) { main.innerHTML = '<div class="adm-err">Не загрузился модуль входа. Обновите страницу.</div>'; return; }
    await auth.ready;
    if (!auth.user) { main.innerHTML = '<h1 class="adm-h1">Управление сервисом</h1><p>Войдите в аккаунт с доступом к панели.</p><p><a class="adm-btn primary" href="/login?next=/management" style="text-decoration:none;display:inline-block">Войти</a></p>'; return; }
    const r = await auth.account('admin.me', null, null);
    if (!r.ok) { main.innerHTML = `<h1 class="adm-h1">Нет доступа</h1><p class="adm-muted">${esc(r.error || 'Панель доступна только персоналу.')}</p>`; return; }
    ROLE = r.data.role; FULL = Boolean(r.data.can && r.data.can.finance);
    if (!FULL) document.querySelectorAll('[data-full]').forEach((a) => { a.hidden = true; });
    addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
    render();
  }
  document.addEventListener('DOMContentLoaded', start);
})();
