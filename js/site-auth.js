/* ============================================================================
   HARMONYAI — СЕССИЯ SUPABASE НА СТАТИЧЕСКИХ СТРАНИЦАХ

   Нужен страницам /api и /api/dashboard: они лежат вне монолита index.html,
   но обязаны узнавать того же самого пользователя.

   ЭТО НЕ ВТОРАЯ СИСТЕМА АВТОРИЗАЦИИ. Своих токенов мы не выдаём, пароли не
   храним, второго /login не заводим. Здесь только чтение сессии, которую уже
   выдал Supabase при входе в чате, и подстановка её access-токена в заголовок
   Authorization при обращении к /api/account.

   Ключ SB_KEY — публичный anon-ключ (тот же, что в index.html). Он и должен
   быть в браузере: доступ к данным ограничивают RLS и серверные проверки
   владельца, а не секретность этого ключа.

   Требует, чтобы @supabase/supabase-js уже был подключён тегом <script> выше.
   ============================================================================ */
(function () {
  'use strict';

  const SB_URL = 'https://cqthnymltqpcxtpiryka.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxdGhueW1sdHFwY3h0cGlyeWthIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0MjY3NzYsImV4cCI6MjA5NzAwMjc3Nn0.b-6lSdjT7XwWkt607ORwGfKYSn3CLZJB3mcs4QQUSoE';

  const auth = {
    user: null,
    token: '',
    client: null,
    ready: null
  };

  function makeClient() {
    if (auth.client) return auth.client;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;
    auth.client = window.supabase.createClient(SB_URL, SB_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        /* Ссылки-подтверждения из письма приходят на /login в чате, а не сюда,
           поэтому разбирать URL на этих страницах незачем. */
        detectSessionInUrl: false
      }
    });
    return auth.client;
  }

  /* Читаем сессию один раз при загрузке. Дальше следим за обновлениями токена:
     страница кабинета живёт долго, а access-токен Supabase короткий — без
     подписки первый же запрос после часа работы получил бы 401. */
  auth.ready = (async function init() {
    const client = makeClient();
    if (!client) return null;
    try {
      const { data } = await client.auth.getSession();
      apply(data && data.session);
    } catch (e) {
      apply(null);
    }
    client.auth.onAuthStateChange((_event, session) => { apply(session); });
    return auth.user;
  })();

  function apply(session) {
    auth.token = (session && session.access_token) || '';
    auth.user = session && session.user
      ? { id: session.user.id, email: session.user.email || '' }
      : null;
  }

  /* Уход на существующий /login. Параметр next говорит чату, куда вернуть
     пользователя после успешного входа или регистрации. */
  auth.login = function (next) {
    const target = next || (location.pathname + location.search);
    location.href = '/login?next=' + encodeURIComponent(target);
  };

  auth.signOut = async function () {
    const client = makeClient();
    if (client) { try { await client.auth.signOut(); } catch (e) {} }
    apply(null);
    location.href = '/';
  };

  /* ===== ОБРАЩЕНИЕ К /api/account =========================================
     Токен уходит в Authorization: сервер берёт user_id только оттуда.
     Возвращает { ok, status, data }; исключения не бросает, чтобы каждая
     кнопка в кабинете могла показать текст ошибки, а не молча сломаться. */
  auth.account = async function (action, body, query) {
    /* Перед каждым обращением спрашиваем у клиента актуальную сессию. Страница
       кабинета живёт долго (или поднимается из кэша браузера после возврата с
       /login), а access-токен короткий: без этой строки первая же кнопка после
       простоя уходила бы с мёртвым токеном и получала 401. */
    try {
      await auth.ready;
      const client = makeClient();
      if (client) {
        const { data } = await client.auth.getSession();
        apply(data && data.session);
      }
    } catch (e) { /* сеть подведёт — пусть решает сам запрос ниже */ }

    const method = body ? 'POST' : 'GET';
    const url = body ? '/api/account' : '/api/account?action=' + encodeURIComponent(action) + (query ? '&'+new URLSearchParams(query) : '');
    const headers = { 'Content-Type': 'application/json' };
    if (auth.token) headers.Authorization = 'Bearer ' + auth.token;

    let response, data = null;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(Object.assign({ action }, body)) : undefined
      });
    } catch (e) {
      return { ok: false, status: 0, data: null, error: 'Нет связи с сервером — проверьте интернет, отключите VPN или блокировщик' };
    }
    try { data = await response.json(); } catch (e) { data = null; }
    return {
      ok: response.ok && data && data.ok !== false,
      status: response.status,
      data,
      error: (data && data.error && (data.error.message || data.error)) || (response.ok ? null : 'Ошибка ' + response.status)
    };
  };

  /* Пополнение баланса и оплата Pro идут через тот же существующий эндпоинт
     платежей. Наружу отправляется ТОЛЬКО сумма — начисляет сервер. */
  auth.createPayment = async function (payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
    let response, data = null;
    try {
      response = await fetch('/api/payment/create', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return { ok: false, error: 'Нет связи с сервером — проверьте интернет, отключите VPN или блокировщик' };
    }
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok || !data || !data.confirmationUrl) {
      return { ok: false, error: (data && data.error) || 'Не удалось создать платёж' };
    }
    return { ok: true, confirmationUrl: data.confirmationUrl, paymentId: data.paymentId };
  };

  window.hmAuth = auth;
})();
