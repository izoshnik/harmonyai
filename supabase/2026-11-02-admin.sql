-- ============================================================================
-- HarmonyAI — панель управления сервисом (/management).
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить → Run.
-- Скрипт идемпотентный: повторный запуск ничего не сломает и данных не удалит.
--
-- Что добавляется:
--   • hm_request_log    — журнал запросов к моделям: источник, модель,
--                          провайдер, токены, оценка себестоимости, задержка;
--   • hm_error_log      — ошибки сервиса с уникальным кодом (его видит
--                          пользователь вместо текста ошибки);
--   • hm_message_ratings — лайки и дизлайки ответов;
--   • hm_admin_actions  — журнал действий персонала (Pro, блокировка, лимиты);
--   • profiles.blocked_at / blocked_reason / limits_reset_at;
--   • функции hm_admin_* — сводки для панели (считаются в базе, наружу уходит
--     только готовый JSON).
--
-- Доступ — только у сервера (service_role): RLS включён, политик нет, функции
-- закрыты от anon и authenticated. Из браузера ничего из этого не прочитать.
-- ============================================================================

-- ---------------------------------------------------------------- таблицы
create table if not exists public.hm_request_log (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  user_id        uuid,
  source         text not null,             -- chat | api | image | video_gen | video_watch | music | recognize | memory
  plan           text,                      -- free | pro | staff | api
  model          text,                      -- публичное имя: adanatos, dynatos, image…
  upstream       text,                      -- реальная модель провайдера
  provider       text,                      -- pro-ai | openrouter | gemini | closerouter | cloudflare …
  ok             boolean not null default true,
  status         int,
  latency_ms     int,
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  cost_usd       numeric(14,6) not null default 0,   -- наша себестоимость (оценка по тарифам)
  charged_micro  bigint not null default 0,           -- списано с баланса API, µ₽
  tried          text[],
  think          boolean,
  effort         text,
  search         boolean,
  error_code     text
);
create index if not exists hm_request_log_created_idx on public.hm_request_log (created_at desc);
create index if not exists hm_request_log_user_idx on public.hm_request_log (user_id, created_at desc);
create index if not exists hm_request_log_source_idx on public.hm_request_log (source, created_at desc);

create table if not exists public.hm_error_log (
  id          bigserial primary key,
  code        text not null unique,
  created_at  timestamptz not null default now(),
  user_id     uuid,
  source      text,             -- chat | api | image | video_gen | client …
  status      int,
  kind        text,             -- timeout | overloaded | unavailable | quota | network | internal …
  message     text,             -- техническая причина (пользователь её не видит)
  detail      jsonb,            -- модель, цепочка, режим, браузер…
  user_text   text,             -- первые 200 символов сообщения; стирается через 30 дней
  resolved_at timestamptz
);
create index if not exists hm_error_log_created_idx on public.hm_error_log (created_at desc);
create index if not exists hm_error_log_user_idx on public.hm_error_log (user_id, created_at desc);

create table if not exists public.hm_message_ratings (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid,
  rating      smallint not null check (rating in (-1, 1)),
  model       text,
  excerpt     text
);
create index if not exists hm_message_ratings_created_idx on public.hm_message_ratings (created_at desc);

create table if not exists public.hm_admin_actions (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  admin_id    uuid,
  target_id   uuid,
  action      text not null,
  detail      jsonb
);
create index if not exists hm_admin_actions_target_idx on public.hm_admin_actions (target_id, created_at desc);

alter table public.profiles add column if not exists blocked_at timestamptz;
alter table public.profiles add column if not exists blocked_reason text;
alter table public.profiles add column if not exists limits_reset_at timestamptz;

alter table public.hm_request_log enable row level security;
alter table public.hm_error_log enable row level security;
alter table public.hm_message_ratings enable row level security;
alter table public.hm_admin_actions enable row level security;
revoke all on public.hm_request_log, public.hm_error_log, public.hm_message_ratings, public.hm_admin_actions from anon, authenticated;

