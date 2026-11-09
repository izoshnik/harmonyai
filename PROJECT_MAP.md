# HarmonyAI — карта проекта

Этот файл написан для ИИ-ассистента, который впервые видит репозиторий. Прочитав его, можно
сразу править код: понятно, что где лежит, как проходит запрос и какие правила нельзя нарушать.

- Состояние на: 9 ноября 2026, версия **Beta 0.8.101**.
- Репозиторий: `izoshnik/harmonyai`. Сайт: https://harmonyai.ru.
- Рядом лежит `PROJECT_MAP.html` — старая визуальная карта для человека (граф файлов), она
  отстаёт от кода. Источник правды для ИИ — этот файл и сам код.
- Обязательные правила ассистента — в `CLAUDE.md` (версия, каналы поддержки). Они важнее этого файла.

---

## 1. Что это за продукт

HarmonyAI — русскоязычный ИИ-помощник в браузере: универсальный чат с упором на музыку и учёбу
(сольфеджио, музыкальная школа, школьные предметы). Интерфейс переведён на en, fr, de, es, it, zh.

Что умеет:

| Область | Возможности |
| --- | --- |
| Чат | Потоковые ответы, режим «Думать», 4 уровня усилия, веб-поиск, память о пользователе, временный чат, «Поделиться чатом» |
| Вложения | Фото (до 20), PDF/DOCX/XLSX/PPTX/ZIP/код (читаются в браузере), аудио, запись с микрофона |
| Музыкальная теория | Точный расчёт нот, интервалов, аккордов, оборотов и билетов алгоритмом, нотный стан из ABC |
| Картинки | Генерация и правка (Free — Flux, Pro — gpt-image), до 4 за раз |
| Видео | Генерация по описанию; ИИ «смотрит» ролики YouTube/TikTok по ссылке; поиск фильмов на Rutube/YouTube с плеером в чате |
| Музыка | Яндекс Музыка + Audius + Jamendo: поиск, общий плеер, очередь, «Моя волна», плейлисты, скачивание |
| Аудио | Разбор трека (темп, тональность), распознавание, ноты мелодии, разделение на партии (убрать вокал) |
| Файлы | ИИ создаёт PDF/DOCX/PPTX/MD/TXT; «мини-компьютер» справа для кода и HTML |
| Прочее | Временная почта, ИИ-поддержка, публичный API в формате Anthropic Messages, MCP |

Тарифы: **Free** (модель «Adan») и **Pro** (модель «Dynatos», лимиты ×25). Оплата — ЮKassa.

---

## 2. Стек и главные ограничения

| Что | Как сделано |
| --- | --- |
| Хостинг | Vercel, план Hobby, регион `fra1`. Автодеплой из `main`; на каждый PR — превью (закрыто защитой Vercel, API оттуда даёт 401) |
| Фронтенд | Статические файлы без сборки. Чат — один файл `app.html` (~17 700 строк: CSS + HTML + JS). Ванильный JS, глобальные функции |
| Сервер | Serverless-функции Vercel, Node 24, ES-модули. **Ноль npm-зависимостей** — только встроенные `fetch` и `node:crypto` |
| База | Supabase: вход (OTP на почту, Google/Discord/GitHub, 2FA TOTP), Postgres, Storage |
| Платежи | ЮKassa, разовые платежи без автосписаний |
| Почта | Resend |
| Тесты | `npm test` → `node --test tests/*.test.mjs` (105 тестов) |

**Жёсткие ограничения — нарушать нельзя:**

1. **Лимит 12 serverless-функций.** Сейчас в `api/` их 11. Новую функцию заводить нельзя:
   серверный код кладётся в `lib/` и подключается к существующему роутеру —
   `api/util.js` (`?op=`), `api/account.js` (`action`), `api/music.js` (`action`).
   Файл в `api/**` = функция, поэтому библиотеки лежат только в `lib/`.
2. **Тело запроса ≤ 4,5 МБ** (Vercel). Клиент пережимает фото (`hmFitPayload`); большие файлы идут
   напрямую в Supabase Storage по подписанной ссылке.
3. **Никаких npm-пакетов и сборщиков.** Библиотеки в браузере — с CDN (jsDelivr, cdnjs, unpkg), лениво.
4. **CSP.** Сайт отдаёт строгий `Content-Security-Policy` (`vercel.json` → `headers`). Любой новый
   домен, куда браузер шлёт запрос, нужно добавить в `connect-src`; новый CDN скриптов — в
   `script-src`; а то, что импортирует Web Worker, — ещё и в `worker-src`. Иначе на проде запрос
   молча блокируется, хотя локально всё работает (раздел 15, «Проверка в браузере»).
5. **Секреты не коммитятся.** Все ключи — в переменных Vercel. Пароль dev-аккаунта в репозитории не хранится.
6. **Внутренние имена моделей и провайдеров пользователю не показываются.** Наружу — только
   «Adan»/«Dynatos» (`adanatos`/`dynatos`). Системный промпт запрещает модели раскрывать их.
7. **Модели семейства «5.4» запрещены** — `pickModel()` в `lib/models.js` заменяет их.

---

## 3. Структура репозитория

