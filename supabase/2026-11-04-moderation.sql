-- ============================================================================
-- Скрытый рейтинг пользователя (модерация).
--
-- Оскорбления ИИ и попытки обойти его защиту (взлом промпта, «игнорируй
-- инструкции», «режим без ограничений») записываются как нарушения. Рейтинг —
-- 100 минус баллы за нарушения последних 30 дней:
--   оскорбление          — 34 балла (3 оскорбления → рейтинг ≤ 0);
--   попытка обхода защиты — 50 баллов (2 попытки → рейтинг 0).
-- Рейтинг дошёл до 0 — аккаунт блокируется НАВСЕГДА (снять можно только
-- вручную в «Управлении сервисом»; при разблокировке нарушения «прощаются»).
-- Пользователю рейтинг не показывается. Сотрудников модерация не трогает.
--
-- Доступ — только у сервера (service_role): RLS включён, политик нет.
-- ============================================================================

create table if not exists public.hm_user_incidents (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid not null,
  kind        text not null check (kind in ('insult', 'jailbreak')),
  excerpt     text,                       -- первые 200 символов сообщения
  reason      text,                       -- коротко, почему модель так решила
  pardoned    boolean not null default false
);
create index if not exists hm_user_incidents_user_idx on public.hm_user_incidents (user_id, created_at desc);
alter table public.hm_user_incidents enable row level security;
revoke all on public.hm_user_incidents from anon, authenticated;

alter table public.profiles add column if not exists trust_score integer not null default 100;

-- Записать нарушение, пересчитать рейтинг и при необходимости заблокировать.
create or replace function public.hm_moderation_record(p_user uuid, p_kind text, p_excerpt text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pts integer;
  score integer;
  staff boolean;
  was_blocked boolean;
  now_blocked boolean := false;
begin
  if p_kind not in ('insult', 'jailbreak') then
    return jsonb_build_object('ok', false);
  end if;
  select lower(coalesce(role, '')) in ('developer', 'admin', 'moderator'), blocked_at is not null
    into staff, was_blocked
    from profiles where id = p_user;
  if coalesce(staff, false) then
    return jsonb_build_object('ok', true, 'skipped', 'staff');
  end if;

  insert into hm_user_incidents (user_id, kind, excerpt, reason)
  values (p_user, p_kind, left(coalesce(p_excerpt, ''), 200), left(coalesce(p_reason, ''), 200));

  select coalesce(sum(case kind when 'insult' then 34 when 'jailbreak' then 50 else 0 end), 0)
    into pts
    from hm_user_incidents
   where user_id = p_user and not pardoned and created_at > now() - interval '30 days';
  score := greatest(0, 100 - pts);

  update profiles set trust_score = score where id = p_user;

  if score <= 0 and not coalesce(was_blocked, false) then
    update profiles
       set blocked_at = now(),
           blocked_reason = 'Автоматически: оскорбления ИИ или попытки обойти защиту'
     where id = p_user;
    insert into hm_admin_actions (admin_id, target_id, action, detail)
    values (null, p_user, 'auto_block', jsonb_build_object('score', score, 'kind', p_kind));
    now_blocked := true;
  end if;

  return jsonb_build_object('ok', true, 'score', score, 'blocked', now_blocked);
end;
$$;
revoke all on function public.hm_moderation_record(uuid, text, text, text) from public, anon, authenticated;

-- Разблокировка из панели «прощает» нарушения: иначе следующее же сообщение
-- снова заблокировало бы аккаунт (баллы за 30 дней остаются).
create or replace function public.hm_moderation_pardon(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update hm_user_incidents set pardoned = true where user_id = p_user and not pardoned;
  update profiles set trust_score = 100 where id = p_user;
$$;
revoke all on function public.hm_moderation_pardon(uuid) from public, anon, authenticated;