-- ---------------------------------------------------------------- помощники
-- Запрос к таблице, которой может не быть в этой базе: вернёт null, а не ошибку.
create or replace function public.hm__safe(q text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  execute q into r;
  return r;
exception when undefined_table or undefined_column or undefined_function then
  return null;
end $$;

-- Pro так же, как lib/auth.js → hasProAccess.
create or replace function public.hm__is_pro(p_role text, p_plan text, p_exp timestamptz) returns boolean
language sql immutable as $$
  select case
    when lower(coalesce(p_role,'')) in ('developer','admin','moderator') then true
    when lower(coalesce(p_plan,'')) = 'pro' or (coalesce(p_plan,'') = '' and lower(coalesce(p_role,'')) = 'pro')
      then p_exp is null or p_exp > now()
    else false end
$$;

-- Активность пользователя: чат (usage_events) + журнал запросов.
create or replace function public.hm__activity(p_since timestamptz)
returns table(user_id uuid, at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.user_id, e.created_at from public.usage_events e where e.created_at >= p_since and e.user_id is not null
  union all
  select r.user_id, r.created_at from public.hm_request_log r where r.created_at >= p_since and r.user_id is not null
$$;

-- ---------------------------------------------------------------- общая статистика
create or replace function public.hm_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v jsonb;
  d0 timestamptz := (date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow');
begin
  with u as (
    select au.id, au.created_at, p.role, p.plan, p.plan_expires_at, p.blocked_at
    from auth.users au left join public.profiles p on p.id = au.id
  ), act as (select * from public.hm__activity(now() - interval '31 days')),
  ue as (select * from public.usage_events where created_at >= now() - interval '31 days')
  select jsonb_build_object(
    'usersTotal', (select count(*) from u),
    'usersNew', jsonb_build_object(
      'hour',  (select count(*) from u where created_at >= now() - interval '1 hour'),
      'day',   (select count(*) from u where created_at >= d0),
      'week',  (select count(*) from u where created_at >= now() - interval '7 days'),
      'month', (select count(*) from u where created_at >= now() - interval '30 days')),
    'usersActive', jsonb_build_object(
      'hour',  (select count(distinct user_id) from act where at >= now() - interval '1 hour'),
      'day',   (select count(distinct user_id) from act where at >= d0),
      'week',  (select count(distinct user_id) from act where at >= now() - interval '7 days'),
      'month', (select count(distinct user_id) from act where at >= now() - interval '30 days')),
    'pro', (select count(*) from u where public.hm__is_pro(role, plan, plan_expires_at) and lower(coalesce(role,'')) not in ('developer','admin','moderator')),
    'staff', (select count(*) from u where lower(coalesce(role,'')) in ('developer','admin','moderator')),
    'blocked', (select count(*) from u where blocked_at is not null),
    'messages', jsonb_build_object(
      'day',   (select coalesce(sum(messages),0) from ue where model in ('adanatos','dynatos') and created_at >= d0),
      'week',  (select coalesce(sum(messages),0) from ue where model in ('adanatos','dynatos') and created_at >= now() - interval '7 days'),
      'month', (select coalesce(sum(messages),0) from ue where model in ('adanatos','dynatos') and created_at >= now() - interval '30 days'),
      'total', (select coalesce(sum(messages),0) from public.usage_events where model in ('adanatos','dynatos'))),
    'tokens', jsonb_build_object(
      'day',   (select coalesce(sum(tokens),0) from ue where model in ('adanatos','dynatos') and created_at >= d0),
      'month', (select coalesce(sum(tokens),0) from ue where model in ('adanatos','dynatos') and created_at >= now() - interval '30 days'),
      'total', (select coalesce(sum(tokens),0) from public.usage_events where model in ('adanatos','dynatos'))),
    'errorsDay', (select count(*) from public.hm_error_log where created_at >= now() - interval '24 hours'),
    'requestsDay', (select count(*) from public.hm_request_log where created_at >= now() - interval '24 hours'),
    'costMonthUsd', (select coalesce(sum(cost_usd),0) from public.hm_request_log where created_at >= now() - interval '30 days'),
    'revenueMonthKop', (select coalesce(sum(amount_kopecks),0) from public.payments where status = 'succeeded' and coalesce(paid_at, created_at) >= now() - interval '30 days'),
    'apiUsersMonth', (select count(distinct user_id) from public.hm_request_log where source = 'api' and created_at >= now() - interval '30 days'),
    'logSince', (select min(created_at) from public.hm_request_log),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('d', d, 'reg', reg, 'active', active, 'messages', msgs) order by d), '[]'::jsonb)
      from (
        select g.ts::date d,
          (select count(*) from u where (u.created_at at time zone 'Europe/Moscow')::date = g.ts::date) reg,
          (select count(distinct user_id) from act where (act.at at time zone 'Europe/Moscow')::date = g.ts::date) active,
          (select coalesce(sum(messages),0) from ue where model in ('adanatos','dynatos') and (ue.created_at at time zone 'Europe/Moscow')::date = g.ts::date) msgs
        from generate_series((now() at time zone 'Europe/Moscow')::date - 29, (now() at time zone 'Europe/Moscow')::date, interval '1 day') as g(ts)
      ) s),
    'plans', (
      select jsonb_build_object(
        'free', count(*) filter (where not public.hm__is_pro(role, plan, plan_expires_at)),
        'pro', count(*) filter (where public.hm__is_pro(role, plan, plan_expires_at) and lower(coalesce(role,'')) not in ('developer','admin','moderator')),
        'staff', count(*) filter (where lower(coalesce(role,'')) in ('developer','admin','moderator')))
      from u)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- пользователи
create or replace function public.hm_admin_users(p_q text default '', p_filter text default 'all', p_sort text default 'created', p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb; q text := lower(trim(coalesce(p_q,'')));
begin
  with base as (
    select au.id, au.email, au.created_at, au.last_sign_in_at,
           to_jsonb(p) ->> 'nickname' as nickname, p.role, p.plan, p.plan_expires_at, p.blocked_at,
           public.hm__is_pro(p.role, p.plan, p.plan_expires_at) as pro
    from auth.users au left join public.profiles p on p.id = au.id
  ), ue as (
    select user_id, sum(messages) filter (where model in ('adanatos','dynatos')) msgs,
           sum(tokens) filter (where model in ('adanatos','dynatos')) toks, max(created_at) last_at
    from public.usage_events group by user_id
  ), rl as (
    select user_id, sum(cost_usd) cost, max(created_at) last_at, bool_or(source = 'api') api
    from public.hm_request_log group by user_id
  ), j as (
    select b.*, coalesce(ue.msgs,0) messages, coalesce(ue.toks,0) tokens, coalesce(rl.cost,0) cost_usd,
           greatest(ue.last_at, rl.last_at, b.last_sign_in_at) last_active, coalesce(rl.api,false) api
    from base b left join ue on ue.user_id = b.id left join rl on rl.user_id = b.id
    where (q = '' or lower(coalesce(b.email,'')) like '%' || q || '%' or lower(coalesce(b.nickname,'')) like '%' || q || '%' or b.id::text like q || '%')
      and case coalesce(p_filter,'all')
        when 'pro' then b.pro and lower(coalesce(b.role,'')) not in ('developer','admin','moderator')
        when 'free' then not b.pro
        when 'staff' then lower(coalesce(b.role,'')) in ('developer','admin','moderator')
        when 'blocked' then b.blocked_at is not null
        when 'api' then coalesce(rl.api,false)
        else true end
  )
  select jsonb_build_object(
    'total', (select count(*) from j),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x)) from (
        select id, email, nickname, role, plan, plan_expires_at, pro, blocked_at is not null as blocked,
               created_at, last_active, messages, tokens, round(cost_usd, 4) as cost_usd
        from j
        order by
          case when p_sort = 'messages' then messages end desc nulls last,
          case when p_sort = 'cost' then cost_usd end desc nulls last,
          case when p_sort = 'active' then last_active end desc nulls last,
          created_at desc
        limit greatest(1, least(coalesce(p_limit,50), 200)) offset greatest(0, coalesce(p_offset,0))
      ) x), '[]'::jsonb)
  ) into v;
  return v;
