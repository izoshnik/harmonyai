-- ============================================================================
-- Почта (lib/mailer.js, Resend): журнал отправок и рассылки.
--   hm_mail_log       — каждое письмо: кому, что, статус. По нему считается
--                       дневной лимит (бесплатный Resend — 100 писем в день) и
--                       то, кому рассылка уже ушла (продолжение на следующий день);
--   hm_mail_campaigns — рассылки из «Управления сервисом».
-- Согласие на новости — profiles.settings.news_opt_in (по умолчанию выключено).
-- Доступ — только у сервера (service_role).
-- ============================================================================

create table if not exists public.hm_mail_log (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  user_id      uuid,
  kind         text not null,          -- payment | topup | blocked | news:<campaign id> | test
  to_email     text,
  status       text not null,          -- sent | failed | limit
  provider_id  text,
  error        text
);
create index if not exists hm_mail_log_created_idx on public.hm_mail_log (created_at desc);
create index if not exists hm_mail_log_kind_idx on public.hm_mail_log (kind, user_id);
alter table public.hm_mail_log enable row level security;
revoke all on public.hm_mail_log from anon, authenticated;

create table if not exists public.hm_mail_campaigns (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  subject     text not null,
  body        text not null,
  total       integer not null default 0,
  sent        integer not null default 0,
  finished_at timestamptz
);
alter table public.hm_mail_campaigns enable row level security;
revoke all on public.hm_mail_campaigns from anon, authenticated;
