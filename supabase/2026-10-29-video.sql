-- Онлайн-кинотеатр: серверный ключ VK Видео (VK ID refresh-токен).
-- Значение зашифровано на сервере (AES-256-GCM, ключ MUSIC_ENCRYPTION_KEY),
-- читается только service-role ключом.
create table if not exists public.app_secrets (
  name text primary key,
  value_enc text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
-- Политик нет намеренно: anon и authenticated не видят таблицу вообще,
-- доступ только у service-role (сервер).
