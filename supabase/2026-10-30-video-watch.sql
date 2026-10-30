-- Просмотр видео ИИ (YouTube/TikTok по ссылке): учёт для лимита Free
-- (5 разных роликов в сутки). Пишет и читает только сервер (service-role).
create table if not exists public.video_watches (
  id bigserial primary key,
  user_id uuid not null,
  video_key text not null,
  duration integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists video_watches_user_time on public.video_watches (user_id, created_at desc);
alter table public.video_watches enable row level security;
-- Политик нет намеренно: клиенты таблицу не видят.
