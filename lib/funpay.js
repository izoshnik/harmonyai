const ORIGIN = 'https://funpay.com';
const DEFAULT_NODE = '1356';
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

function savedOffer(data, offer) {
  if (!data || data.error || (data.errors && Object.keys(data.errors).length)) return null;
  let url;
  try {
    if (typeof data.url === 'string') url = new URL(data.url, ORIGIN);
  } catch { /* invalid redirect */ }
  const sameSite = url?.origin === ORIGIN && /^\/(?:(?:en|uk)\/)?lots\//.test(url?.pathname);
  if (data.done !== true && data.done !== 1 && !sameSite) return null;
  const redirected = sameSite && /\/lots\/offer(?:Edit)?\/?$/i.test(url.pathname)
    ? id(url.searchParams.get('offer') || url.searchParams.get('id')) : '';
  return offer || id(data.offer_id) || redirected || '';
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
  const node = id(body.node || DEFAULT_NODE);
  if (creating ? !node : !offer) throw failure(400, 'Укажи ID раздела или предложения FunPay.');
  const title = input(body.title, 120);
  const description = input(body.description, 2500);
  const price = input(body.price, 14).replace(',', '.');
  const amount = input(body.amount, 6);
  if ((body.title !== undefined && !title) || (body.description !== undefined && !description) ||
      (body.price !== undefined && (!/^\d{1,8}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0)) ||
      (body.amount !== undefined && !/^[1-9]\d{0,5}$/.test(amount))) {
    throw failure(400, 'Проверь название, описание, цену и количество предложения.');
  }
  if (creating && !(title && description && price && amount)) throw failure(400, 'Для публикации нужны название, описание, цена и количество.');
  if (action === 'funpay.edit' && !(title || description || price || amount)) throw failure(400, 'Укажи изменения предложения.');
  const stock = action === 'funpay.stock';
  const newItems = stock ? input(body.stock, 18000).split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  if (stock && (!newItems.length || newItems.length > 200 || newItems.some(line => line.length > 900))) {
    throw failure(400, 'Введи до 200 позиций, по одной на строку (до 900 символов на позицию).');
  }

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
  let added = 0;
  let payload = fields;
  if (action === 'funpay.delete') {
    payload = new URLSearchParams({ offer_id: offer, csrf_token: fields.get('csrf_token'), deleted: '1' });
    if (fields.has('form_created_at')) payload.set('form_created_at', fields.get('form_created_at'));
  } else if (stock) {
    if (!controls.has('secrets') || !controls.has('auto_delivery')) throw failure(400, 'В этом разделе FunPay встроенная автовыдача недоступна.');
    const kept = (fields.get('secrets') || '').split(/\r?\n/).filter(line => line.trim());
    const known = new Set(kept.map(line => line.trim()));
    for (const line of newItems) {
      if (known.has(line)) continue;
      kept.push(line);
      known.add(line);
      added++;
    }
    if (added) fields.set('secrets', kept.join('\n'));
    if (!added && fields.has('auto_delivery')) return { offer, added: 0, node: actualNode };
    fields.set('auto_delivery', 'on');
  } else {
    for (const [name, value] of [[TITLE, title], [DESCRIPTION, description], ['price', price], ['amount', amount]]) {
      if (!value) continue;
      if (!controls.has(name)) throw failure(400, 'Форма FunPay не поддерживает это поле в выбранном разделе.');
      if (name === 'amount' && !creating && fields.has('auto_delivery')) throw failure(400, 'Остаток для автовыдачи меняется добавлением позиций.');
      fields.set(name, value);
    }
    if (creating) fields.set('active', 'on');
  }
  const saved = savedOffer(asJSON(await request('/lots/offerSave', { body: payload, referer: editor })), offer);
  if (saved === null) throw failure(422, 'FunPay не подтвердил сохранение. Проверь предложение и требования раздела на FunPay перед повтором.');
  return { offer: saved, ...(stock ? { added } : {}), node: actualNode };
}