end $$;

create or replace function public.hm_admin_user(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb;
begin
  if not exists (select 1 from auth.users where id = p_user) then return null; end if;
  select jsonb_build_object(
    'profile', (
      select jsonb_build_object('id', au.id, 'email', au.email, 'createdAt', au.created_at, 'lastSignInAt', au.last_sign_in_at,
        'provider', au.raw_app_meta_data ->> 'provider',
        'nickname', to_jsonb(p) ->> 'nickname', 'role', p.role, 'plan', p.plan, 'planExpiresAt', p.plan_expires_at,
        'pro', public.hm__is_pro(p.role, p.plan, p.plan_expires_at),
        'blockedAt', p.blocked_at, 'blockedReason', p.blocked_reason, 'limitsResetAt', p.limits_reset_at,
        'aiTraining', coalesce((p.settings ->> 'ai_training')::boolean, true),
        'source', coalesce(to_jsonb(p) ->> 'source', to_jsonb(p) ->> 'signup_source'))
      from auth.users au left join public.profiles p on p.id = au.id where au.id = p_user),
    'totals', jsonb_build_object(
      'messages', (select coalesce(sum(messages),0) from public.usage_events where user_id = p_user and model in ('adanatos','dynatos')),
      'tokens', (select coalesce(sum(tokens),0) from public.usage_events where user_id = p_user and model in ('adanatos','dynatos')),
      'images', (select coalesce(sum(messages),0) from public.usage_events where user_id = p_user and model = 'image'),
      'videos', (select coalesce(sum(messages),0) from public.usage_events where user_id = p_user and model = 'video_gen'),
      'chats', public.hm__safe(format('select to_jsonb(count(*)) from public.chats where user_id = %L', p_user)),
      'memories', public.hm__safe(format('select to_jsonb(count(*)) from public.user_memories where user_id = %L and is_active', p_user)),
      'videoWatches', public.hm__safe(format('select to_jsonb(count(*)) from public.video_watches where user_id = %L', p_user)),
      'requests', (select count(*) from public.hm_request_log where user_id = p_user),
      'inputTokens', (select coalesce(sum(input_tokens),0) from public.hm_request_log where user_id = p_user),
      'outputTokens', (select coalesce(sum(output_tokens),0) from public.hm_request_log where user_id = p_user)),
    'cost', jsonb_build_object(
      'totalUsd', (select coalesce(sum(cost_usd),0) from public.hm_request_log where user_id = p_user),
      'monthUsd', (select coalesce(sum(cost_usd),0) from public.hm_request_log where user_id = p_user and created_at >= now() - interval '30 days'),
      'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'n', n, 'usd', usd) order by usd desc), '[]'::jsonb)
                   from (select source, count(*) n, sum(cost_usd) usd from public.hm_request_log where user_id = p_user group by source) s)),
    'revenue', jsonb_build_object(
      'totalKop', (select coalesce(sum(amount_kopecks),0) from public.payments where user_id = p_user and status = 'succeeded'),
      'payments', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'kop', amount_kopecks, 'status', status, 'at', coalesce(paid_at, created_at)) order by created_at desc), '[]'::jsonb)
                   from (select * from public.payments where user_id = p_user order by created_at desc limit 20) x)),
    'api', jsonb_build_object(
      'balanceMicro', public.hm__safe(format('select to_jsonb(coalesce(sum(balance_micro),0)) from public.api_balances where user_id = %L', p_user)),
      'keysActive', public.hm__safe(format('select to_jsonb(count(*)) from public.api_keys where user_id = %L and revoked_at is null', p_user)),
      'requests', (select count(*) from public.hm_request_log where user_id = p_user and source = 'api'),
      'chargedMicro', (select coalesce(sum(charged_micro),0) from public.hm_request_log where user_id = p_user and source = 'api')),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('d', d, 'messages', m, 'tokens', t) order by d), '[]'::jsonb) from (
        select g::date d,
          (select coalesce(sum(messages),0) from public.usage_events where user_id = p_user and model in ('adanatos','dynatos') and (created_at at time zone 'Europe/Moscow')::date = g::date) m,
          (select coalesce(sum(tokens),0) from public.usage_events where user_id = p_user and model in ('adanatos','dynatos') and (created_at at time zone 'Europe/Moscow')::date = g::date) t
        from generate_series((now() at time zone 'Europe/Moscow')::date - 29, (now() at time zone 'Europe/Moscow')::date, interval '1 day') g) s),
    'models', (select coalesce(jsonb_agg(jsonb_build_object('model', model, 'messages', m, 'tokens', t) order by m desc), '[]'::jsonb)
               from (select model, sum(messages) m, sum(tokens) t from public.usage_events where user_id = p_user group by model) s),
    'errors', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'at', created_at, 'source', source, 'status', status, 'kind', kind, 'message', message) order by created_at desc), '[]'::jsonb)
               from (select * from public.hm_error_log where user_id = p_user order by created_at desc limit 20) e),
    'referral', jsonb_build_object(
      'invited', public.hm__safe(format('select to_jsonb(count(*)) from public.referral_invites where inviter_id = %L and redeemed_by is not null', p_user)),
      'invitedBy', public.hm__safe(format('select to_jsonb(min(u.email)) from public.referral_invites r join auth.users u on u.id = r.inviter_id where r.redeemed_by = %L', p_user))),
    'actions', (select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'action', a.action, 'detail', a.detail, 'admin', u.email) order by a.created_at desc), '[]'::jsonb)
                from (select * from public.hm_admin_actions where target_id = p_user order by created_at desc limit 20) a left join auth.users u on u.id = a.admin_id)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- токены и сообщения
