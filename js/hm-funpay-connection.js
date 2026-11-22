const name = 'harmonyai-funpay';

async function access(owner, mode, record) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
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
const metadata = owner => encoder.encode('hm-funpay:' + owner);

export async function save(owner, details) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: metadata(owner) },
    key, encoder.encode(JSON.stringify(details)));
  await access(owner, 'readwrite', { key, iv, encrypted });
}

export async function load(owner) {
  const record = await access(owner, 'readonly');
  if (!record) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: metadata(owner) },
      record.key, record.encrypted);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw Error('Не удалось расшифровать Golden Key. Удали сохранённое подключение и подключи FunPay заново.');
  }
}

export function remove(owner) {
  return access(owner, 'readwrite');
}
