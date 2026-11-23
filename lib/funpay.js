const ORIGIN = 'https://funpay.com';
const ACTIONS = new Set(['funpay.connect', 'funpay.publish', 'funpay.edit', 'funpay.delete', 'funpay.stock']);
const TITLE = 'fields[summary][ru]';
const DESCRIPTION = 'fields[desc][ru]';

function failure(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

export function checkFunPayListing(body) {
  const listing = [body.title, body.description].join(' ').normalize('NFKC');
  const restricted = /(?:^|[^\p{L}])(?:jail[\s-]*break|джейл[\s-]*брейк|кейлоггер|стилер)(?!\p{L})/iu.test(listing);
  const aiProduct = /\b(?:chatgpt|claude|codex|gpt)\b|нейросет/iu.test(listing);
  const bypass = /\bjail\b|обход\s+(?:защит|ограничени)|сняти[ея]\s+ограничени/iu.test(listing);
  const abbreviated = /(?:^|[^\p{L}])(?:j|джей)\s+(?:для\s+модели|for\s+(?:the\s+)?model)(?!\p{L})/iu.test(listing);
  const accountBan = /блокировк[аиуе]\s+(?:уч[её]тной\s+записи|аккаунта)|account\s+(?:ban|suspension)/iu.test(listing);
  if (restricted || (aiProduct && (bypass || (abbreviated && accountBan)))) {
    throw failure(400, 'HarmonyAI не публикует материалы для обхода защит и вредоносные инструменты.', 'FUNPAY_RESTRICTED_LISTING');
  }
}

function input(value, limit) {
  return typeof value === 'string' && value.trim().length <= limit ? value.trim() : '';
}

function id(value) {
  return /^[1-9]\d{0,11}$/.test(String(value ?? '')) ? String(value) : '';
}

export function decodeFunPayHtml(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return html.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (full, numeric, name) => {
    if (!numeric) return entities[name.toLowerCase()] ?? full;
    const code = Number(numeric[0].toLowerCase() === 'x' ? '0' + numeric : numeric);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
  });
}

const decode = decodeFunPayHtml;

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

export function funpaySession(token) {
  if (!/^[a-z\d._~%+-]{8,512}$/i.test(String(token || ''))) throw failure(400, 'Укажи значение cookie golden_key из своего аккаунта FunPay.');
  let phpSession;
  let sessionCsrf;
  return async (path, { body, referer } = {}) => {
    const headers = {
      'User-Agent': 'HarmonyAI FunPay integration',
      Accept: body ? 'application/json' : 'text/html, application/json',
      'Accept-Language': 'ru',
      Cookie: 'golden_key=' + token + (phpSession ? '; PHPSESSID=' + phpSession : '')
    };
    if (body) Object.assign(headers, { Origin: ORIGIN, Referer: ORIGIN + (referer || '/'), 'X-Requested-With': 'XMLHttpRequest' });
    if (body && path === '/lots/offerSave' && sessionCsrf) headers['X-CSRF-Token'] = sessionCsrf;
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetch(ORIGIN + path, {
      method: body ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(6500)
    });
    if (response.status === 401 || (response.status >= 300 && response.status < 400 &&
        /\/account\/login(?:[/?]|$)/.test(response.headers.get('location') || ''))) {
      throw failure(401, 'Сессия FunPay истекла. Подключи аккаунт заново в настройках.');
    }
    if (path === '/lots/offerSave' && body && response.status === 419) throw saveSessionError(419);
    if (response.status === 403 || response.status === 429) {
      throw failure(response.status, 'FunPay ограничил доступ. Проверь аккаунт и доступ к разделу на сайте FunPay.');
    }
    if (path === '/lots/offerSave' && body && [400, 409, 422].includes(response.status)) {
      const rejected = asJSON(await response.text().catch(() => ''));
      if (sessionRejected(rejected)) throw saveSessionError(response.status);
      throw saveRejection(rejected, response.status);
    }
    if (!response.ok) {
      throw Object.assign(failure(502, 'FunPay не подтвердил запрос. Проверь состояние предложения на FunPay.'),
        { upstreamStatus: response.status });
    }
    for (const cookie of response.headers.getSetCookie()) {
      const match = cookie.match(/^PHPSESSID=([a-z\d,-]+)(?:;|$)/i);
      if (match) phpSession = match[1];
    }
    const text = (await response.text()).trim();
    if (!body) {
      const csrf = sellerPageData(text)?.['csrf-token'];
      if (typeof csrf === 'string' && /^[!-~]{1,512}$/.test(csrf)) sessionCsrf = csrf;
    }
    return text;
  };
}

function asJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function sellerPageData(html) {
  const body = html.match(/<body\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i)?.[1];
  return body ? asJSON(attributes(body)['data-app-data']) : null;
}

function saveSessionError(upstreamStatus) {
  return Object.assign(failure(409, 'FunPay отклонил сохранение из-за проверки сессии.',
    'FUNPAY_SAVE_SESSION'), { upstreamStatus });
}

function sessionRejected(data) {
  return !data?.done && !data?.url && [data?.msg, data?.error].some(value =>
    typeof value === 'string' && /обновите страницу и повторите попытку|csrf (?:token )?mismatch/i.test(value));
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

function isSaveRejected(data) {
  return data && (data.error || (data.errors && Object.keys(data.errors).length) || data.done === false || data.done === 0);
}

function saveRejection(data, upstreamStatus) {
  const labels = {
    price: 'цену', amount: 'количество', summary: 'название', desc: 'описание',
    node_id: 'раздел', server_id: 'сервер', side_id: 'сторону',
    auto_delivery: 'настройки автовыдачи', secrets: 'позиции автовыдачи'
  };
  const fields = new Set();
  const errors = data?.errors;
  const entries = Array.isArray(errors) ? errors.filter(Array.isArray) : Object.entries(errors || {});
  for (const [key, detail] of entries) {
    if (typeof key !== 'string') continue;
    const name = /^fields\[([^[]+)\]/.exec(key)?.[1] || key;
    if ((typeof detail === 'string' && !detail.trim()) || !detail) continue;
    if (Object.hasOwn(labels, name)) fields.add(labels[name]);
    else if (key.startsWith('fields[')) fields.add('обязательные параметры раздела');
  }
  const hint = fields.size ? ' Проверь ' + [...fields].join(', ') + '.' :
    ' Проверь обязательные поля и требования раздела в кабинете продавца.';
  return Object.assign(failure(422, 'FunPay отклонил сохранение предложения.' + hint, 'FUNPAY_SAVE_REJECTED'), { upstreamStatus });
}

function savedOffer(data, offer) {
  if (!data || isSaveRejected(data)) return null;
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

async function sellerOfferIds(request, node, title) {
  const html = await request('/lots/' + node + '/trade');
  if (!/\buser-link-name\b/.test(html)) throw failure(502, 'Не удалось прочитать список продавца FunPay.');
  const matches = new Set();
  for (const [, raw, inner] of html.matchAll(/<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(raw);
    const offer = id(attrs['data-offer']);
    if (!offer || !attrs.class?.split(/\s+/).includes('tc-item')) continue;
    const caption = inner.match(/<div\b[^>]*class="[^"]*\btc-desc-text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (decode((caption || '').replace(/<[^>]*>/g, '')).trim() === title) matches.add(offer);
  }
  return matches;
}

async function recoverPublication(request, node, submitted, previous) {
  const title = submitted.get(TITLE);
  if (!previous && !/ \[HA-[A-F0-9]{12}\]$/.test(title)) return null;
  const ids = [...await sellerOfferIds(request, node, title)].filter(offer => !previous?.has(offer));
  if (ids.length !== 1) return null;
  const [offer] = ids;
  const editor = await request('/lots/offerEdit?offer=' + offer);
  const { fields } = parseEditor(asJSON(editor)?.html || editor);
  if (fields.get('offer_id') !== offer || fields.get('node_id') !== node ||
      fields.get(TITLE) !== title || !fields.get('csrf_token')) return null;
  if (!previous) return !fields.get('active') ? offer : null;
  const comparable = value => (value || '').replace(/\r\n/g, '\n').trim();
  const numeric = value => Number((value || '').replace(',', '.'));
  return fields.get('active') && Boolean(fields.get('auto_delivery')) === Boolean(submitted.get('auto_delivery')) &&
    comparable(fields.get(DESCRIPTION)) === comparable(submitted.get(DESCRIPTION)) &&
    comparable(fields.get('secrets')) === comparable(submitted.get('secrets')) &&
    numeric(fields.get('price')) === numeric(submitted.get('price')) ? offer : null;
}

async function verifyActiveListing(request, editor, offer, node, title) {
  const raw = await request(editor);
  const { fields } = parseEditor(asJSON(raw)?.html || raw);
  return fields.get('offer_id') === offer && fields.get('node_id') === node && fields.get(TITLE) === title &&
    fields.get('csrf_token') && fields.get('active') && !fields.get('auto_delivery') && !fields.get('secrets');
}

export async function funpay(action, body, internal = {}) {
  if (!ACTIONS.has(action)) throw failure(400, 'Неизвестное действие FunPay.');
  if (action === 'funpay.publish' || action === 'funpay.edit') checkFunPayListing(body);
  const key = typeof body.token === 'string' ? body.token.trim() : '';
  if (!/^[a-z\d._~%+-]{8,512}$/i.test(key)) throw failure(400, 'Укажи значение cookie golden_key из своего аккаунта FunPay.');
  const request = funpaySession(key);
  if (action === 'funpay.connect') {
    const profile = sellerPageData(await request('/'));
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
  if (creating && !(title && description && price && (amount || stock || internal.serverDelivery))) throw failure(400, 'Для публикации нужны название, описание, цена и количество или позиции автовыдачи.');
  if (creating && stock && amount && Number(amount) !== distinctItems.size) throw failure(400, 'Количество товара расходится с числом предоставленных позиций автовыдачи.');
  if (action === 'funpay.edit' && !(title || description || price || amount || stock || internal.active === true)) throw failure(400, 'Укажи изменения предложения.');

  if (!id(sellerPageData(await request('/'))?.userId)) {
    throw failure(401, 'FunPay не подтвердил вход в аккаунт продавца. Переподключи плагин.', 'FUNPAY_SAVE_SESSION');
  }
  // Record existing IDs before a native save so an older identical listing cannot be mistaken for this request.
  const priorOffers = creating && !internal.serverDelivery
    ? await sellerOfferIds(request, node, title).catch(() => null) : null;
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
      if (name === 'amount' && internal.serverDelivery && !controls.has(name)) continue;
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
    if (creating || internal.active === true) {
      if (internal.active === false) fields.delete('active');
      else fields.set('active', 'on');
    }
    if (internal.serverDelivery && (fields.has('auto_delivery') || fields.get('secrets'))) {
      throw failure(422, 'Встроенная выдача этого лота уже настроена. Серверная выдача не подключена.');
    }
  }
  const unconfirmed = creating
    ? 'FunPay не подтвердил публикацию конкретного предложения. Проверь список своих предложений перед повтором.'
    : 'FunPay не подтвердил сохранение. Проверь предложение на FunPay перед повтором.';
  const code = creating ? 'FUNPAY_PUBLICATION_UNCONFIRMED' : undefined;
  let response;
  let transportError;
  try {
    response = await request('/lots/offerSave', { body: payload, referer: editor });
  } catch (error) {
    if (error.status && error.status < 500) throw error;
    transportError = error;
  }
  const data = asJSON(response);
  if (sessionRejected(data)) throw saveSessionError(200);
  if (isSaveRejected(data)) throw saveRejection(data, 200);
  let saved = savedOffer(data, offer);
  if (saved === null && creating && (priorOffers || (internal.serverDelivery && internal.active === false))) {
    saved = await recoverPublication(request, node, payload, priorOffers).catch(() => null);
  }
  if (saved === null && internal.serverDelivery && internal.active === true &&
      await verifyActiveListing(request, editor, offer, actualNode, fields.get(TITLE)).catch(() => false)) {
    saved = offer;
  }
  if (saved === null) {
    throw Object.assign(failure(transportError ? 502 : 422, unconfirmed, code), {
      upstreamStatus: transportError?.upstreamStatus || (transportError ? undefined : 200),
      replyKind: transportError ? 'transport_error' : data?.url ? 'redirect_without_offer' :
        data ? 'json_without_offer' : 'non_json'
    });
  }
  return { offer: saved, ...(stock ? { added } : {}), node: actualNode };
}