create or replace function public.hm_admin_usage(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,30), 365)));
begin
  with ue as (select * from public.usage_events where created_at >= since),
  chat as (select * from ue where model in ('adanatos','dynatos')),
  rl as (select * from public.hm_request_log where created_at >= since)
  select jsonb_build_object(
    'messages', (select coalesce(sum(messages),0) from chat),
    'tokens', (select coalesce(sum(tokens),0) from chat),
    'users', (select count(distinct user_id) from chat),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'messages', m, 'tokens', t, 'users', n) order by d), '[]'::jsonb)
               from (select (created_at at time zone 'Europe/Moscow')::date d, sum(messages) m, sum(tokens) t, count(distinct user_id) n from chat group by 1) s),
    'byModel', (select coalesce(jsonb_agg(jsonb_build_object('model', model, 'messages', m, 'tokens', t, 'users', n) order by m desc), '[]'::jsonb)
                from (select model, sum(messages) m, sum(tokens) t, count(distinct user_id) n from ue group by model) s),
    'topUsers', (select coalesce(jsonb_agg(jsonb_build_object('id', s.user_id, 'email', au.email, 'messages', s.m, 'tokens', s.t) order by s.t desc), '[]'::jsonb)
                 from (select user_id, sum(messages) m, sum(tokens) t from chat group by user_id order by sum(tokens) desc limit 15) s
                 left join auth.users au on au.id = s.user_id),
    'heat', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'h', h, 'n', n)), '[]'::jsonb)
             from (select extract(isodow from created_at at time zone 'Europe/Moscow')::int dow, extract(hour from created_at at time zone 'Europe/Moscow')::int h, sum(messages) n
                   from chat group by 1, 2) s),
    'log', (select jsonb_build_object(
              'requests', count(*), 'inputTokens', coalesce(sum(input_tokens),0), 'outputTokens', coalesce(sum(output_tokens),0),
              'avgLatencyMs', round(avg(latency_ms) filter (where ok)), 'think', count(*) filter (where think), 'search', count(*) filter (where search),
              'effort', (select coalesce(jsonb_object_agg(e, n), '{}'::jsonb) from (select coalesce(effort,'low') e, count(*) n from rl where source = 'chat' group by 1) x))
            from rl where source = 'chat'),
    'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'n', n, 'in', i, 'out', o) order by n desc), '[]'::jsonb)
                 from (select source, count(*) n, sum(input_tokens) i, sum(output_tokens) o from rl group by source) s)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- публичный API