```
app.html               чат-приложение целиком (маршруты /chat, /chat/:id, /login, /settings)
landing.html           главная (/)
about / contacts / help / subscribe / 404 .html   страницы сайта
api-docs.html          документация публичного API (/api)
api-dashboard.html     кабинет API: ключи, баланс, расход (/api/dashboard)
management.html        панель управления сервисом (/management), только персонал
legal/                 оферта, политика, условия
seo/                   6 SEO-страниц, генерирует scripts/build-seo-pages.mjs (не править руками)
scripts/dev-server.mjs локальный сервер с заголовками прода (CSP) — для проверки в браузере
api/                   11 serverless-функций (раздел 5)
lib/                   серверные модули (раздел 6)
js/                    клиентские модули, подключаются в app.html через <script defer> (раздел 8)
js/i18n/               словари переводов страниц сайта
css/                   стили модулей; основная масса CSS чата — внутри app.html
i18n.js, i18_dict.js   движок переводов и словарь приложения
sw.js                  service worker (PWA)
supabase/              SQL-миграции — пользователь запускает их в Supabase вручную
tests/                 тесты node:test
vercel.json            rewrites, заголовки, CSP
CLAUDE.md              правила для ассистента
QA_REPORT.md           старый отчёт проверки, не актуален
_i18n_*.json           исходники переводов; рабочий словарь — i18_dict.js
```

---

## 4. Адреса (vercel.json → rewrites)

| Адрес | Куда |
| --- | --- |
| `/` | `landing.html` |
| `/login`, `/chat`, `/chat/:id`, `/settings` | `app.html` |
| `/about`, `/contacts`, `/subscribe`, `/help` | одноимённые страницы |
| `/management` | `management.html` |
| `/api` | `api-docs.html` |
| `/api/dashboard` | `api-dashboard.html` |
| `/api/harmony` | `/api/chat` (старое имя, клиент пробует оба) |
| `/api/intent`, `/api/music-intent`, `/api/title`, `/api/detect-locale` | `/api/util?op=…` |
| `/v1/*` | `/api/v1?path=…` (публичный API) |
| `/mcp`, `/mcp/:key` | `/api/v1?path=mcp` |
| `/muzykalnyj-ii` и ещё 5 | `seo/*.html` |

Заголовки для `/api/*`: `Cache-Control: no-store`, `X-Accel-Buffering: no` (нужно для SSE).

---

## 5. Serverless-функции (`api/`)

| Файл | maxDuration | Что делает |
| --- | --- | --- |
| `chat.js` (3081 строка) | 300 с | Чат: лимиты, контекст, музыкальное ядро, поиск, цепочки моделей, SSE. Также `GET ?warm=1` (прогрев) и `GET/DELETE ?job=<id>` (восстановление ответа) |
| `util.js` | 60 с | Роутер мелких операций по `?op=` (список ниже) |
| `account.js` | 15 с | Кабинет API, подписка, рефералы, «Поделиться чатом», вход dev-аккаунта, панель управления (`action=admin.*`) |
| `v1.js` | — | Публичный API: `POST /v1/messages`, `/v1/messages/count_tokens`, `GET /v1/models`, MCP |
| `generate-image.js` | 150 с | Картинки и правка картинок, модерация промпта, лимиты |
| `generate-file.js` | 30 с | Серверная сборка md/txt (PDF/DOCX/PPTX собирает браузер) |
| `music.js` | 60 с | Музыка: Яндекс + Audius/Jamendo, по полю `action` |
| `recognize.js` | 60 с | Распознавание трека (AudD) и нотный диктант, только Pro |
| `reports.js` | 30 с | Сообщения о проблемах в приложении |
| `payment/create.js` | 15 с | Создать платёж ЮKassa (подписка или баланс API) |
| `payment/webhook.js` | 15 с | Вебхук ЮKassa — **единственное место, где начисляются деньги** |

### `api/util.js` — операции `?op=`

| op | Модуль в `lib/` | Назначение |
| --- | --- | --- |
| `intent` | `util-intent.js` | Просит ли пользователь картинку; сколько; английские промпты; скрытый поиск референса |
| `music-intent` | `util-music-intent.js` | LLM-классификатор музыкальных просьб |
| `title` | `util-title.js` | Название чата |
| `detect-locale` | `util-detect-locale.js` | Язык по IP |
| `agent` | `util-agent.js` → `ai-tasks.js` | ИИ-агент: какое действие выполнить (раздел 9) |
| `memory` | `util-memory.js` | Что запомнить/забыть о пользователе |
| `profile-summary` | `util-profile-summary.js` | Сводка «О вас» |
| `ocr` | `util-ocr.js` | Расшифровка фото |
| `video` | `util-video.js` → `video.js`, `video-watch.js` | Кинотеатр и просмотр роликов |
| `video-gen` | `util-video-gen.js` → `video-gen.js` | Генерация видео |
| `support` | `util-support.js` | ИИ-поддержка и отчёты об ошибках |
| `tempmail` | `util-tempmail.js` | Временная почта |
| `unsubscribe` | `mailer.js` | Отписка от рассылки |
| `ingest-url/-text/-proxy/-distill` | `textbook-ingestor.js` | Загрузка учебников в базу знаний (персонал) |

### `api/account.js` — действия

- GET: `overview`, `keys`, `balance`, `payments`, `usage`, `pricing`, `subscription`, `referral`, `share&token=`.
- POST: `keys.create|rotate|revoke|delete|rename`, `share.create|revoke`, `referral.create|redeem`,
  `dev_instant_login`, `errors.report`, `stats.rate`.
- Панель управления (`lib/admin.js`): `admin.me|overview|usage|users|user|finance|api|providers|`
  `retention|features|feedback|errors|action|probe|mail|mail_send|mail_continue|mail_test`.
  - `GET /api/account?action=admin.errors&q=<КОД>&days=N` — найти причину ошибки по коду.
  - `POST admin.probe` — проверить, какие модели сейчас отвечают.

