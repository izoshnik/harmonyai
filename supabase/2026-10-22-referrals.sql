-- ============================================================================
-- HarmonyAI 0.8.4 — реферальная программа (приглашения в Pro).
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить → Run.
-- Скрипт идемпотентный: повторный запуск ничего не сломает.
--
-- Доступ к таблице — только у сервера (service_role): RLS включён, политик
-- для пользователей нет, поэтому из браузера таблицу не прочитать и не изменить.
-- ============================================================================

create table if not exists public.referral_invites (
  code               text primary key,
  inviter_id         uuid not null references auth.users(id) on delete cascade,
  created_at         timestamptz not null default now(),
  redeemed_by        uuid unique references auth.users(id) on delete set null,
  redeemed_at        timestamptz,
  trial_until        timestamptz,
  discount_used_at   timestamptz,
  discount_payment_id text
);

create index if not exists referral_invites_inviter_idx on public.referral_invites (inviter_id);

alter table public.referral_invites enable row level security;
revoke all on public.referral_invites from anon, authenticated;