create or replace function public.hm_admin_api(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,30), 365)));
begin
  with a as (select * from public.hm_request_log where source = 'api' and created_at >= since)
  select jsonb_build_object(
    'users', (select count(distinct user_id) from a),
    'requests', (select count(*) from a),
    'errors', (select count(*) from a where not ok),
    'inputTokens', (select coalesce(sum(input_tokens),0) from a),
    'outputTokens', (select coalesce(sum(output_tokens),0) from a),
    'chargedMicro', (select coalesce(sum(charged_micro),0) from a),
    'costUsd', (select coalesce(sum(cost_usd),0) from a),
    'avgLatencyMs', (select round(avg(latency_ms)) from a where ok),
    'keysActive', public.hm__safe('select to_jsonb(count(*)) from public.api_keys where revoked_at is null'),
    'keyOwners', public.hm__safe('select to_jsonb(count(distinct user_id)) from public.api_keys where revoked_at is null'),
    'balancesMicro', public.hm__safe('select to_jsonb(coalesce(sum(balance_micro),0)) from public.api_balances'),
    'topupsKop', (select coalesce(sum(amount_kopecks),0) from public.payments where status = 'succeeded' and type <> 'subscription' and coalesce(paid_at, created_at) >= since),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'requests', n, 'tokens', t, 'charged', c) order by d), '[]'::jsonb)
               from (select (created_at at time zone 'Europe/Moscow')::date d, count(*) n, sum(input_tokens + output_tokens) t, sum(charged_micro) c from a group by 1) s),
    'byModel', (select coalesce(jsonb_agg(jsonb_build_object('model', model, 'requests', n, 'in', i, 'out', o, 'charged', c, 'cost', u) order by n desc), '[]'::jsonb)
                from (select model, count(*) n, sum(input_tokens) i, sum(output_tokens) o, sum(charged_micro) c, sum(cost_usd) u from a group by model) s),
    'topUsers', (select coalesce(jsonb_agg(jsonb_build_object('id', s.user_id, 'email', au.email, 'requests', s.n, 'tokens', s.t, 'charged', s.c) order by s.n desc), '[]'::jsonb)
                 from (select user_id, count(*) n, sum(input_tokens + output_tokens) t, sum(charged_micro) c from a group by user_id order by count(*) desc limit 15) s
                 left join auth.users au on au.id = s.user_id)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- ошибки