### `api/music.js` — действия (POST `{action,…}`)

`status`, `search`, `suggest`, `resolve`, `play`, `prefetch`, `tracks`, `album`, `artist`, `playlist`,
`wave`, `wave_feedback`, `like`, `liked_ids`, `liked_tracks`, `listening_stats`, `ai_playlist`,
`export_playlist`, `auth_start|poll|token|disconnect`, `ugc_prepare|upload|from_storage|check|target`,
`ext_search`, `ext_wave`, `ext_tracks`. Плюс `GET ?ext=<au:id|jm:id>[&dl=1]` — редирект 302 на аудиофайл.

---

## 6. Серверные модули (`lib/`)

### Модели и провайдеры

| Файл | Назначение |
| --- | --- |
| `models.js` | Единый реестр моделей. `providerForModel()`, `providerFetch()` (авторизация и переписывание имени модели), `pickModel()`, `envModel()`, паузы моделей `coolDownModel()`/`isCoolingDown()` |
| `model-catalog.js` | Бесплатные провайдеры NIM/Cerebras/Groq: раз в час читает `/models`, ранжирует по таблице `STRENGTH`. `rankedFreeChain()`, `fastUtilityModels()` |
| `ai-tasks.js` | Служебные вызовы модели с JSON-ответом: агент, план поиска, статус-фразы, плейлисты, память. `callJson()` |
| `anthropic-bridge.js` | Перевод Anthropic Messages ⇄ OpenAI Chat Completions для `/v1` |
| `reasoning-relay.js` | Ход мыслей модели → блок «Думаю», перевод на язык вопроса |
| `proofread.js` | Вычитка русского текста после слабых моделей, перевод ответа с английского |
| `image-read.js` | Фото → дословная расшифровка моделью со зрением → ответ текстовой моделью |

### Чат и данные

| Файл | Назначение |
| --- | --- |
| `auth.js` | `authenticateRequest()`, `requireUser()` — личность только из токена Supabase. `hasProAccess()`, `supabaseRest()` |
| `chat-jobs.js` | Сохранение ответа по `jobId` в таблицу `chat_jobs` — ответ переживает уход из вкладки |
| `observe.js` | `logRequest()` → `hm_request_log`; `reportError()` → `hm_error_log`, возвращает код из 16 символов |
| `moderation.js` | Скрытый рейтинг: оскорбления ИИ и jailbreak → инциденты → автоблокировка |
| `web-search.js` | Поиск: Tavily → Brave → DuckDuckGo → Википедия |
| `origin.js` | Единый список разрешённых Origin |
| `dev-account.js` | Вход разработчика по секретному ключу `DEV_LOGIN_KEY` |
| `stats.js`, `admin.js` | Статистика пользователя, панель управления |
| `mailer.js` | Письма через Resend: оплаты, блокировки, рассылки, отписка |

### Деньги

| Файл | Назначение |
| --- | --- |
| `pricing.js` | **Все цены проекта.** Арифметика на BigInt (копейки и микрорубли). Нигде больше цены не хардкодить |
| `yookassa.js` | Клиент ЮKassa |
| `api-keys.js` | Ключи API: только SHA-256 хеш в базе, открытый ключ показывается один раз |
| `referrals.js` | Приглашения: Pro на 3 дня + скидка 10 % на первый месяц |

### Музыкальная теория (без LLM, детерминированно)

| Файл | Назначение |
| --- | --- |
| `music-theory.js` | Ядро: ноты `{step, alter, oct}`, интервалы, гаммы, аккорды, разрешения, ABC |
| `music-theory-router.js` | Вопрос → регулярки → расчёт → блок «РАСЧЁТ:» в системный контекст |
| `music-progressions.js` | Гармонические обороты с голосоведением |
| `music-tasks.js` | Решатель билетов по сольфеджио по пунктам |
| `solfeggio-knowledge.js`, `solfeggio-course/` | Карточки и ~40 глав курса ДМШ; ноты в примерах считает ядро |
| `textbook-ingestor.js` | Учебник по ссылке/файлу → чанки → `knowledge_documents`/`knowledge_chunks` |

### Музыка и видео

| Файл | Назначение |
| --- | --- |
| `yandex.js`, `yandex-auth.js` | Клиент Яндекс Музыки, OAuth Device Flow, токен шифруется AES-256-GCM |
| `music-ext.js` | Audius и Jamendo. Id треков `au:<id>`, `jm:<id>`; формат трека как у Яндекса + `source`, `downloadable`, `link` |
| `music-cache.js` | TTL-кэш, single-flight, stale-while-revalidate |
| `video.js` | Поиск на Rutube (без ключа) и YouTube (с ключом) |
| `video-watch.js` | Gemini смотрит YouTube/TikTok по ссылке; Free — 5 роликов в день |
| `video-gen.js` | Генерация видео через CloseRouter (seedance) |

---

## 7. Как проходит сообщение в чате

### 7.1. Клиент: порядок маршрутизации в `sendMsgInner()` (`app.html`)

Сообщение проверяется по очереди; первый подошедший путь его забирает:

1. `@Плагин …` → `hmPluginRoute()` (Яндекс Музыка, YouTube, Rutube).
2. ИИ-агент `hmAgentRoute()` — если есть аудио или текст похож на действие (раздел 9).
3. Генерация видео → `handleVideoGeneration()`.
4. Кинотеатр → `hmVideoRoute()`.
5. Временная почта → `hmTempMailRoute()`.
6. Музыка → `handleMusicMessage()` («пауза», «включи X» — мимо LLM).
7. Правка приложенного фото → `handleImageGeneration(text,{image})`.
8. Картинка: `isImageRequest()` → `/api/intent` → `handleImageGeneration()`.
9. Обычный ответ → `handleTextReply()` → `runAssistantReply()` → `requestChatReplyLive()`.

