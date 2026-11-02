/* ============================================================================
   HarmonyAI — «Память»: долговременные факты (о пользователе и о чате).

   ПРАВИЛА, зашитые здесь и не подлежащие нарушению:

   1. ПАМЯТЬ ≠ ИСТОРИЯ. В память попадают только короткие устойчивые факты
      о пользователе. Их выбирает служебная модель (auto → /api/util?op=memory)
      после сообщения, в котором пользователь говорит о себе или просит
      запомнить/забыть; окна подтверждения нет — в чате появляется метка
      «Обновляю память → Память обновлена», а любой факт можно удалить
      в Настройки → Персонализация → Память. Переписка целиком сюда НЕ пишется.
      Выключатель «Запоминать автоматически» (settings.memSave) отключает всё.

   2. НОЛЬ СЕКРЕТОВ. Похожие на пароли, API-ключи, токены, JWT и номера карт
      строки в память не сохраняются (looksLikeSecret). Фильтр грубый, но
      срабатывает ДО записи в базу.

   3. МИНИМУМ НАГРУЗКИ:
      • чтение — один запрос при входе + кэш в localStorage; сеть — не чаще
        раза в STALE_MS;
      • модель зовётся только для сообщений, где пользователь пишет о себе
        (AUTO_HINT_RE: «я», «мне», «меня зовут», «запомни»…), — не на каждый
        вопрос;
      • контекст модели собирается на клиенте (contextBlock) одним компактным
        блоком в system-промпте; серверу уходит флаг memoryFromClient:true,
        и он не ходит в Supabase за памятью на каждое сообщение.

   4. Разделение: scope='user' — факты «обо мне» (доступны во всех чатах);
      scope='chat' — память проекта/чата. История переписки живёт отдельно
      в таблице chats и из памяти не читается.
   ============================================================================ */