create or replace function public.hm_admin_errors(p_days int default 7, p_q text default '', p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,7), 365))); q text := trim(coalesce(p_q,''));
begin
  -- Обещание пользователям: текст сообщения хранится не дольше 30 дней.
  update public.hm_error_log set user_text = null where user_text is not null and created_at < now() - interval '30 days';
  with e as (select * from public.hm_error_log where created_at >= since or (q <> '' and code = q))
  select jsonb_build_object(
    'total', (select count(*) from e),
    'users', (select count(distinct user_id) from e),
    'byKind', (select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(kind,'other') k, count(*) n from e group by 1) s),
    'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', k, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(source,'other') k, count(*) n from e group by 1) s),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d), '[]'::jsonb) from (select (created_at at time zone 'Europe/Moscow')::date d, count(*) n from e group by 1) s),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'at', x.created_at, 'userId', x.user_id, 'email', au.email, 'source', x.source, 'status', x.status,
                     'kind', x.kind, 'message', x.message, 'detail', x.detail, 'userText', x.user_text) order by x.created_at desc), '[]'::jsonb)
             from (select * from e where q = '' or code ilike q || '%' or message ilike '%' || q || '%' order by created_at desc limit greatest(1, least(coalesce(p_limit,100), 500))) x
             left join auth.users au on au.id = x.user_id)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- финансы
create or replace function public.hm_admin_finance(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,30), 3650)));
begin
  with pay as (select *, coalesce(paid_at, created_at) at_ from public.payments where status = 'succeeded'),
  pp as (select * from pay where at_ >= since),
  rl as (select * from public.hm_request_log where created_at >= since)
  select jsonb_build_object(
    'revenueKop', (select coalesce(sum(amount_kopecks),0) from pp),
    'revenueAllKop', (select coalesce(sum(amount_kopecks),0) from pay),
    'subscriptionKop', (select coalesce(sum(amount_kopecks),0) from pp where type = 'subscription'),
    'topupKop', (select coalesce(sum(amount_kopecks),0) from pp where type <> 'subscription'),
    'payments', (select count(*) from pp),
    'payers', (select count(distinct user_id) from pp),
    'payersAll', (select count(distinct user_id) from pay),
    'costUsd', (select coalesce(sum(cost_usd),0) from rl),
    'costAllUsd', (select coalesce(sum(cost_usd),0) from public.hm_request_log),
    'apiChargedMicro', (select coalesce(sum(charged_micro),0) from rl where source = 'api'),
    'paidPro', (select count(*) from public.profiles p where lower(coalesce(p.plan,'')) = 'pro' and p.plan_expires_at > now()
                  and exists (select 1 from pay where pay.user_id = p.id and pay.type = 'subscription')),
    'costBySource', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'usd', u, 'n', n) order by u desc), '[]'::jsonb)
                     from (select source, sum(cost_usd) u, count(*) n from rl group by source) s),
    'costByProvider', (select coalesce(jsonb_agg(jsonb_build_object('provider', provider, 'usd', u, 'n', n) order by u desc), '[]'::jsonb)
                       from (select coalesce(provider,'—') provider, sum(cost_usd) u, count(*) n from rl group by 1) s),
    'costByPlan', (select coalesce(jsonb_agg(jsonb_build_object('plan', plan, 'usd', u, 'users', n) order by u desc), '[]'::jsonb)
                   from (select coalesce(plan,'—') plan, sum(cost_usd) u, count(distinct user_id) n from rl group by 1) s),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', g::date,
                  'rev', (select coalesce(sum(amount_kopecks),0) from pp where (at_ at time zone 'Europe/Moscow')::date = g::date),
                  'cost', (select coalesce(sum(cost_usd),0) from rl where (created_at at time zone 'Europe/Moscow')::date = g::date)) order by g), '[]'::jsonb)
               from generate_series((since at time zone 'Europe/Moscow')::date, (now() at time zone 'Europe/Moscow')::date, interval '1 day') g),
    'topSpenders', (select coalesce(jsonb_agg(jsonb_build_object('id', s.user_id, 'email', au.email, 'kop', s.k) order by s.k desc), '[]'::jsonb)
                    from (select user_id, sum(amount_kopecks) k from pay group by user_id order by sum(amount_kopecks) desc limit 10) s left join auth.users au on au.id = s.user_id),
    'topCost', (select coalesce(jsonb_agg(jsonb_build_object('id', s.user_id, 'email', au.email, 'usd', s.u) order by s.u desc), '[]'::jsonb)
                from (select user_id, sum(cost_usd) u from rl where user_id is not null group by user_id order by sum(cost_usd) desc limit 10) s left join auth.users au on au.id = s.user_id),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', x.at_, 'email', au.email, 'type', x.type, 'kop', x.amount_kopecks) order by x.at_ desc), '[]'::jsonb)
               from (select * from pay order by at_ desc limit 20) x left join auth.users au on au.id = x.user_id)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- модели и провайдеры