### 7.2. Клиент → сервер

`requestChatReplyLive()` шлёт `POST /api/chat` (запасной адрес `/api/harmony`):

```js
{ messages:[{role:'system',content:buildSystem()}, ...история],
  model:'lite'|'pro',           // lite = Adan, pro = Dynatos
  effort:'low'|'medium'|'max'|'extra',
  think:bool, stream:true,
  webSearch:'auto'|'on'|'off',
  temporary:bool, trainingMode:bool,
  jobId:'<32 hex>',             // для восстановления ответа
  userId, userEmail }           // справочно; сервер берёт личность из токена
```

Заголовок `Authorization: Bearer <access_token Supabase>` добавляет `hmAuthHeaders()`.

### 7.3. Сервер: `api/chat.js`, `handler()`

1. `requireUser()` — пользователь из токена. `attachChatJob()` — включить сохранение ответа.
2. Параллельно из Supabase: профиль (кэш 60 с), лимиты `checkUsageAllowance()`, база знаний, память, отзывы.
3. Блокировка аккаунта → 403. Модерация сообщения идёт параллельно и ответ не задерживает.
4. Фото → `readChatImages()` (расшифровка) → музыкальное ядро по расшифровке.
5. Музыкальное ядро `buildMusicTheoryContext(query)` — точный расчёт до вызова модели.
6. Решение о поиске `decideWebSearch()` → `'visible'` | `'silent'` | `false` (раздел 7.5).
7. Системный текст: `HM_GUARD_SYSTEM` + промпт клиента + дата + расчёт + память + отзывы + знания + поиск.
8. `selectRoute()` строит цепочку моделей (раздел 10). Цикл по цепочке: лимит или сбой → следующая модель.
   Гонка за первый токен: если основная молчит дольше `HEDGE_DELAY_MS`, параллельно стартует запасная.
9. `streamOpenAIToClient()` — SSE-поток. В конце — вычитка русского (`proofread.js`), событие `done`.
10. `insertUsageEvent()` и `logRequest()`. При сбое всей цепочки — `reportError()` и событие `error` с кодом.

### 7.4. События SSE (`data: {json}\n\n`)

| type | Смысл |
| --- | --- |
| `status` | Фразы-статусы под запрос (переливаются до первого слова) |
| `search_query`, `search_found`, `search_browse`, `search_browse_done`, `search_sources`, `search_done` | Ход видимого поиска |
| `reasoning_start`, `reasoning`, `reasoning_progress`, `reasoning_end`, `reasoning_reset` | Блок «Думаю» |
| `delta` | Кусок ответа `{text}` |
| `done` | Финал `{text, truncated}` — `text` заменяет напечатанное (вычитанная версия) |
| `error` | `{message, status, code}` |

Между событиями сервер шлёт `: ping` каждые 5 с. Клиент считает поток мёртвым после 45 с тишины
(`STREAM_STALL_MS`). Общий таймаут запроса — 280 с.

### 7.5. Поиск в интернете

- `false` — болтовня, арифметика, код, школьные задачи, объяснения «как сделать».
- `'visible'` — свежие данные (погода, курс, новости), найти сайт или ссылку, неизвестные люди и
  компании, кнопка «Поиск» включена. Клиент видит строку поиска и кнопку «Источники».
- `'silent'` — реферат, сравнение, справочный вопрос с числами. Поиск идёт, но события клиенту не
  шлются, а модели запрещено упоминать поиск (`SILENT_SEARCH_NOTE`).

Запросы для поиска пишет служебная модель (`planSearchQueries`), читаются до 3 страниц.

### 7.6. Ответ не теряется при уходе из вкладки

Телефон замораживает вкладку и рвёт соединение, а функция на сервере продолжает работать.

- Сервер (`lib/chat-jobs.js`) перехватывает `res.write`, копит ответ и раз в 3 с пишет его в
  `chat_jobs`. Если клиент на связи и ответ короткий — в базу не пишет вообще.
- Клиент при обрыве, зависании или возврате во вкладку вызывает `hmResumeJob()` →
  `GET /api/chat?job=<id>` каждые 1,5 с, потом `DELETE`.
- После перезагрузки страницы черновик в истории с полем `job` дописывает `hmResumeStoredJob()`.
- Сервер ответ не сохранил → `autoContinueIfNeeded()` дописывает оборванный ответ новым запросом.

### 7.7. Уровни усилия и «Думать»

`low` — `reasoning_effort` не отправляется (быстрее всего); `medium` → `'medium'`; `max` и `extra` →
`'high'`, у `extra` ещё максимальные таймауты и контекст. Все уровни открыты и в Free.
Если модель не выделила ответ маркером `===ОТВЕТ===`, сервер шлёт `reasoning_reset`.

---

## 8. Клиент

### 8.1. `app.html` — где что искать (номера строк примерные)

