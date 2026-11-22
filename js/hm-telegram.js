import { Api, TelegramClient, StringSession } from './vendor/teleproto-1.233.0.mjs';

const databaseName = 'harmonyai-telegram';
const active = new Map();
const jobs = new Map();
const revisions = new Map();

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storage(owner, mode, record) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode);
      const store = tx.objectStore('sessions');
      const request = mode === 'readonly' ? store.get(owner) : record ? store.put(record, owner) : store.delete(owner);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error('Не удалось сохранить сессию.'));
    });
  } finally { db.close(); }
}

const aad = owner => new TextEncoder().encode('hm-telegram:' + owner);

async function save(owner, details) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const content = new TextEncoder().encode(JSON.stringify(details));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner) }, key, content);
  await storage(owner, 'readwrite', { key, iv, encrypted });
}

async function restore(owner) {
  const record = await storage(owner, 'readonly');
  if (!record) return null;
  try {
    const content = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(owner) }, record.key, record.encrypted);
    return JSON.parse(new TextDecoder().decode(content));
  } catch {
    await storage(owner, 'readwrite');
    throw Error('Сохранённая сессия повреждена. Подключи Telegram заново.');
  }
}

export async function isSaved(owner) {
  return Boolean(await storage(owner, 'readonly'));
}

function createClient(details) {
  const client = new TelegramClient(new StringSession(details.session || ''), details.apiId, details.apiHash, {
    connectionRetries: 2, requestRetries: 2, autoReconnect: false, deviceModel: 'HarmonyAI Web'
  });
  client.setParseMode(undefined);
  client.setLogLevel('none');
  return client;
}

function useSession(owner, details, authenticate, signal) {
  if (jobs.has(owner)) return jobs.get(owner);
  const revision = revisions.get(owner) || 0;
  const job = (async () => {
    const client = createClient(details);
    try {
      await authenticate(client);
      const me = await client.getMe();
      if (!me || signal?.aborted || (revisions.get(owner) || 0) !== revision) throw Error('Не удалось открыть сессию Telegram.');
      const state = { client, name: [me.firstName, me.lastName].filter(Boolean).join(' '), peers: new Map([['me', 'me']]) };
      const previous = active.get(owner);
      if (previous) await previous.client.disconnect().catch(() => {});
      if (signal?.aborted || (revisions.get(owner) || 0) !== revision) throw Error('Сессия HarmonyAI закрыта.');
      await save(owner, { apiId: details.apiId, apiHash: details.apiHash, session: client.session.save() });
      if ((revisions.get(owner) || 0) !== revision) throw Error('Сессия HarmonyAI закрыта.');
      active.set(owner, state);
      return state;
    } catch (error) {
      await client.disconnect().catch(() => {});
      throw error;
    }
  })().finally(() => jobs.delete(owner));
  jobs.set(owner, job);
  return job;
}

export async function connect(owner, settings, ask, signal) {
  const apiId = Number(settings.apiId);
  const apiHash = String(settings.apiHash).trim();
  const phone = String(settings.phone).replace(/[\s()-]/g, '');
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiId > 2147483647 || !/^[a-f0-9]{32}$/i.test(apiHash) || !/^\+\d{7,15}$/.test(phone)) {
    throw Error('Проверь API ID, API Hash и номер телефона в международном формате.');
  }
  const state = await useSession(owner, { apiId, apiHash }, async client => {
    await client.start({
      phoneNumber: phone,
      phoneCode: viaApp => ask(viaApp ? 'Код из приложения Telegram' : 'Код подтверждения Telegram', 'code'),
      password: () => ask('Пароль двухэтапной аутентификации Telegram', 'password'),
      acceptTermsOfService: async () => false,
      firstAndLastNames: async () => { throw Error('AUTH_USER_CANCEL'); },
      onError: error => { throw error; }
    });
  }, signal);
  return state.name;
}

async function open(owner) {
  if (active.has(owner)) return active.get(owner);
  const details = await restore(owner);
  if (!details) throw Error('Подключи Telegram.');
  try {
    return await useSession(owner, details, async client => {
      await client.connect();
      await client.invoke(new Api.updates.GetState({}));
    });
  } catch (error) {
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(error.message)) {
      await storage(owner, 'readwrite');
      throw Error('Сессия Telegram истекла. Подключи аккаунт заново.');
    }
    throw error;
  }
}

export async function dialogs(owner) {
  const state = await open(owner);
  const dialogs = await state.client.getDialogs({ limit: 25 });
  const items = [{ id: 'me', name: 'Избранное' }];
  for (const item of dialogs) {
    const id = item.id?.toString();
    if (!id || !item.inputEntity || item.entity?.self) continue;
    state.peers.set(id, item.inputEntity);
    items.push({ id, name: item.title || item.name || id });
  }
  return items;
}

export async function messages(owner, id) {
  const state = await open(owner);
  const peer = state.peers.get(id);
  if (!peer) throw Error('Выбери чат из списка Telegram.');
  const items = await state.client.getMessages(peer, { limit: 10 });
  return items.filter(m => typeof m.message === 'string' && m.message).reverse()
    .map(m => ({ id: m.id, text: m.message, outgoing: m.out === true || id === 'me' }));
}

export async function send(owner, id, text, messageId) {
  const state = await open(owner);
  const peer = state.peers.get(id);
  const message = typeof text === 'string' ? text.trim() : '';
  if (!peer || !message || message.length > 4096) throw Error('Выбери чат и введи текст до 4096 символов.');
  if (messageId) await state.client.editMessage(peer, { message: messageId, text: message });
  else await state.client.sendMessage(peer, { message, linkPreview: false });
}

export async function disconnect(owner) {
  let revoked = false;
  try {
    const state = await open(owner);
    await state.client.invoke(new Api.auth.LogOut({}));
    revoked = true;
  } catch { /* Удаляем локальное подключение даже при недоступности Telegram. */ }
  finally {
    await lock(owner);
    await storage(owner, 'readwrite');
  }
  return revoked;
}

export async function lock(owner) {
  if (!owner) return;
  revisions.set(owner, (revisions.get(owner) || 0) + 1);
  const state = active.get(owner);
  active.delete(owner);
  await state?.client.disconnect().catch(() => {});
}
