import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './auth.js';
import { checkFunPayListing, funpay } from './funpay.js';
import { eventClient, numericId, orderLink } from './funpay-events.js';

const ACCOUNTS = 'funpay_automation_accounts';
const LOTS = 'funpay_automation_lots';
const EVENTS = 'funpay_automation_events';
const RULES = new Set(['message', 'confirmed', 'review']);
const COMMAND = /^![a-z0-9_]{1,24}$/;
const SKU = /\[HA-([A-F0-9]{12})\]$/;
const CONTROL = new Set(['funpay.automation.status', 'funpay.automation.enable', 'funpay.automation.disable', 'funpay.automation.rule']);
const defaults = {
  '!help': 'Команды продавца: $commands.',
  '!order': 'Текущий заказ: $order. Статус: $status.'
};
const failure = (status, message) => Object.assign(Error(message), { status });

function storageKey() {
  const hex = String(process.env.FUNPAY_AUTOMATION_KEY || '').trim();
  return /^[a-f\d]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function available() {
  return Boolean(storageKey() && String(process.env.FUNPAY_WORKER_SECRET || '').trim().length >= 32);
}

export function sealFunPay(owner, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey(), nonce);
  cipher.setAAD(Buffer.from(owner));
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

export function openFunPay(owner, sealed) {
  const bytes = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', storageKey(), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
}

function rest(table, filters = {}, method = 'GET', data, prefer) {
  const query = new URLSearchParams(filters).toString();
  return supabaseRest('/rest/v1/' + table + (query ? '?' + query : ''),
    { method, timeoutMs: 4000, ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(prefer ? { headers: { Prefer: prefer } } : {}) });
}

const rpc = (name, args) => rest('rpc/' + name, {}, 'POST', args);
const ownerFilter = owner => ({ owner: 'eq.' + owner });
const now = () => new Date().toISOString();
async function account(owner) {
  return (await rest(ACCOUNTS, ownerFilter(owner)))?.[0];
}

function numbers(items) {
  const lines = typeof items === 'string' && items.length <= 18000
    ? [...new Set(items.split(/\r?\n/).map(line => line.trim()).filter(Boolean))] : [];
  if (!lines.length || lines.length > 200 || lines.some(line => line.length > 900)) {
    throw failure(400, 'Укажи от 1 до 200 позиций выдачи, до 900 символов каждая.');
  }
  return lines;
}

export function managedTitle(title, sku) {
  const value = typeof title === 'string' ? title.trim() : '';
  if (!value || SKU.test(value) || value.length + sku.length + 6 > 120) {
    throw failure(400, 'Сократи название до 102 символов: HarmonyAI добавит к нему уникальный артикул.');
  }
  return value + ' [HA-' + sku + ']';
}

export function matchesDelivery(order, lot) {
  if (order.state !== 'paid' || !lot?.enabled || !lot.offer || order.node !== lot.category) return false;
  if (order.offer) return order.offer === lot.offer;
  return order.title === lot.title && order.title.match(SKU)?.[1] === lot.sku;
}

export function renderFunPayTemplate(template, { order, commands = '' } = {}) {
  const statuses = { paid: 'оплачен', closed: 'закрыт', refunded: 'возврат', partially_refunded: 'частичный возврат', unpaid: 'не оплачен' };
  const values = { order: order ? orderLink(order.id) : 'нет доступного заказа', status: statuses[order?.state] || 'не определён', commands };
  return template.replace(/\$(order|status|commands)\b/g, (_, key) => values[key]).slice(0, 1700);
}

export function selectFunPayReply(message, sales, rules) {
  const command = message.text.trim().split(/\s+/, 1)[0].toLowerCase();
  const commands = Object.fromEntries(Object.entries({ ...defaults, ...rules }).filter(([key, value]) => COMMAND.test(key) && value));
  const template = COMMAND.test(command) ? commands[command] : rules.message;
  if (!template) return '';
  const own = sales.filter(order => order.buyer === message.buyer && ['paid', 'closed'].includes(order.state));
  const order = own.find(order => order.state === 'paid') || own[0];
  return renderFunPayTemplate(template, { order, commands: Object.keys(commands).sort().join(', ') });
}

function status(row) {
  return {
    available: available(),
    enabled: Boolean(row),
    ready: Boolean(row?.cursor && row.last_poll && Date.now() - Date.parse(row.last_poll) < 180000 && !row.issue),
    lastPoll: row?.last_poll || '',
    issue: row?.issue || '',
    rules: row ? Object.entries({ ...defaults, ...row.rules }).filter(([, value]) => value).map(([name]) => name) : []
  };
}

export function automationAction(action) { return CONTROL.has(action); }

export async function manageAutomation(action, owner, body) {
  if (!available()) {
    if (action === 'funpay.automation.status') return status();
    throw failure(503, 'Серверная автоматизация FunPay ещё не подключена администратором.');
  }
  if (action === 'funpay.automation.status') {
    const row = await account(owner);
    if (!row) return status();
    const oldReservation = new Date(Date.now() - 120000).toISOString();
    const recent = await rest(EVENTS, { ...ownerFilter(owner),
      or: '(state.in.(check,waiting),and(state.eq.reserved,created_at.lt.' + oldReservation + '))', select: 'event_key,state',
      order: 'created_at.desc', limit: '8' });
    return { ...status(row), pending: recent.map(event => ({ event: event.event_key, state: event.state })) };
  }
  if (action === 'funpay.automation.disable') {
    await rest(ACCOUNTS, ownerFilter(owner), 'DELETE');
    return status();
  }
  if (action === 'funpay.automation.enable') {
    const client = await eventClient(body.token);
    const current = await account(owner);
    if (current && current.seller_id !== client.seller) throw failure(409, 'Сначала отключи прежний аккаунт продавца в настройках.');
    const values = { owner, seller_id: client.seller, credential: sealFunPay(owner, body.token), next_poll: now(), issue: null };
    try {
      await rest(ACCOUNTS, { on_conflict: 'owner' }, 'POST', values, 'resolution=merge-duplicates');
    } catch {
      throw failure(409, 'Не удалось подключить аккаунт. Проверь миграцию Supabase и что FunPay не подключён к другому аккаунту HarmonyAI.');
    }
    return status(await account(owner));
  }
  const name = typeof body.rule === 'string' ? body.rule.toLowerCase().trim() : '';
  if (!RULES.has(name) && !COMMAND.test(name)) throw failure(400, 'Укажи тип автоответа или короткую команду, начинающуюся с !.');
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  if (body.remove !== true && (!reply || reply.length > 1500)) throw failure(400, 'Укажи текст ответа до 1500 символов.');
  if (name === 'review' && /\$(?:order|status|commands)\b/.test(reply)) throw failure(400, 'Ответ на отзыв публичный. Для него укажи текст без переменных заказа.');
  const removed = body.remove === true;
  const saved = await rpc('funpay_set_rule', {
    p_owner: owner, p_name: name, p_body: removed ? (Object.hasOwn(defaults, name) ? '' : null) : reply
  });
  if (!saved) throw failure(409, 'Включи серверную автоматизацию FunPay в настройках плагина.');
  return { rule: name, removed };
}

export async function automateListing(action, owner, body) {
  if (action === 'funpay.publish' || action === 'funpay.edit') checkFunPayListing(body);
  if (!available()) {
    if (body.serverDelivery === true) throw failure(503, 'Серверная автоматизация FunPay ещё не подключена администратором.');
    return funpay(action, body);
  }
  const publishing = action === 'funpay.publish' && (body.stock !== undefined || body.serverDelivery === true);
  const editing = ['funpay.edit', 'funpay.stock', 'funpay.delete'].includes(action) && numericId(body.offer);
  if (!publishing && !editing) return funpay(action, body);
  const profile = await account(owner);
  if (body.serverDelivery === true && !profile) throw failure(409, 'Включи серверную автоматизацию FunPay в настройках плагина.');
  if (!profile) return funpay(action, body);
  const token = openFunPay(owner, profile.credential);
  if (body.token && body.token !== token) throw failure(409, 'Ключ браузера отличается от серверного подключения FunPay. Обнови серверное подключение в настройках.');

  if (publishing) {
    if (!status(profile).ready) throw failure(409, 'Серверная выдача ещё не проверила аккаунт. Статус обновится после фонового запуска.');
    const items = numbers(body.stock);
    const reusable = body.reuseStock === true;
    if (reusable && items.length !== 1) throw failure(400, 'Для повторной выдачи укажи один одинаковый материал для всех покупателей.');
    const sku = randomBytes(6).toString('hex').toUpperCase();
    const title = managedTitle(body.title, sku);
    const amount = reusable ? body.amount || '1' : String(items.length);
    if (!reusable && body.amount && String(body.amount) !== amount) throw failure(400, 'Число позиций отличается от указанного количества товара.');
    await rest(LOTS, {}, 'POST', { owner, sku, category: body.node, title, items: items.map(item => sealFunPay(owner, item)), reusable });
    const { stock, ...listing } = body;
    const draft = await funpay('funpay.publish', { ...listing, token, title, amount }, { serverDelivery: true, active: false });
    const target = { ...ownerFilter(owner), sku: 'eq.' + sku };
    try {
      const saved = await rest(LOTS, target, 'PATCH', { offer: draft.offer, enabled: true }, 'return=representation');
      if (!saved?.length) throw Error('Draft was not registered');
      await funpay('funpay.edit', { token, offer: draft.offer }, { serverDelivery: true, active: true });
    } catch {
      throw Object.assign(failure(502, 'FunPay сохранил черновик №' + draft.offer + ', но активация не подтверждена. Проверь этот лот в кабинете перед повтором.'),
        { code: 'FUNPAY_PUBLICATION_UNCONFIRMED' });
    }
    return { ...draft, added: items.length, delivery: 'server', sku, reusable };
  }
  const target = { ...ownerFilter(owner), offer: 'eq.' + body.offer };
  const lot = (await rest(LOTS, target))?.[0];
  if (!lot) {
    if (body.serverDelivery === true) throw failure(409, 'Этот лот не подключён к серверной выдаче HarmonyAI.');
    return funpay(action, body);
  }
  if (action === 'funpay.delete') {
    const deleted = await funpay(action, { ...body, token });
    await rest(LOTS, target, 'PATCH', { enabled: false, items: [] });
    return deleted;
  }
  const { stock, ...changes } = body;
  const update = stock !== undefined ? numbers(stock) : [];
  if (lot.reusable && update.length > 1) throw failure(400, 'Для этого лота можно сохранить один повторно выдаваемый материал.');
  const title = body.title ? managedTitle(body.title, lot.sku) : '';
  if (body.title || body.description || body.price || body.amount) {
    await funpay('funpay.edit', { ...changes, ...(title ? { title } : {}), token }, { serverDelivery: true });
    if (title) await rest(LOTS, target, 'PATCH', { title });
  }
  if (update.length) {
    const saved = await rpc('funpay_stock_add', { p_owner: owner, p_offer: body.offer, p_items: update.map(item => sealFunPay(owner, item)) });
    if (!saved) throw failure(409, 'Не удалось пополнить серверный запас лота.');
  }
  return { offer: body.offer, node: lot.category, ...(update.length ? { added: update.length, delivery: 'server' } : {}) };
}

function workerAuthorized(req) {
  if (!available()) return false;
  const expected = Buffer.from('Bearer ' + process.env.FUNPAY_WORKER_SECRET.trim());
  const supplied = Buffer.from(String(req.headers?.authorization || ''));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function sendOnce(row, event, send, lot, amount = 1) {
  const [claim] = await rpc('funpay_claim_event',
    { p_owner: row.owner, p_lease: row.lease_id, p_event: event, p_sku: lot?.sku ?? null, p_order_amount: amount });
  if (!claim || claim.state !== 'reserved') return;
  const where = { ...ownerFilter(row.owner), event_key: 'eq.' + event, state: 'eq.reserved' };
  try {
    const items = (claim.items || []).map(value => openFunPay(row.owner, value));
    await send(items);
  } catch {
    await rest(EVENTS, where, 'PATCH', { state: 'check' });
    return 'Проверь журнал: FunPay не подтвердил одно из действий.';
  }
  await rest(EVENTS, where, 'PATCH', { state: 'sent', items: [] });
}

export async function pollFunPayAccount(row, deadline) {
  const client = await eventClient(openFunPay(row.owner, row.credential));
  if (row.seller_id !== client.seller) throw failure(401, 'Сессия продавца FunPay изменилась.');
  const [sales, chats, lots] = await Promise.all([
    client.sales(), client.chats(), rest(LOTS, { ...ownerFilter(row.owner), enabled: 'eq.true' })
  ]);
  const initial = !row.cursor;
  const prior = row.cursor || { chats: {}, orders: {}, latest: 0 };
  const next = { chats: { ...prior.chats }, orders: { ...prior.orders }, latest: prior.latest || 0 };
  const rules = row.rules || {};
  let issue;
  if (!initial) {
    for (const order of sales) {
      if (Date.now() >= deadline) break;
      const lot = lots.find(entry => matchesDelivery(order, entry));
      if (lot && (lot.reusable || (Number.isInteger(order.amount) && order.amount >= 1 && order.amount <= 100))) {
        issue = await sendOnce(row, 'delivery:' + order.id, items => {
          const content = items.join('\n');
          if (!content || content.length > 1700) throw Error('Материал выдачи не помещается в сообщение FunPay.');
          return client.send(order.chat, content);
        }, lot, lot.reusable ? 1 : order.amount) || issue;
      }
      if (rules.confirmed && prior.orders[order.id]?.state === 'paid' && order.state === 'closed' &&
          Date.now() < deadline && await client.buyerConfirmed(order) && Date.now() < deadline) {
        issue = await sendOnce(row, 'confirmed:' + order.id, () => client.send(order.chat,
          renderFunPayTemplate(rules.confirmed, { order }))) || issue;
      }
      if (rules.review && prior.orders[order.id] && !prior.orders[order.id].review && order.review && Date.now() < deadline) {
        issue = await sendOnce(row, 'review:' + order.id, () => client.review(order.id, rules.review)) || issue;
      }
      next.orders[order.id] = { state: order.state, review: order.review };
    }
    const changed = chats.filter(chat => Number(chat.latest) > Number(prior.chats[chat.chat] || prior.latest)).slice(0, 8);
    if (changed.length && Date.now() < deadline) {
      const messages = await client.messages(changed.map(item => item.chat));
      for (const chat of changed) {
        if (Date.now() >= deadline) break;
        const last = Number(prior.chats[chat.chat] || prior.latest);
        const latest = messages.filter(message => message.chat === chat.chat && Number(message.id) > last)
          .sort((a, b) => Number(b.id) - Number(a.id))[0];
        const reply = latest ? selectFunPayReply(latest, sales, rules) : '';
        if (reply) issue = await sendOnce(row, 'message:' + chat.chat + ':' + latest.id, () => client.send(chat.chat, reply)) || issue;
        next.chats[chat.chat] = chat.latest;
      }
    }
  } else {
    for (const order of sales) next.orders[order.id] = { state: order.state, review: order.review };
    for (const chat of chats) next.chats[chat.chat] = chat.latest;
    next.latest = Math.max(0, ...chats.map(chat => Number(chat.latest)));
  }
  next.chats = Object.fromEntries(Object.entries(next.chats).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 180));
  next.orders = Object.fromEntries(Object.entries(next.orders).slice(-140));
  return { last_poll: now(), cursor: next, issue: issue || null };
}

export async function funpayWorker(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });
  const deadline = Date.now() + 39000;
  const lease = randomUUID();
  try {
    const [row] = await rpc('funpay_claim_account', { p_lease: lease });
    if (!row) return res.status(200).json({ checked: 0 });
    let update;
    try {
      update = await pollFunPayAccount(row, deadline);
    } catch (error) {
      update = { issue: error.status === 401
        ? 'Сессия FunPay истекла. Обнови серверное подключение в настройках.'
        : 'Фоновая проверка FunPay не завершилась.' };
    }
    await rest(ACCOUNTS, { ...ownerFilter(row.owner), lease_id: 'eq.' + lease }, 'PATCH', {
      ...update, lease_until: null, lease_id: null, next_poll: new Date(Date.now() + (update.last_poll ? 45000 : 180000)).toISOString()
    });
    return res.status(200).json({ checked: 1, ok: Boolean(update.last_poll) });
  } catch {
    return res.status(503).json({ error: 'FunPay worker unavailable' });
  }
}