| Строки | Содержимое |
| --- | --- |
| 1–170 | `<head>`: ранние скрипты темы, шрифты, подключение `js/*.js` и `css/*.css` |
| 170–3560 | CSS (несколько блоков `<style id="…">`; поздние блоки перекрывают ранние) |
| 3560–4300 | HTML: экран входа, боковая панель, чат, композер, модалки |
| 4311–16290 | Основной скрипт |
| ~4312 | Supabase: `SB_URL`, клиент `sb` |
| ~4410 | Состояние: `curModel`, `curMode`, `thinkOn`, `webSearchMode` |
| ~4520 | `isGenerating`, `activeAbortController`, таймауты |
| ~4636 | Клиентские лимиты (`readUsage`, `planLimits`) |
| ~5120 | Вход, OTP, OAuth |
| ~5700 | Маршруты `/login`, `/chat/<id>`, `/settings` |
| ~6195 | Чтение файлов: PDF, DOCX, XLSX, PPTX, ZIP, код |
| ~6888 | Список чатов, поделиться чатом, `openChat()` (~7421) |
| ~7715 | Выбор модели и усилия, мобильный композер |
| ~8236 | Системный промпт клиента, `buildSystem()` (~8305) |
| ~8586 | Вложения, перетаскивание |
| ~8748 | Сообщения: `addUserBubble`, `createAiBubbleShell`, `renderMd` (~9529), действия под ответом |
| ~9723 | Печать потоком `createLiveTypingController`, автопрокрутка |
| ~10281 | Интерфейс веб-поиска и блока «Думаю» |
| ~11509 | `hmAuthHeaders`, восстановление ответа (~11649), `requestChatReplyLive` (~11771) |
| ~12017 | Отправка, плашки лимитов |
| ~12091 | Генерация картинок, просмотрщик фото |
| ~12552 | Генерация видео |
| ~13238 | `sendMsg()` / `sendMsgInner()` |
| ~13422 | Музыка в чате, плейлист от ИИ |
| ~14293 | `runAssistantReply()` |
| ~14444–16290 | Настройки: общие, безопасность, данные, устройства, лимиты, память, персонализация |
| 16290–17692 | Поздние скрипты: статистика, загрузка трека в Яндекс, микрофон, кинотеатр, ИИ-агент (~17096), разбор треков (~17360), 2FA |

Особенности кода `app.html`: плотный стиль без пробелов, функции глобальные, обработчики часто
через `onclick="…"`. Правки делать точечно; после правок проверять синтаксис каждого `<script>`
через `node --check`.

### 8.2. Модули `js/`

| Файл | Глобал | Назначение |
| --- | --- | --- |
| `hm-rich.js` | `HmRich` | Интерактивные блоки в ответах (список ниже), KaTeX, Mermaid, запуск JS/Python |
| `hm-docgen.js` | — | Сборка PDF/DOCX/PPTX в браузере (pdfmake, docx, pptxgenjs) |
| `hm-bench.js` | — | «Мини-компьютер» справа от чата (только десктоп) |
| `hm-memory.js` | `HmMemory` | Память: факты о пользователе, таблица `user_memories` |
| `hm-mentions.js` | `HmMentions` | `@Плагины` в строке ввода, синий чип |
| `hm-support.js` | — | Окно ИИ-поддержки |
| `hm-stems.js`, `hm-stems-worker.js` | `HmStems` | Разделение трека на партии нейросетью HTDemucs в браузере |
| `hm-think-staff.js`, `thinking-loader.js` | `HmThinkStaff` | Анимации «Думаю» и генерации |
| `audio-analyzer.js` | `AudioAnalyzer` | Темп, тональность, структура — всё в браузере |
| `music-intents.js` | `MusicIntents` | Детектор музыкальных команд без сети |
| `music-client.js` | `MusicClient` | Единственный клиент `/api/music` |
| `music-player.js` | `MusicPlayer` | Один `<audio>` на сайт, очередь, полноэкранный плеер, MediaSession |
| `music-playlists.js` | — | Плейлисты (localStorage + дубль в профиле) |
| `music-cache.js` | — | Клиентский кэш музыки |
| `video-player.js` | `HmVideo` | Плеер Rutube/YouTube |
| `stats.js` | — | Экран статистики |
| `admin.js` | — | Панель `/management` |
| `site.js`, `site-auth.js` | `hm` | Общий скрипт и сессия Supabase для страниц сайта |

### 8.3. Блоки в ответах ИИ (` ```имя ` + JSON)

`quiz`, `chart`, `diagram`/`mermaid`, `photo`/`image`, `buttons`, `steps`, `compare`, `flow`,
`timeline`, `figure`, `molecule`, `email`, `tracks`. Отдельно: ` ```abc ` — нотный стан (abcjs),
` ```harmony-file ` — файл для скачивания. Битый JSON в блоке показывается заглушкой и ответ не ломает.

### 8.4. Хранение на клиенте

- История чатов — в Supabase, таблица `chats` (поле `history`, массив сообщений).
- Сообщение в истории: `{role, content, createdAt, attachments?, sources?, thinking?, stopped?, job?}`
  плюс поля по типу: `image`/`images`, `music`, `video`, `videoGen`, `tempMail`, `generatedFile`, `stems`.
  Новый тип сообщения нужно научить рисовать в `openChat()`.
- localStorage: `hai_lang`, `hai_theme`, `hm_terms_ok`, `hm_local_prefs`, `hm_seen_chat`,
  `hm_plugin_off_*`, `hm_open_*`, сессия Supabase `sb-cqthnymltqpcxtpiryka-auth-token`.
- Cache Storage: `hm-<дата>` (оболочка), `hm-cdn-v1` (библиотеки), `hm-stems-model-v1`
  (нейросеть ~180 МБ), `hm-stems-results-v1` (готовые треки).

### 8.5. Переводы