create or replace function public.hm_admin_providers(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,7), 365)));
begin
  with rl as (select * from public.hm_request_log where created_at >= since)
  select jsonb_build_object(
    'byUpstream', (select coalesce(jsonb_agg(to_jsonb(s) order by s.n desc), '[]'::jsonb) from (
        select coalesce(provider,'—') provider, coalesce(upstream, model, '—') upstream, count(*) n,
               count(*) filter (where ok) ok, round(avg(latency_ms) filter (where ok)) avg_ms,
               round(percentile_cont(0.5) within group (order by latency_ms) filter (where ok)) p50,
               round(percentile_cont(0.95) within group (order by latency_ms) filter (where ok)) p95,
               count(*) filter (where coalesce(array_length(tried,1),0) > 1) fallbacks,
               round(sum(cost_usd), 4) usd
        from rl group by 1, 2) s),
    'failedModels', (select coalesce(jsonb_agg(jsonb_build_object('model', m, 'n', n) order by n desc), '[]'::jsonb) from (
        select t.m, count(*) n from rl, unnest(tried) as t(m) where tried is not null and coalesce(array_length(tried,1),0) > 1 and t.m is distinct from rl.upstream group by t.m) s),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n, 'fail', f, 'ms', ms) order by d), '[]'::jsonb) from (
        select (created_at at time zone 'Europe/Moscow')::date d, count(*) n, count(*) filter (where not ok) f, round(avg(latency_ms) filter (where ok)) ms from rl group by 1) s)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- генерации и функции
create or replace function public.hm_admin_features(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,30), 365)));
begin
  with rl as (select * from public.hm_request_log where created_at >= since)
  select jsonb_build_object(
    'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'n', n, 'users', u, 'ok', k) order by n desc), '[]'::jsonb)
                 from (select source, count(*) n, count(distinct user_id) u, count(*) filter (where ok) k from rl group by source) s),
    'usageModels', (select coalesce(jsonb_agg(jsonb_build_object('model', model, 'n', n, 'users', u) order by n desc), '[]'::jsonb)
                    from (select model, sum(messages) n, count(distinct user_id) u from public.usage_events where created_at >= since group by model) s),
    'chat', (select jsonb_build_object('total', count(*), 'search', count(*) filter (where search), 'think', count(*) filter (where think)) from rl where source = 'chat'),
    'metrics', public.hm__safe(format('select coalesce(jsonb_agg(jsonb_build_object(''kind'', kind, ''n'', n) order by n desc), ''[]''::jsonb) from (select kind, sum(coalesce(amount,1)) n from public.hm_metric_events where created_at >= %L group by kind) s', since)),
    'videoWatches', public.hm__safe(format('select to_jsonb(count(*)) from public.video_watches where created_at >= %L', since)),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'source', source, 'n', n) order by d), '[]'::jsonb)
               from (select (created_at at time zone 'Europe/Moscow')::date d, source, count(*) n from rl where source <> 'chat' group by 1, 2) s)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- удержание и источники
