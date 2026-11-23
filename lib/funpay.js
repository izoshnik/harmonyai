const ORIGIN = 'https://funpay.com';
const ACTIONS = new Set(['funpay.connect', 'funpay.publish', 'funpay.edit', 'funpay.delete', 'funpay.stock']);
const TITLE = 'fields[summary][ru]';
const DESCRIPTION = 'fields[desc][ru]';

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function input(value, limit) {
  return typeof value === 'string' && value.trim().length <= limit ? value.trim() : '';
}

function id(value) {
  return /^[1-9]\d{0,11}$/.test(String(value ?? '')) ? String(value) : '';
}

function decode(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return html.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (full, numeric, name) => {
    if (!numeric) return entities[name.toLowerCase()] ?? full;
    const code = Number(numeric[0].toLowerCase() === 'x' ? '0' + numeric : numeric);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
  });
}

function attributes(tag) {
  const attrs = Object.create(null);
  for (const [, name, double, single, bare] of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
    attrs[name.toLowerCase()] = decode(double ?? single ?? bare ?? '');
  }
  return attrs;
}

function parseEditor(html) {
  let editor = '';
  for (const [, attrs, body] of html.matchAll(/<form\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/form\s*>/gi)) {
    if (attributes(attrs).class?.split(/\s+/).includes('form-offer-editor')) { editor = body; break; }
  }
  const fields = new URLSearchParams();
  const controls = new Set();
  const tags = /<(input|textarea|select)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
  for (let match; (match = tags.exec(editor));) {
    const [, rawTag, raw] = match;
    const tag = rawTag.toLowerCase();
    let body = '';
    if (tag !== 'input') {
      const end = new RegExp('</' + tag + '\\s*>', 'gi');
      end.lastIndex = tags.lastIndex;
      const closing = end.exec(editor);
      if (!closing) throw failure(502, 'Форма FunPay изменилась.');
      body = editor.slice(tags.lastIndex, closing.index);
      tags.lastIndex = end.lastIndex;
    }
    const attrs = attributes(raw);
    const name = attrs.name;
    if (!name || name === 'query' || Object.hasOwn(attrs, 'disabled') || ['submit', 'button', 'file', 'reset'].includes(attrs.type)) continue;
    controls.add(name);
    if (tag === 'textarea') {
      fields.append(name, decode(body).replace(/^\r?\n/, ''));
    } else if (tag === 'select') {
      const options = [...body.matchAll(/<option\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([^<]*)/gi)]
        .map(option => ({ ...attributes(option[1]), label: decode(option[2]).trim() }))
        .filter(option => !Object.hasOwn(option, 'disabled'));
      const selected = options.filter(option => Object.hasOwn(option, 'selected'));
      const values = selected.length || Object.hasOwn(attrs, 'multiple') ? selected : options.slice(0, 1);
      for (const option of values) fields.append(name, option.value ?? option.label);
    } else {
      const toggle = ['radio', 'checkbox'].includes(attrs.type);
      if (!toggle || Object.hasOwn(attrs, 'checked')) fields.append(name, attrs.value ?? (toggle ? 'on' : ''));
    }
  }
  return { fields, controls };
}

function session(token) {
  let phpSession;
  return async (path, { body, referer } = {}) => {
    const headers = {
      'User-Agent': 'HarmonyAI FunPay integration',
      Accept: body ? 'application/json' : 'text/html, application/json',
      Cookie: 'golden_key=' + token + (phpSession ? '; PHPSESSID=' + phpSession : '')
    };
    if (body) Object.assign(headers, { Origin: ORIGIN, Referer: ORIGIN + referer, 'X-Requested-With': 'XMLHttpRequest' });
    const response = await fetch(ORIGIN + path, {
      method: body ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(6500)
    });
    if (response.status === 401 || (response.status >= 300 && response.status < 400 &&
        /\/account\/login(?:[/?]|$)/.test(response.headers.get('location') || ''))) {
      throw failure(401, 'Сессия FunPay истекла. Подключи аккаунт заново в настройках.');
    }
    if (response.status === 403 || response.status === 429) {
      throw failure(response.status, 'FunPay ограничил доступ. Проверь аккаунт и доступ к разделу на сайте FunPay.');
    }
    if (!response.ok) throw failure(502, 'FunPay не подтвердил запрос. Проверь состояние предложения на FunPay.');
    for (const cookie of response.headers.getSetCookie()) {
      const match = cookie.match(/^PHPSESSID=([a-z\d,-]+)(?:;|$)/i);
      if (match) phpSession = match[1];
    }
    return (await response.text()).trim();
  };
}

function asJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function funpayCategoryName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export async function resolveFunPayCategory(game, section) {
  const wantedGame = funpayCategoryName(game);
  const wantedSection = funpayCategoryName(section);
  if (!wantedGame || !wantedSection) return null;
  const response = await fetch(ORIGIN + '/', {
    headers: { Accept: 'text/html', 'Accept-Language': 'ru, en;q=0.9' },
    redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw failure(502, 'Каталог FunPay сейчас недоступен.');
  const html = await response.text();
  const groups = new Map();
  for (const [, raw, label] of html.matchAll(/<div\b([^>]*\bclass="game-title"[^>]*)>\s*<a\b[^>]*>([^<]+)<\/a>/gi)) {
    const name = decode(label).trim();
    const group = id(attributes(raw)['data-id']);
    if (group && funpayCategoryName(name) === wantedGame) groups.set(group, name);
  }
  const matches = new Map();
  for (const [, raw, list] of html.matchAll(/<ul\b([^>]*\bdata-id\s*=\s*["']\d+["'][^>]*)>([\s\S]*?)<\/ul>/gi)) {
    const attrs = attributes(raw);
    const group = groups.get(attrs['data-id']);
    if (!group || !attrs.class?.split(/\s+/).includes('list-inline')) continue;
    for (const [, link, label] of list.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/gi)) {
      const name = decode(label).trim();
      if (funpayCategoryName(name) !== wantedSection) continue;
      const href = attributes(link).href || '';
      const node = href.match(/^(?:https:\/\/funpay\.com)?\/(?:(?:en|uk)\/)?lots\/([1-9]\d{0,11})\/?$/i)?.[1];
      if (node) matches.set(node, { node, label: group + ' → ' + name });
    }
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

function savedOffer(data, offer) {
  if (!data || data.error || (data.errors && Object.keys(data.errors).length) || data.done === false || data.done === 0) return null;
  let url;
  try {
    if (typeof data.url === 'string') url = new URL(data.url, ORIGIN);
  } catch { /* invalid redirect */ }
  const sameSite = url?.origin === ORIGIN && /^\/(?:(?:en|uk)\/)?lots\//.test(url?.pathname);
  const redirected = sameSite && /^\/(?:(?:en|uk)\/)?lots\/offer(?:Edit)?\/?$/.test(url.pathname)
    ? id(url.searchParams.get('offer') || url.searchParams.get('id')) : '';
  const returned = id(data.offer_id);
  if (new Set([offer, returned, redirected].filter(Boolean)).size > 1) return null;
  const done = data.done === true || data.done === 1;
  if (!offer && !redirected && !(done && returned)) return null;
  if (offer && !done && !sameSite) return null;
  return offer || returned || redirected;
}

export async function funpay(action, body) {
  if (!ACTIONS.has(action)) throw failure(400, 'Неизвестное действие FunPay.');
  const key = typeof body.token === 'string' ? body.token.trim() : '';
  if (!/^[a-z\d._~%+-]{8,512}$/i.test(key)) throw failure(400, 'Укажи значение cookie golden_key из своего аккаунта FunPay.');
  const request = session(key);
  if (action === 'funpay.connect') {
    const home = await request('/');
    const match = home.match(/\bdata-app-data\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const encoded = match?.[1] ?? match?.[2];
    const profile = encoded ? asJSON(decode(encoded)) : null;
    if (!id(profile?.userId)) throw failure(401, 'FunPay не подтвердил вход. Проверь golden_key.');
    return { account: id(profile.userId) };
  }

  const creating = action === 'funpay.publish';
  const offer = id(body.offer);
  const node = id(body.node);
  if (creating && !node) throw failure(400, 'Для публикации укажи раздел FunPay.');
  if (!creating && !offer) throw failure(400, 'Укажи ID предложения FunPay.');
  const title = input(body.title, 120);
  const description = input(body.description, 2500);
  const price = input(body.price, 14).replace(',', '.');
  const amount = input(body.amount, 6);
  if ((body.title !== undefined && !title) || (body.description !== undefined && !description) ||
      (body.price !== undefined && (!/^\d{1,8}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0)) ||
      (body.amount !== undefined && !/^[1-9]\d{0,5}$/.test(amount))) {
    throw failure(400, 'Проверь название, описание, цену и количество предложения.');
  }
  const stock = action === 'funpay.stock' || ((creating || action === 'funpay.edit') && body.stock !== undefined);
  const newItems = stock ? input(body.stock, 18000).split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  if (stock && (!newItems.length || newItems.length > 200 || newItems.some(line => line.length > 900))) {
    throw failure(400, 'FunPay принимает до 200 позиций за запрос, до 900 символов на позицию.');
  }
  const distinctItems = new Set(newItems);
  if (creating && !(title && description && price && (amount || stock))) throw failure(400, 'Для публикации нужны название, описание, цена и количество или позиции автовыдачи.');
  if (creating && stock && amount && Number(amount) !== distinctItems.size) throw failure(400, 'Количество товара расходится с числом предоставленных позиций автовыдачи.');
  if (action === 'funpay.edit' && !(title || description || price || amount || stock)) throw failure(400, 'Укажи изменения предложения.');

  // The authenticated editor supplies the CSRF token, identity, and unchanged fields.
  const editor = '/lots/offerEdit?' + (creating ? 'node=' + node : 'offer=' + offer);
  const raw = await request(editor);
  const json = asJSON(raw);
  const { fields, controls } = parseEditor(json ? String(json.html || '') : raw);
  const actualOffer = fields.get('offer_id');
  const actualNode = fields.get('node_id');
  if (!fields.get('csrf_token') || !id(actualNode) || !fields.has('offer_id') ||
      (creating ? actualNode !== node || (actualOffer && actualOffer !== '0') : actualOffer !== offer)) {
    throw failure(403, 'FunPay не открыл форму продавца. Проверь, что раздел доступен и предложение принадлежит твоему аккаунту.');
  }
  if (stock && (!controls.has('secrets') || !controls.has('auto_delivery'))) {
    const outcome = creating ? 'Предложение не создано.' : 'Изменения не сохранены.';
    throw failure(422, outcome + ' Форма FunPay в этом разделе не поддерживает встроенную автовыдачу.');
  }
  let added = 0;
  let payload = fields;
  if (action === 'funpay.delete') {
    payload = new URLSearchParams({ offer_id: offer, csrf_token: fields.get('csrf_token'), deleted: '1' });
    if (fields.has('form_created_at')) payload.set('form_created_at', fields.get('form_created_at'));
  } else {
    for (const [name, value] of [[TITLE, title], [DESCRIPTION, description], ['price', price], ['amount', amount]]) {
      if (!value) continue;
      if (!controls.has(name)) throw failure(400, 'Форма FunPay не поддерживает это поле в выбранном разделе.');
      if (name === 'amount' && !creating && (fields.has('auto_delivery') || stock)) throw failure(400, 'Остаток для автовыдачи меняется добавлением позиций.');
      fields.set(name, value);
    }
    if (stock) {
      const kept = (fields.get('secrets') || '').split(/\r?\n/).filter(line => line.trim());
      const known = new Set(kept.map(line => line.trim()));
      const fresh = [...distinctItems].filter(line => !known.has(line));
      added = fresh.length;
      if (!added && fields.has('auto_delivery') && action === 'funpay.stock') return { offer, added: 0, node: actualNode };
      if (added) fields.set('secrets', [...kept, ...fresh].join('\n'));
      fields.set('auto_delivery', 'on');
      if (creating && controls.has('amount')) fields.set('amount', String(distinctItems.size));
    }
    if (creating) fields.set('active', 'on');
  }
  const unconfirmed = creating
    ? 'FunPay не подтвердил публикацию конкретного предложения. Проверь список своих предложений перед повтором.'
    : 'FunPay не подтвердил сохранение. Проверь предложение на FunPay перед повтором.';
  let response;
  try {
    response = await request('/lots/offerSave', { body: payload, referer: editor });
  } catch (error) {
    if (error.status && error.status < 500) throw error;
    throw failure(502, unconfirmed);
  }
  const saved = savedOffer(asJSON(response), offer);
  if (saved === null) throw failure(422, unconfirmed);
  return { offer: saved, ...(stock ? { added } : {}), node: actualNode };
}
