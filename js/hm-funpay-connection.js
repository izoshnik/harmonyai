const name = 'harmonyai-funpay';

async function access(owner, mode, record, namespace = 'funpay') {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(namespace === 'funpay' ? name : 'harmonyai-github', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('connections');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('connections', mode);
      const store = tx.objectStore('connections');
      const request = mode === 'readonly' ? store.get(owner) : record ? store.put(record, owner) : store.delete(owner);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error('Не удалось обновить подключение FunPay.'));
    });
  } finally {
    db.close();
  }
}

const encoder = new TextEncoder();
const metadata = (owner, namespace) => encoder.encode('hm-' + namespace + ':' + owner);

export async function save(owner, details, namespace = 'funpay') {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: metadata(owner, namespace) },
    key, encoder.encode(JSON.stringify(details)));
  await access(owner, 'readwrite', { key, iv, encrypted }, namespace);
}

export async function load(owner, namespace = 'funpay') {
  const record = await access(owner, 'readonly', null, namespace);
  if (!record) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: metadata(owner, namespace) },
      record.key, record.encrypted);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw Error('Не удалось расшифровать сохранённое подключение. Подключи плагин заново.');
  }
}

export function remove(owner, namespace = 'funpay') {
  return access(owner, 'readwrite', null, namespace);
}