Русская строка — ключ. `hmT('Строка')` в JS, `applyI18n(root)` обходит DOM. Словарь приложения —
`i18_dict.js` (`window.__I18N_DICT`), страниц сайта — `js/i18n/*.js`. Новую видимую строку нужно
добавить в `i18_dict.js` на 6 языков. Содержимое сообщений чата не переводится.

---

## 9. ИИ-агент (действия по смыслу сообщения)

`hmAgentRoute()` в `app.html` → `POST /api/util?op=agent` → `decideAgentAction()` в `lib/ai-tasks.js`.
Ответ: `{action, reply, query, playlist}`. Действия (`AGENT_ACTIONS`):

| action | Что делает клиент |
| --- | --- |
| `upload_track` | Загружает аудиофайл в Яндекс Музыку пользователя |
| `analyze_track` | Разбор в браузере (`AudioAnalyzer`) → модель рассказывает |
| `identify_track` | Узнаёт трек: `/api/recognize`, теги, каталог |
| `transcribe_track` | Ноты мелодии |
| `find_track` | Карточка «где послушать» (блок `tracks`) |
| `add_to_playlist` | Добавляет трек из каталога в плейлист |
| `separate_stems` | Разделение на партии (`hmStemsRun`) |
| `ask_audio` | Спрашивает, что сделать с треком |
| `limits` | Показывает остаток лимитов |
| `connect_yandex` | Подключение Яндекс Музыки |
| `chat` | Обычный ответ |

Новое действие добавляется в трёх местах: `AGENT_ACTIONS` и промпт в `lib/ai-tasks.js`,
`hmAgentRun()` и `HM_PLUG_WORDS` в `app.html`. Сбой агента = `chat` (fail-open).

---

## 10. Модели и провайдеры

Имя модели определяет провайдера (`providerForModel()` в `lib/models.js`):

| Вид имени | Провайдер | Ключ |
| --- | --- | --- |
| без `/` и префикса (`glm-5.3-flash`, `deepseek-v4-flash`) | pro-ai.online, платный | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |
| `vendor/model[:free]` | OpenRouter | `OPENROUTER_API_KEY` |
| `gemini-*` | Google Gemini, OpenAI-совместимый адрес | `GEMINI_API_KEY` |
| `nim:…`, `cerebras:…`, `groq:…` | NVIDIA NIM, Cerebras, Groq | `NVIDIA_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY` |

Цепочки (`api/chat.js`):

- **Adan (Free)** — `adanChain()`: `ADAN_PRIMARY_MODEL` → бесплатные модели от сильной к слабой
  (`rankedFreeChain`: NIM/Cerebras/Groq, Gemini Flash Lite, OpenRouter `:free`) → платная
  `deepseek-v4-flash` последней. `ADAN_CHAIN` задаёт порядок вручную.
- **Dynatos (Pro)** — `dynatosChain()`: `glm-5.3-flash` → Gemini Flash → вся цепочка Adan.
- С фото — сначала модели со зрением (`visionFirst`). Длинный контекст (>~120K токенов) — только
  модели с большим окном.
- Модель, упёршаяся в лимит, уходит в конец цепочки до сброса (`markModelExhausted`); после 502/503 —
  пауза 60 с. Лимит OpenRouter `free-models-per-day` выключает сразу все `:free` модели.
- Служебные задачи (заголовки, интенты, агент) — быстрые Groq/Cerebras → Gemini → запасные.

Картинки (`api/generate-image.js`): Free — Cloudflare Workers AI (flux-1-schnell) → Pollinations;
Pro — CloseRouter (gpt-image) → pro-ai.online. Лимиты Free: 7 в день, 23 в неделю, 50 в месяц; Pro выше.

Известные причины сбоев: у OpenRouter без пополнения 50 бесплатных запросов в день на весь сервис
(1000 при балансе от $10); pro-ai.online периодически отвечает 502/503.

---

## 11. Тарифы, лимиты, деньги

| | Free | Pro |
| --- | --- | --- |
| Модель | Adan | Dynatos (и Adan) |
| Окно 5 часов | 20 000 токенов / 14 сообщений | ×25 |
| Неделя | 160 000 / 112 | ×25 |
| Месяц | 400 000 / 400 | ×25 |
| Защита от всплеска | — | 25 сообщений за 3 минуты |

- Серверная проверка — `checkUsageAllowance()` по таблице `usage_events`; клиентская копия — только
  для показа. Роли `developer` и `admin` без лимитов.
- Pro: 299 ₽ за 30 дней, 129 ₽ за 7 дней; по приглашению первый месяц −10 %. Оплата при активном
  Pro продлевает срок. Доступ: `hasProAccess()` — `profiles.plan='pro'` и `plan_expires_at` в будущем.
- Баланс API: пополнение 100–100 000 ₽. Цена `/v1`: Dynatos $1/$3, Adan $0,5/$2 за миллион
  токенов (ввод/вывод), курс `USD_RUB_RATE` (по умолчанию 95).
- Роли (`profiles.role`): `user`, `pro` (устар.), `moderator`, `admin`, `developer`.

---

## 12. База данных Supabase

Проект: `cqthnymltqpcxtpiryka.supabase.co`. Сервер ходит под service-role ключом (RLS обходится,
поэтому **каждый запрос обязан фильтровать по `user_id`**). Клиент — под anon-ключом и RLS.