(function (global) {
  'use strict';

  var STALE_MS = 10 * 60 * 1000;   // как часто разрешено обновлять список из сети
  var MAX_ENTRIES = 200;           // потолок фактов на пользователя
  var ENTRY_MAX = 300;             // символов на один факт
  var CONTEXT_ENTRIES = 22;        // максимум фактов в контексте модели
  var CONTEXT_LINE = 120;          // символов на факт в контексте
  var CONTEXT_CHARS = 3000;        // общий потолок блока «ПАМЯТЬ»

  var SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{8,}/,                       // ключи вида sk-…
    /\beyJ[A-Za-z0-9_-]{10,}/,                      // JWT
    /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/,                 // AWS
    /\bgh[pousr]_[A-Za-z0-9]{16,}/,                 // GitHub
    /[A-Za-z0-9+/]{34,}={0,2}/,                     // длинный base64-ключ
    /\b(?:\d[ -]?){13,19}\b/,                       // номер карты
    /(?:api[-_ ]?key|api[-_ ]?token|secret|password|passwd|пароль|токен|ключ доступа|секретный ключ)\s*[:=]\s*\S{4,}/i
  ];

  var state = { uid: null, hasScope: true, items: [], loadedAt: 0, lastFailedAt: 0 };

  /* ---------- доступ к окружению app.html (без window.curChatId — оно не в window) ---------- */

  function sb() { return global.__hmSb || null; }
  function settings() {
    try { return (typeof global.getSettings === 'function') ? (global.getSettings() || {}) : {}; }
    catch (e) { return {}; }
  }

  /* ================== утилиты ================== */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(text) {
    var s = String(text == null ? '' : text)
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > ENTRY_MAX) s = s.slice(0, ENTRY_MAX - 1).replace(/\s+\S*$/, '').trim() + '…';
    return s;
  }
  function looksLikeSecret(t) {
    var s = String(t || '');
    for (var i = 0; i < SECRET_PATTERNS.length; i++) if (SECRET_PATTERNS[i].test(s)) return true;
    return false;
  }
  function normTokens(t) {
    return String(t || '').toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/gi, ' ')
      .split(' ').filter(function (w) { return w.length > 2; });
  }
  function similar(a, b) {
    var ta = normTokens(a), tb = normTokens(b);
    if (!ta.length || !tb.length) return false;
    var ja = ta.join(' '), jb = tb.join(' ');
    if (ja === jb) return true;
    if (ja.indexOf(jb) >= 0 || jb.indexOf(ja) >= 0) return true;
    var setA = new Set(ta), hit = 0;
    for (var i = 0; i < tb.length; i++) if (setA.has(tb[i])) hit++;
    return tb.length >= 3 && hit / tb.length >= 0.7;
  }
  function nowIso() { return new Date().toISOString(); }

  /* ================== кэш в localStorage ================== */

  function cacheKey(uid) { return 'hm_memory_v1_' + (uid || 'guest'); }
  function readCache(uid) {
    try {
      var raw = global.localStorage.getItem(cacheKey(uid));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeCache(uid, items) {
    try { global.localStorage.setItem(cacheKey(uid), JSON.stringify((items || []).slice(0, MAX_ENTRIES))); } catch (e) {}
  }

  /* ================== сеть (Supabase через RLS, редко) ================== */

  async function fetchEntries() {
    var c = sb(), uid = state.uid;
    if (!c || !uid) return [];
    try {
      var res = await c.from('user_memories')
        .select('id,scope,chat_id,memory_text,source_type,weight,is_active,updated_at')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false })
        .limit(MAX_ENTRIES);
      if (res.error) throw res.error;
      return res.data || [];
    } catch (eFull) {
      // Старая таблица без scope/chat_id — спадаем на минимальную выборку.
      try {
        var res2 = await c.from('user_memories')
          .select('id,memory_text,source_type,is_active,updated_at')
          .eq('user_id', uid)
          .order('updated_at', { ascending: false })
          .limit(MAX_ENTRIES);
        if (res2.error) throw res2.error;
        state.hasScope = false;
        return (res2.data || []).map(function (r) {
          return Object.assign({ scope: 'user', chat_id: null, weight: 0 }, r);
        });
      } catch (e) { throw e; }
    }
  }

  async function insertEntry(entry, text) {
    var c = sb();
    if (!c) throw new Error('база недоступна');
    var payload = {
      user_id: state.uid,
      memory_text: text,
      source_type: entry.source_type || 'manual',
      is_active: true,
      weight: entry.weight || 2,
      updated_at: nowIso()
    };
    if (state.hasScope) {
      if (entry.scope === 'chat') { payload.scope = 'chat'; payload.chat_id = entry.chat_id || ''; }
      else { payload.scope = 'user'; payload.chat_id = null; }
    }
    var res = await c.from('user_memories').insert(payload).select('id').single();
    if (res.error) {
      if (state.hasScope) {
        delete payload.scope; delete payload.chat_id;
        var res2 = await c.from('user_memories').insert(payload).select('id').single();
        if (!res2.error) { state.hasScope = false; return Object.assign({}, payload, res2.data); }
      }
      throw res.error;
    }
    return Object.assign({}, payload, res.data);
  }

  async function patchEntry(id, patch) {
    var c = sb();
    if (!c) throw new Error('база недоступна');
    var res = await c.from('user_memories').update(patch).eq('id', id).eq('user_id', state.uid);
    if (res.error) throw res.error;
    return true;
  }

  /* ================== публичный API ================== */

  async function sync(uid, force) {
    if (!uid) { state.uid = null; state.items = []; return; }
    if (!force && state.uid === uid && state.items.length && Date.now() - state.loadedAt < STALE_MS) return;
    state.uid = uid;
    var cached = readCache(uid);
    if (cached.length) state.items = cached;   // мгновенно из кэша
    if (!force && Date.now() - state.lastFailedAt < 60 * 1000) return; // после сбоя минуту не долбим сеть
    try {
      var fresh = await fetchEntries();
      state.items = fresh; state.loadedAt = Date.now(); state.lastFailedAt = 0;
      writeCache(uid, fresh);
    } catch (e) {
      state.lastFailedAt = Date.now();
      if (!cached.length) state.items = [];
    }
  }
  function reset() { state.uid = null; state.items = []; state.loadedAt = 0; state.lastFailedAt = 0; }
  function list() { return state.items.filter(function (r) { return r.is_active !== false; }).slice(); }
  function count() { return list().length; }

  async function add(text, opts) {
    opts = opts || {};
    if (!state.uid) return { ok: false, reason: 'Сначала войдите в аккаунт.' };
    var s = clean(text);
    if (s.length < 8) return { ok: false, reason: 'Слишком короткий текст — не сохраняю.' };
    if (looksLikeSecret(s)) return { ok: false, reason: 'Похоже на пароль, ключ или токен — секреты в память не сохраняются.' };

    var scope = (opts.scope === 'chat' && opts.chatId) ? 'chat' : 'user';
    var chatId = scope === 'chat' ? opts.chatId : '';

    // Дедупликация: похожий факт обновляем, а не плодим копии.
    var dupe = null;
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (it.is_active === false) continue;
      if ((it.scope || 'user') !== scope) continue;
      if (similar(it.memory_text, s)) { dupe = it; break; }
    }
    try {
      if (dupe) {
        await patchEntry(dupe.id, { memory_text: s, updated_at: nowIso() });
        dupe.memory_text = s; dupe.updated_at = nowIso();
        writeCache(state.uid, state.items);
        return { ok: true, updated: true };
      }
      if (list().length >= MAX_ENTRIES) return { ok: false, reason: 'Достигнут предел в ' + MAX_ENTRIES + ' фактов — очистите память в настройках.' };
      var row = await insertEntry({ scope: scope, chat_id: chatId, source_type: opts.sourceType || 'manual' }, s);
      state.items.unshift(row);
      writeCache(state.uid, state.items);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'Не удалось сохранить: ' + (e && e.message ? e.message : 'ошибка базы') };
    }
  }

  async function update(id, text) {
    var s = clean(text);
    if (s.length < 8) return { ok: false, reason: 'Слишком короткий текст.' };
    if (looksLikeSecret(s)) return { ok: false, reason: 'Секреты в память не сохраняются.' };
    try {
      await patchEntry(id, { memory_text: s, updated_at: nowIso() });
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === id) { state.items[i].memory_text = s; state.items[i].updated_at = nowIso(); break; }
      }
      writeCache(state.uid, state.items);
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'Не удалось обновить.' }; }
  }

  async function remove(id) {
    try {
      await patchEntry(id, { is_active: false, updated_at: nowIso() });
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === id) state.items[i].is_active = false;
      }
      writeCache(state.uid, state.items);
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'Не удалось удалить.' }; }
  }

  async function clearAll() {
    try {
      var c = sb();
      if (!c || !state.uid) return { ok: false, reason: 'база недоступна' };
      var res = await c.from('user_memories').update({ is_active: false }).eq('user_id', state.uid);
      if (res.error) throw res.error;
      state.items = [];
      writeCache(state.uid, []);
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'Не удалось очистить память.' }; }
  }

  /* ================== компактный контекст для модели ================== */

  function contextBlock(chatId) {
    var s = settings();
    if (s.memRecall === false) return '';
    var items = list();
    if (!items.length) return '';
    var mine = items.filter(function (r) {
      var sc = r.scope || 'user';
      if (sc === 'user') return true;
      return chatId && r.chat_id === chatId;
    });
    if (!mine.length) return '';
    mine.sort(function (a, b) {
      var wa = a.weight || 0, wb = b.weight || 0;
      if (wb !== wa) return wb - wa;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    var lines = [], total = 0;
    for (var i = 0; i < mine.length && lines.length < CONTEXT_ENTRIES; i++) {
      var t = String(mine[i].memory_text || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > CONTEXT_LINE) t = t.slice(0, CONTEXT_LINE - 1).trim() + '…';
      if (total + t.length > CONTEXT_CHARS) break;
      total += t.length;
      lines.push((lines.length + 1) + '. ' + t);
    }
    if (!lines.length) return '';
    return '\nПАМЯТЬ (короткие факты, которые пользователь попросил помнить; используй, только если это уместно в текущем запросе):\n' + lines.join('\n');
  }

  /* ================== эвристика «запомнить?» и карточка ================== */

  var REMEMBER_RE = /(запомни(те)?|запиши себе|не забудь|помни,?\s+что)/i;
  var FACT_RE = /(меня зовут|мо[йя]\s+(имя|ник|препод|учитель|инструмент)|я\s+(учусь|играю|занимаюсь|готовлюсь|собираюсь|предпочита|живу|работаю|репетиру)|у меня\s+(есть|нет|инструмент|урок|экзамен|канал)|мне\s+(удобн|нравится|не нравится|важно|нужно)|любим(ый|ая|ое))/i;

  function splitSentences(src) {
    var out = [], buf = '', s = String(src || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      buf += ch;
      if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
        var nx = s.charAt(i + 1);
        if (nx === ' ' || nx === '' || nx === '\n') { out.push(buf.trim()); buf = ''; i++; }
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }
  function extractCandidate(text) {
    var sentences = splitSentences(text);
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (REMEMBER_RE.test(s) || FACT_RE.test(s)) {
        if (s.length > ENTRY_MAX) s = s.slice(0, ENTRY_MAX - 1) + '…';
        return s;
      }
    }
    return null;
  }

  var cardEl = null;
  /* Одно уведомление за раз (app.html, hmNotice): пока карточка открыта, остальные ждут. */
  function closeCard() { if (cardEl) { cardEl.remove(); cardEl = null; if (global.hmNoticeResume) global.hmNoticeResume(); } }
  function yieldNotices() { if (global.hmNoticeYield) global.hmNoticeYield(); }

  function injectCSS() {
    if (document.getElementById('hmMemCSS')) return;
    var css = ''
      + '.hm-mem-card{pointer-events:auto;width:100%;max-width:420px;background:var(--drop-bg,#1c1c22);border:1px solid var(--border);border-radius:20px;padding:14px 14px 14px 16px;box-shadow:var(--drop-shadow,0 12px 34px rgba(0,0,0,.30));animation:hmMemIn .32s cubic-bezier(.34,1.56,.64,1) both;font-size:14px;color:var(--text);display:flex;flex-direction:column;gap:10px;}'
      + '@keyframes hmMemIn{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:none;}}'
      + '.hm-mem-card__head{display:flex;align-items:center;justify-content:space-between;font-weight:800;}'
      + '.hm-mem-card__x{border:none;background:transparent;color:var(--text2);font-size:20px;line-height:1;cursor:pointer;padding:0 4px;}'
      + '.hm-mem-card__ta{width:100%;min-height:56px;resize:vertical;background:var(--bg3,rgba(255,255,255,.06));border:1px solid var(--border);border-radius:12px;padding:10px 12px;color:var(--text);font:inherit;font-size:13.5px;line-height:1.45;outline:none;}'
      + '.hm-mem-card__scope{display:flex;gap:6px;}'
      + '.hm-mem-card__scope button{border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:999px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;}'
      + '.hm-mem-card__scope button.on{background:var(--accent,#2f8fff);border-color:var(--accent,#2f8fff);color:#fff;}'
      + '.hm-mem-card__msg{font-size:13px;}'
      + '.hm-mem-card__acts{display:flex;gap:8px;}'
      + '.hm-mem-card__ok{flex:1;border:none;border-radius:12px;padding:10px;background:var(--send-bg,#fff);color:var(--send-txt,#111);font:inherit;font-weight:700;cursor:pointer;}'
      + '.hm-mem-card__ok:disabled{opacity:.5;}'
      + '.hm-mem-card__no{border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:12px;padding:10px 14px;font:inherit;cursor:pointer;}'
      + '@media(prefers-reduced-motion:reduce){.hm-mem-card{animation:none;}}';
    var st = document.createElement('style');
    st.id = 'hmMemCSS';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function showCard(text, opts) {
    injectCSS();
    closeCard();
    var host = document.getElementById('notifHost') || document.body;
    var el = document.createElement('div');
    el.className = 'hm-mem-card';
    el.innerHTML =
      '<div class="hm-mem-card__head"><span>Сохранить в память</span><button type="button" class="hm-mem-card__x" aria-label="Закрыть">×</button></div>'
      + '<textarea class="hm-mem-card__ta" maxlength="' + ENTRY_MAX + '"></textarea>'
      + '<div class="hm-mem-card__scope">'
      + '<button type="button" data-sc="user" class="on">Обо мне</button>'
      + ((opts && opts.allowScope && opts.chatId) ? '<button type="button" data-sc="chat">Этот чат</button>' : '')
      + '</div>'
      + '<div class="hm-mem-card__msg" hidden></div>'
      + '<div class="hm-mem-card__acts">'
      + '<button type="button" class="hm-mem-card__ok">Запомнить</button>'
      + '<button type="button" class="hm-mem-card__no">Не сейчас</button>'
      + '</div>';
    yieldNotices(); host.appendChild(el); cardEl = el;

    var scope = (opts && opts.defaultScope === 'chat' && opts.chatId) ? 'chat' : 'user';
    var ta = el.querySelector('.hm-mem-card__ta');
    var msg = el.querySelector('.hm-mem-card__msg');
    var userBtn = el.querySelector('[data-sc="user"]');
    var chatBtn = el.querySelector('[data-sc="chat"]');
    ta.value = String(text || '');
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });

    userBtn.classList.toggle('on', scope === 'user');
    userBtn.addEventListener('click', function () { scope = 'user'; userBtn.classList.add('on'); if (chatBtn) chatBtn.classList.remove('on'); });
    if (chatBtn) {
      chatBtn.classList.toggle('on', scope === 'chat');
      chatBtn.addEventListener('click', function () { scope = 'chat'; chatBtn.classList.add('on'); userBtn.classList.remove('on'); });
    }
    el.querySelector('.hm-mem-card__x').addEventListener('click', closeCard);
    el.querySelector('.hm-mem-card__no').addEventListener('click', closeCard);
    el.querySelector('.hm-mem-card__ok').addEventListener('click', async function () {
      var txt = clean(ta.value);
      if (txt.length < 8) { msg.hidden = false; msg.textContent = 'Слишком коротко — отредактируйте текст.'; return; }
      var btn = el.querySelector('.hm-mem-card__ok');
      btn.disabled = true;
      var res = await add(txt, { scope: scope, chatId: opts && opts.chatId, sourceType: (opts && opts.sourceType) || 'manual' });
      btn.disabled = false;
      if (res.ok) {
        msg.hidden = false; msg.style.color = 'var(--check,#22c55e)';
        msg.textContent = 'Сохранено ✓' + (res.updated ? ' (обновил похожий факт)' : '');
        setTimeout(closeCard, 1400);
      } else {
        msg.hidden = false; msg.style.color = 'var(--err,#ef4444)';
        msg.textContent = res.reason || 'Не удалось сохранить';
      }
    });
  }

  function showRefusal() {
    injectCSS();
    closeCard();
    var host = document.getElementById('notifHost') || document.body;
    var el = document.createElement('div');
    el.className = 'hm-mem-card';
    el.innerHTML =
      '<div class="hm-mem-card__head"><span>Не сохраняю секреты</span><button type="button" class="hm-mem-card__x" aria-label="Закрыть">×</button></div>'
      + '<div style="font-size:13px;color:var(--text2);line-height:1.5;">В тексте похоже на пароль, API-ключ или токен. Такие данные в память не попадают — так безопаснее.</div>';
    yieldNotices(); host.appendChild(el); cardEl = el;
    el.querySelector('.hm-mem-card__x').addEventListener('click', closeCard);
    setTimeout(closeCard, 6000);
  }

  /** Локальная эвристика после сообщения пользователя. Сеть не трогает,
      модель не зовёт — просто показывает карточку-предложение. */
  function maybeSuggest(text, opts) {
    opts = opts || {};
    var s = settings();
    if (s.memSave === false) return;
    var src = String(text || '');
    if (src.length < 10 || src.length > 800) return;
    var explicit = REMEMBER_RE.test(src);
    if (!explicit && !FACT_RE.test(src)) return;
    var cand = extractCandidate(src);
    if (!cand) { if (!explicit) return; cand = clean(src); }
    if (looksLikeSecret(cand)) { if (explicit) showRefusal(); return; }
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (it.is_active === false) continue;
      if (similar(it.memory_text, cand)) return;
    }
    var defScope = (explicit && /в этом чате/i.test(src)) ? 'chat' : 'user';
    setTimeout(function () {
      showCard(cand, { allowScope: true, defaultScope: defScope, chatId: opts.chatId, sourceType: explicit ? 'manual' : 'suggested' });
    }, 1200);
  }

  /** Пункт меню сообщения «Запомнить» — сохраняем сразу, без окна. */
  async function promptAdd(text, opts) {
    opts = opts || {};
    var res = await add(clean(text), { scope: 'user', chatId: opts.chatId, sourceType: 'manual' });
    try {
      if (typeof global.pvToast === 'function') global.pvToast(res.ok ? 'Память обновлена' : (res.reason || 'Не удалось сохранить'));
    } catch (e) { /* без тоста */ }
    return res;
  }

  /* ---------- Автоматическая память ----------
     Только сообщения, где пользователь говорит о себе или просит запомнить/
     забыть: остальные вопросы модель не тратят. Границы слов — через \p{L},
     потому что \b в JS не работает с кириллицей. */
  var AUTO_HINT_RE = /(^|[^\p{L}])(я|мне|меня|мной|мой|моя|моё|мое|мои|моего|моей|моих|мы|нас|нам|наш|наша|наши|зовут|запомни|запомните|запиши|забудь|забудьте|помни|i|i'm|im|my|me|mine|remember|forget)(?=$|[^\p{L}])/iu;
  var autoBusy = false;
  async function authToken() {
    try { var r = await sb().auth.getSession(); return r && r.data && r.data.session ? r.data.session.access_token : ''; } catch (e) { return ''; }
  }
  /** opts: {chatId, onStart(): Promise, onDone(changed:boolean)} */
  async function auto(message, opts) {
    opts = opts || {};
    var st = settings();
    if (st.memSave === false || !state.uid || autoBusy) return { changed: false };
    var src = String(message || '').trim();
    if (src.length < 6 || !AUTO_HINT_RE.test(src.slice(0, 2000))) return { changed: false };
    var token = await authToken();
    if (!token) return { changed: false };
    autoBusy = true;
    try {
      var facts = list().slice(0, 40);
      var r = await fetch('/api/util?op=memory', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ message: src.slice(0, 1500), facts: facts.map(function (f) { return f.memory_text; }) })
      });
      var d = await r.json().catch(function () { return null; });
      var save = (d && Array.isArray(d.save)) ? d.save : [];
      var forget = (d && Array.isArray(d.forget)) ? d.forget : [];
      save = save.filter(function (x) { return x && x.text && !looksLikeSecret(x.text); });
      if (!save.length && !forget.length) return { changed: false };
      if (typeof opts.onStart === 'function') { try { await opts.onStart(); } catch (e) {} }
      var changed = 0;
      for (var i = 0; i < forget.length; i++) {
        var f = facts[forget[i]];
        if (f && f.id && (await remove(f.id)).ok) changed++;
      }
      for (var j = 0; j < save.length; j++) {
        var res = await add(save[j].text, { scope: save[j].scope === 'chat' && opts.chatId ? 'chat' : 'user', chatId: opts.chatId, sourceType: 'suggested' });
        if (res.ok) changed++;
      }
      if (typeof opts.onDone === 'function') opts.onDone(changed > 0);
      return { changed: changed > 0 };
    } catch (e) {
      if (typeof opts.onDone === 'function') opts.onDone(false);
      return { changed: false };
    } finally {
      autoBusy = false;
    }
  }

  global.HmMemory = {
    sync: sync, reset: reset, list: list, count: count,
    add: add, update: update, remove: remove, clearAll: clearAll,
    contextBlock: contextBlock, maybeSuggest: maybeSuggest, promptAdd: promptAdd, auto: auto,
    looksLikeSecret: looksLikeSecret
  };

})(typeof window !== 'undefined' ? window : globalThis);
