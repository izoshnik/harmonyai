-- ============================================================================
-- Ответ не теряется при выходе из вкладки (lib/chat-jobs.js).
--   chat_jobs — то, что сервер успел написать по запросу чата. Клиент, вернувшись
--   во вкладку (или после перезагрузки страницы), дочитывает ответ отсюда:
--   GET /api/chat?job=<id>. Запись удаляется, как только клиент получил ответ;
--   всё старше суток сервер удаляет сам.
-- Доступ — только у сервера (service_role).
-- ============================================================================

create table if not exists public.chat_jobs (
  id             text primary key,
  user_id        uuid not null,
  status         text not null default 'running',   -- running | done | error
  text           text not null default '',
  sources        jsonb,
  reasoning_ms   integer,
  truncated      boolean not null default false,
  error_message  text,
  error_code     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists chat_jobs_user_idx on public.chat_jobs (user_id);
create index if not exists chat_jobs_created_idx on public.chat_jobs (created_at);
alter table public.chat_jobs enable row level security;
revoke all on public.chat_jobs from anon, authenticated;