| Таблица | Содержимое |
| --- | --- |
| `profiles` | `id`, `role`, `plan`, `plan_expires_at`, `settings` (jsonb), `limits_reset_at`, `blocked_at`, ник |
| `chats` | Чаты: `id`, `user_id`, `history`, `updated_at` |
| `chat_shares` | Ссылки «Поделиться чатом» |
| `chat_jobs` | Ответы, которые сервер дописывает (живут до суток) |
| `usage_events` | Расход токенов и сообщений — основа лимитов |
| `user_memories` | Память о пользователе |
| `knowledge_documents`, `knowledge_chunks` | База знаний: глобальные учебники и личные документы |
| `message_feedback`, `hm_message_ratings` | Лайки/дизлайки ответов |
| `hm_request_log`, `hm_error_log` | Журнал запросов и ошибок с кодами |
| `hm_user_incidents`, `hm_admin_actions` | Модерация и действия персонала |
| `hm_mail_log`, `hm_mail_campaigns` | Почта и рассылки |
| `payments`, `payment_events`, `api_balances`, `api_keys` | Платежи, баланс и ключи API |
| `referral_invites` | Приглашения |
| `music_accounts` | Зашифрованные токены Яндекс Музыки |
| `video_watches`, `recognition_requests`, `app_reports`, `app_secrets` | Квоты и служебное |

Функции (RPC): `credit_subscription`, `credit_api_balance`, `debit_api_balance`, `api_usage_summary`,
`bump_share_view`, `hm_stats`, `hm_heartbeat`, `hm_nickname`, `hm_save_source`,
`hm_moderation_record`, `hm_moderation_pardon`, `hm_admin_*`.

Storage: `chat-attachments`, `generated-images`.

Миграции лежат в `supabase/` только начиная с 22 октября 2026 — схемы старых таблиц (`profiles`,
`chats`, `usage_events` и др.) в репозитории нет. Новую миграцию класть файлом
`supabase/ГГГГ-ММ-ДД-имя.sql` (`create … if not exists`, RLS включён, `revoke all … from anon,
authenticated`) и **сказать пользователю, что её нужно выполнить**. Код должен работать и без неё.

---

## 13. Переменные окружения Vercel

Обязательные: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

