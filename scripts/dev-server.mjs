/* ЛОКАЛЬНЫЙ СЕРВЕР С ЗАГОЛОВКАМИ ПРОДА.
     node scripts/dev-server.mjs [порт]      → http://localhost:8766/app.html
   Отдаёт файлы репозитория с теми же заголовками, что Vercel (vercel.json,
   источник "/(.*)"), в первую очередь с Content-Security-Policy. Обычный
   `python3 -m http.server` заголовков не ставит, поэтому запрос к новому домену
   или скрипт с нового CDN локально работает, а на проде блокируется CSP.
   Всё, что ходит в сеть из браузера или запускает Worker, проверять здесь.
   /api/* здесь нет — подменяйте запросы в тесте или ходите на прод. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8766;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries((cfg.headers.find((h) => h.source === '/(.*)')?.headers || []).map((x) => [x.key, x.value]));
const pages = { '/': '/landing.html', '/chat': '/app.html', '/login': '/app.html', '/settings': '/app.html' };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  let url = decodeURIComponent(String(req.url).split('?')[0]);
  url = pages[url] || (url.startsWith('/chat/') ? '/app.html' : url);
  const file = path.join(root, url);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, headers); res.end('not found'); return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}/app.html (заголовки из vercel.json)`));