create or replace function public.hm_admin_retention() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb;
begin
  with u as (select id, created_at from auth.users where created_at >= now() - interval '12 weeks'),
  act as (select * from public.hm__activity(now() - interval '14 weeks')),
  per as (
    select u.id, u.created_at,
      exists (select 1 from act where act.user_id = u.id and act.at >= u.created_at + interval '1 day' and act.at < u.created_at + interval '2 days') d1,
      exists (select 1 from act where act.user_id = u.id and act.at >= u.created_at + interval '7 days' and act.at < u.created_at + interval '14 days') d7,
      exists (select 1 from act where act.user_id = u.id and act.at >= u.created_at + interval '30 days' and act.at < u.created_at + interval '60 days') d30,
      exists (select 1 from act where act.user_id = u.id) any_
    from u)
  select jsonb_build_object(
    'cohorts', (select coalesce(jsonb_agg(to_jsonb(s) order by s.week desc), '[]'::jsonb) from (
        select (date_trunc('week', created_at at time zone 'Europe/Moscow'))::date week, count(*) size,
          count(*) filter (where any_) activated,
          count(*) filter (where created_at <= now() - interval '2 days') e1, count(*) filter (where d1) d1,
          count(*) filter (where created_at <= now() - interval '14 days') e7, count(*) filter (where d7) d7,
          count(*) filter (where created_at <= now() - interval '60 days') e30, count(*) filter (where d30) d30
        from per group by 1) s),
    'conversion', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'payers', (select count(distinct user_id) from public.payments where status = 'succeeded' and type = 'subscription')),
    'referrals', public.hm__safe('select jsonb_build_object(''invites'', count(*), ''redeemed'', count(redeemed_by), ''inviters'', count(distinct inviter_id)) from public.referral_invites'),
    'providers', (select coalesce(jsonb_agg(jsonb_build_object('provider', p, 'n', n) order by n desc), '[]'::jsonb)
                  from (select coalesce(raw_app_meta_data ->> 'provider', 'email') p, count(*) n from auth.users group by 1) s)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- обратная связь
create or replace function public.hm_admin_feedback(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days,30), 365)));
begin
  select jsonb_build_object(
    'likes', (select count(*) from public.hm_message_ratings where rating = 1 and created_at >= since),
    'dislikes', (select count(*) from public.hm_message_ratings where rating = -1 and created_at >= since),
    'byModel', (select coalesce(jsonb_agg(jsonb_build_object('model', m, 'likes', l, 'dislikes', d) order by l + d desc), '[]'::jsonb)
                from (select coalesce(model,'—') m, count(*) filter (where rating = 1) l, count(*) filter (where rating = -1) d
                      from public.hm_message_ratings where created_at >= since group by 1) s),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'likes', l, 'dislikes', x) order by d), '[]'::jsonb)
               from (select (created_at at time zone 'Europe/Moscow')::date d, count(*) filter (where rating = 1) l, count(*) filter (where rating = -1) x
                     from public.hm_message_ratings where created_at >= since group by 1) s),
    'dislikedRecent', (select coalesce(jsonb_agg(jsonb_build_object('at', r.created_at, 'model', r.model, 'excerpt', r.excerpt, 'email', au.email) order by r.created_at desc), '[]'::jsonb)
                       from (select * from public.hm_message_ratings where rating = -1 order by created_at desc limit 20) r left join auth.users au on au.id = r.user_id),
    'corrections', public.hm__safe($q$select coalesce(jsonb_agg(jsonb_build_object('at', f.created_at, 'email', au.email, 'answer', left(f.assistant_excerpt, 300), 'correction', left(f.corrected_answer, 500), 'note', left(f.note, 300)) order by f.created_at desc), '[]'::jsonb)
                       from (select * from public.message_feedback order by created_at desc limit 30) f left join auth.users au on au.id = f.user_id$q$),
    'reports', public.hm__safe($q$select coalesce(jsonb_agg(jsonb_build_object('at', r.created_at, 'email', r.email, 'message', left(r.message, 800)) order by r.created_at desc), '[]'::jsonb)
                       from (select * from public.app_reports order by created_at desc limit 50) r$q$)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array[
    'hm__safe(text)', 'hm__activity(timestamptz)', 'hm_admin_overview()',
    'hm_admin_users(text,text,text,int,int)', 'hm_admin_user(uuid)', 'hm_admin_usage(int)', 'hm_admin_api(int)',
    'hm_admin_errors(int,text,int)', 'hm_admin_finance(int)', 'hm_admin_providers(int)', 'hm_admin_features(int)',
    'hm_admin_retention()', 'hm_admin_feedback(int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