| Группа | Переменные |
| --- | --- |
| Модели чата | `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `ADAN_PRIMARY_MODEL`, `ADAN_MODELS`, `ADAN_CHAIN`, `ADAN_VISION_MODELS`, `DYNATOS_MODEL`, `DYNATOS_FALLBACK`, `GEMINI_CHAT_MODEL`, `GEMINI_PRO_MODEL`, `NIM_MODELS`, `CEREBRAS_MODELS`, `GROQ_MODELS`, `HEDGE_DELAY_MS` |
| Служебные модели | `INTENT_MODEL`, `AGENT_MODEL`, `TITLE_MODEL`, `MEMORY_MODEL`, `MODERATION_MODEL`, `MUSIC_INTENT_MODEL`, `PLAYLIST_MODEL`, `SEARCH_PLAN_MODEL`, `STATUS_MODEL`, `SUMMARY_MODEL`, `UTILITY_FALLBACK_MODEL`, `ADAN_PROOF_MODEL(S)`, `REASONING_TRANSLATE_MODEL`, `SUPPORT_MODELS` |
| Картинки и видео | `CLOSEROUTER_API_KEY`, `CLOSEROUTER_BASE_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_IMAGE_MODEL`, `CLOUDFLARE_EDIT_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_API_KEY`, `OPENAI_IMAGE_BASE_URL`, `POLLINATIONS_TOKEN`, `VIDEO_GEN_MODEL`, `VIDEO_GEN_SECRET`, `GEMINI_VIDEO_MODEL`, `YOUTUBE_API_KEY` |
| Поиск | `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` |
| Музыка | `YANDEX_MUSIC_ENABLED`, `YANDEX_MUSIC_TOKEN`, `YANDEX_OAUTH_CLIENT_ID`, `YANDEX_OAUTH_CLIENT_SECRET`, `MUSIC_ENCRYPTION_KEY`, `YANDEX_SIGN_SALT`, `JAMENDO_CLIENT_ID`, `AUDIUS_API_KEY`, `AUDIUS_DISABLED`, `MUSIC_EXT_WAVE_SHARE`, `AUDD_API_KEY` |
| Деньги | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `PRO_PRICE_RUB`, `PRO_WEEK_PRICE_RUB`, `USD_RUB_RATE`, `API_TOPUP_MIN_RUB`, `API_TOPUP_MAX_RUB` |
| Почта | `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO`, `MAIL_DAILY_LIMIT`, `MAIL_SECRET` |
| Прочее | `DEV_LOGIN_KEY`, `SITE_URL`, `API_PUBLIC_URL`, `TEMPMAIL_SECRET`, `HM_COST_PRICES` |

Правило: нет ключа — функция тихо выключается, остальное работает. Добавляя переменную, сообщи
пользователю её имя и назначение.

---

## 14. Безопасность — что нельзя сломать

- Личность пользователя — только из токена (`requireUser`). `userId` из тела запроса не доверять.
- Деньги начисляет только `payment/webhook.js`: платёж перепроверяется запросом в ЮKassa,
  начисление идемпотентно. Кабинет баланс только читает.
- Ключи API — только хеш; ключи провайдеров и токен Яндекса в браузер не уходят.
- `HM_GUARD_SYSTEM` и `detectJailbreak()` — защита промпта. Обычные вопросы атакой не считаются.
- HTML из ответов модели и из базы вставлять через `escapeHtml()`/`esc()`/`textContent`.
- Редиректы и прокси проверяют id и хост (нет открытого редиректа, нет SSRF).
- Временный чат (`temporary:true`): текст не пишется даже в журнал ошибок.

---

## 15. Как работать с репозиторием

**Порядок работы:**

1. Ветка от свежего `main`. Пользователь сам мержит PR; Vercel сам выкатывает.
2. Правка → `npm test` → проверка в браузере → коммит → push → PR.
3. В каждом обновлении для пользователей поднять версию: `Beta X.Y.Z` в `app.html` (3 места),
   `version` в `package.json`, строка `VERSION` в `sw.js`. Текущая — **0.8.101**; правило
   нумерации — в `CLAUDE.md`. Номер версии — в описании PR.
4. Отвечать пользователю по-русски, в конце — список изменённых файлов, нужные переменные Vercel
   и SQL, который надо выполнить.
5. Непонятно — спросить до написания кода. Качество важнее скорости.

**Проверка в браузере** (сборки нет, достаточно статического сервера):

```bash
node scripts/dev-server.mjs        # http://localhost:8766/app.html, заголовки как на проде
```

- Сервер `scripts/dev-server.mjs` ставит те же заголовки, что Vercel, включая CSP. Обычный
  `python3 -m http.server` их не ставит: так в 0.8.100 ушёл на прод неработающий разбор треков —
  локально нейросеть скачивалась, а на проде CSP блокировал и CDN в Worker, и huggingface.co.
  Всё, что ходит в сеть из браузера или запускает Worker, проверять только через этот сервер.

- `/api/*` локально нет: запросы либо подменять (`page.route`), либо слать на прод с настоящей сессией.
- Сессию подкладывают в `localStorage['sb-cqthnymltqpcxtpiryka-auth-token']`; плюс `hm_terms_ok`.
- Мобильный вид: viewport 390×844, `isMobile:true`. Мобильные стили — `@media (max-width:768px),
  (hover:none) and (pointer:coarse)`.
- Dev-аккаунт `devharmonyai0802@dev.dev` входит через `POST /api/account {action:'dev_instant_login',
  email, key}`; ключ — `DEV_LOGIN_KEY` в Vercel, в репозитории его нет.
- Проверять сначала на бесплатной Adan; Dynatos — только при необходимости.

**Диагностика ошибки у пользователя.** Он видит «Ошибка сервиса № <код>». Причина:
`GET /api/account?action=admin.errors&q=<код>` или панель `/management` → «Ошибки сервиса».
`source: client` — ошибка на стороне браузера (таймаут, обрыв), `chat`/`image` — серверная.

**Типовые задачи:**

| Задача | Где править |
| --- | --- |
| Поведение или тон ИИ | `HM_GUARD_SYSTEM` в `api/chat.js`; `buildSystem()` в `app.html` |
| Порядок или состав моделей | `lib/models.js`, `lib/model-catalog.js` (`STRENGTH`), цепочки в `api/chat.js`, либо переменные Vercel |
| Когда включается поиск | `decideWebSearch()` в `api/chat.js` + `tests/web-search-decision.test.mjs` |
| Новая серверная операция | Модуль в `lib/` + строка в `OPS` в `api/util.js` |
| Новое действие по смыслу сообщения | Раздел 9 |
| Новый блок в ответе | `KINDS` и рендер в `js/hm-rich.js`, стили в `css/hm-rich.css` |
| Музыкальная теория | `lib/music-theory*.js`, `lib/music-tasks.js` + тесты. Ноты считает алгоритм, не модель |
| Цены | Только `lib/pricing.js` |
| Лимиты | `FREE_LIMITS` в `api/chat.js`; клиентская копия в `app.html` (~4636) |
| Стиль элемента чата | Поздние блоки `<style>` в `app.html` или `css/*.css`; учесть мобильный `@media` и светлую тему |
| Текст на сайте | Страница + `js/i18n/<страница>.js`; SEO-страницы — через `scripts/build-seo-pages.mjs` |

**Частые ловушки:**

- В JS-регулярках `\b` и `\w` не работают с кириллицей — границы слов писать явно: `(^|[^а-яё])`.
- В `app.html` много одноимённых CSS-правил; мобильные идут с `!important`. Проверять итоговый
  стиль в браузере, а не по одному правилу.
- `getChatInner()` убирает приветствие пустого чата — для чтения и измерений брать `chatInnerEl()`.
- Service worker удаляет только кэши `hm-20…`; кэши с другими именами переживают обновление.
- SSE-события поиска и статусов шлются до ответа модели: заголовки потока к этому моменту уже
  отправлены, и ошибку дальше можно отдать только событием `error`, не JSON-ом.
- Поддержка — только ИИ-поддержка в приложении и почта harmonyaisent@gmail.com. Telegram не упоминать.

---

## 16. Что не проверено или известно как слабое место

- **Разбор треков на телефоне** не проверялся — только Chromium на компьютере (WebAssembly:
  10 секунд звука ≈ 50 секунд работы). Скорость через WebGPU не измерена. В 0.8.100 функция на
  проде не работала из-за CSP; исправлено в 0.8.101.
- **Jamendo** не проверялся вживую — нужен `JAMENDO_CLIENT_ID`.
- **Восстановление ответа** работает только после выполнения `supabase/2026-11-06-chat-jobs.sql`.
- Функция чата живёт максимум 300 с — более длинный ответ оборвётся и допишется автопродолжением.
- TikTok-ролики скачивает неофициальный сервис tikwm.com — может перестать работать.
- `PROJECT_MAP.html`, `QA_REPORT.md`, `deploy-check.txt`, `README.md` устарели.
