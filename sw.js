/* HarmonyAI — service worker веб-приложения.
   Стратегия простая и без «залипших» версий:
     • страницы и наши /css /js /icons — сначала сеть, кэш только как запас
       на случай офлайна (так новая версия сайта видна сразу после выкладки);
     • библиотеки с CDN (версии зашиты в адрес) — из кэша, сеть только в первый раз;
     • /api, /v1, авторизация, Supabase, Яндекс — никогда не кэшируем. */
const VERSION = 'hm-2026-10-27';
const SHELL = ['/chat', '/manifest.webmanifest', '/icons/icon-192.png', '/favicon.svg'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|esm\.sh|fonts\.(googleapis|gstatic)\.com)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req, fallbackUrl) {
  return fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (fallbackUrl ? caches.match(fallbackUrl) : undefined)).then((hit) => hit || Response.error()));
}

function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (/^\/(api|v1|mcp)(\/|$)/.test(url.pathname) || url.pathname === '/sw.js') return;
    if (req.mode === 'navigate') {
      const appRoute = /^\/(chat|settings|login)(\/|$)/.test(url.pathname);
      event.respondWith(networkFirst(req, appRoute ? '/chat' : null));
      return;
    }
    if (/^\/(css|js|icons)\//.test(url.pathname) || /\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname)) {
      event.respondWith(networkFirst(req));
    }
    return;
  }
  if (CDN.test(req.url)) event.respondWith(cacheFirst(req));
});
