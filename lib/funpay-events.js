import { decodeFunPayHtml as decode, funpaySession } from './funpay.js';

export const orderId = value => /^[A-Z0-9]{5,24}$/.test(String(value || '')) ? String(value) : '';
export const numericId = value => /^[1-9]\d{0,14}$/.test(String(value || '')) ? String(value) : '';
export const orderLink = id => 'https://funpay.com/orders/' + id + '/';
const orderStatus = new Set(['unpaid', 'paid', 'closed', 'refunded', 'partially_refunded']);

function attribute(markup, name) {
  const value = markup.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
  return decode(value?.[1] ?? value?.[2] ?? '');
}

function plain(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
}

export function parseSeller(html) {
  const tag = String(html).match(/<body\b[^>]*>/i)?.[0] || '';
  const data = JSON.parse(attribute(tag, 'data-app-data') || '{}');
  const id = numericId(data.userId);
  const csrf = typeof data['csrf-token'] === 'string' ? data['csrf-token'] : '';
  if (!id || !csrf) throw Object.assign(Error('FunPay не подтвердил сессию продавца.'), { status: 401 });
  return { id, csrf };
}

export function parseSaleIds(html) {
  if (!/<h1\b[^>]*\bpage-header\b[^>]*>\s*(?:мои продажи|my sales|мої продажі)(?=\s|<|$)/iu.test(html)) {
    throw Error('FunPay не вернул список продаж.');
  }
  const ids = new Set();
  for (const [tag] of String(html).matchAll(/<a\b[^>]*>/gi)) {
    if (!attribute(tag, 'class').split(/\s+/).includes('tc-item')) continue;
    const match = attribute(tag, 'href').match(/^(?:https:\/\/funpay\.com)?\/(?:(?:en|uk)\/)?orders\/([A-Z0-9]{5,24})\/?$/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

export function parseOrder(raw, expectedSeller, expectedId) {
  if (orderId(raw?.order_uid) !== expectedId || numericId(raw.seller?.user_id) !== expectedSeller ||
      !orderStatus.has(raw.status)) return null;
  const buyer = numericId(raw.buyer?.user_id);
  if (!buyer || buyer === expectedSeller) return null;
  const pair = raw.chat?.node_name?.match(/^users-(\d+)-(\d+)$/)?.slice(1);
  if (!pair?.includes(expectedSeller) || !pair.includes(buyer)) return null;
  const fields = raw.type_data?.fields || {};
  const title = Object.entries(fields).find(([name, field]) =>
    /^(?:summary(?:\[(?:ru|en|uk)\])?|fields\[summary\](?:\[(?:ru|en|uk)\])?)$/.test(name) ||
    /^(?:краткое описание|short description|короткий опис)$/iu.test(field?.name || '')
  )?.[1]?.value;
  const explicitOffer = numericId(raw.offer_id || raw.type_data?.offer_id);
  const node = raw.section?.type_id === 'lot' ? numericId(raw.section?.local_id) : '';
  return {
    id: expectedId, buyer, chat: raw.chat.node_name, state: raw.status, node, offer: explicitOffer,
    title: typeof title === 'string' ? title.trim() : '',
    amount: Number(raw.type_data?.amount),
    review: Boolean(raw.review && raw.review.hidden === false && !raw.review.reply &&
      Number(raw.review.rating) >= 1 && Number(raw.review.rating) <= 5)
  };
}

function parseChats(html) {
  const chats = [];
  for (const [tag] of String(html || '').matchAll(/<a\b[^>]*>/gi)) {
    if (!attribute(tag, 'class').split(/\s+/).includes('contact-item')) continue;
    const chat = numericId(attribute(tag, 'data-id'));
    const latest = numericId(attribute(tag, 'data-node-msg'));
    if (chat && latest) chats.push({ chat, latest });
  }
  return chats;
}

function chatObject(id) {
  return { type: 'chat_node', id, tag: '00000000', data: { node: id, last_message: -1, content: '' } };
}

export async function eventClient(token) {
  const request = funpaySession(token);
  const seller = parseSeller(await request('/'));
  const callback = async (objects, action) => {
    const body = new URLSearchParams({ objects: JSON.stringify(objects), request: action ? JSON.stringify(action) : 'false', csrf_token: seller.csrf });
    const data = JSON.parse(await request('/runner/', { body, referer: '/chat/' }));
    if (!Array.isArray(data.objects)) throw Error('FunPay не вернул события чата.');
    return data;
  };
  return {
    seller: seller.id,
    async sales() {
      const ids = parseSaleIds(await request('/orders/trade')).slice(0, 40);
      const orders = [];
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const body = JSON.stringify({ order_uids: batch, include: ['details', 'users', 'review'] });
        const reply = JSON.parse(await request('/api/orders/get', { body, referer: '/orders/trade' }));
        if (reply.status !== 'SUCCESS' || !reply.data) throw Error('FunPay не подтвердил детали заказов.');
        for (const id of batch) {
          const order = parseOrder(reply.data[id], seller.id, id);
          if (order) orders.push(order);
        }
      }
      return orders;
    },
    async chats() {
      const result = await callback([{ type: 'chat_bookmarks', id: Number(seller.id), tag: '00000000', data: false }]);
      const bookmark = result.objects.find(o => o.type === 'chat_bookmarks')?.data?.html;
      if (typeof bookmark !== 'string') throw Error('FunPay не подтвердил состояние чатов.');
      return parseChats(bookmark);
    },
    async messages(chats) {
      const result = await callback(chats.map(chat => chatObject(Number(chat))));
      return result.objects.flatMap(object => {
        if (object.type !== 'chat_node' || object.data?.node?.silent !== false) return [];
        const chat = numericId(object.data.node.id);
        const ids = object.data.node.name?.match(/^users-(\d+)-(\d+)$/)?.slice(1);
        if (!chats.includes(chat) || !ids?.includes(seller.id)) return [];
        const buyer = ids.find(id => id !== seller.id);
        if (!numericId(buyer)) return [];
        return (object.data.messages || []).flatMap(raw => {
          const id = numericId(raw.id);
          if (!id || numericId(raw.author) !== buyer) return [];
          const content = String(raw.html || '');
          if (/chat-msg-author-label|chat-img-link/.test(content)) return [];
          const text = plain(content.match(/<div\b[^>]*class="[^"]*\bchat-msg-text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
          return text ? [{ id, chat, buyer, text }] : [];
        });
      });
    },
    async send(chat, text) {
      if (!numericId(chat) && !/^users-[1-9]\d*-[1-9]\d*$/.test(chat)) throw Error('Неизвестный чат FunPay.');
      const target = numericId(chat) ? Number(chat) : chat;
      const data = await callback([chatObject(target)], { action: 'chat_message', data: { node: target, last_message: -1, content: text } });
      if (!data.response || data.response.error) throw Error('FunPay не подтвердил отправку сообщения.');
    },
    async buyerConfirmed(order) {
      const data = await callback([chatObject(order.chat)]);
      const node = data.objects.find(item => item.type === 'chat_node' && item.data?.node?.name === order.chat)?.data;
      return (node?.messages || []).some(message => {
        if (message.author !== 0 && message.author !== '0') return false;
        const html = String(message.html || '');
        const actor = html.match(/<a\b[^>]*href="(?:https:\/\/funpay\.com)?\/users\/([1-9]\d*)\/"/i)?.[1];
        const linked = html.includes('/orders/' + order.id + '/');
        return actor === order.buyer && linked &&
          /(?:подтвердил[а]?\s+(?:выполнение\s+)?заказ|підтвердив\s+(?:виконання\s+)?замовлення|confirmed\s+(?:completion\s+of\s+)?(?:the\s+)?order)/iu.test(plain(html));
      });
    },
    async review(id, text) {
      if (!orderId(id)) throw Error('Неизвестный заказ.');
      const body = new URLSearchParams({ authorId: seller.id, text, rating: '', csrf_token: seller.csrf, orderId: id });
      const response = JSON.parse(await request('/orders/review', { body, referer: '/orders/' + id + '/' }));
      if (typeof response.content !== 'string' || !response.content || response.error) throw Error('FunPay не подтвердил ответ на отзыв.');
    }
  };
}
