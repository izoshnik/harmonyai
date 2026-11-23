-- Apply in Supabase SQL Editor before enabling the worker.
create table if not exists public.funpay_automation_accounts (
  owner uuid primary key references auth.users(id) on delete cascade,
  seller_id text not null unique,
  credential text not null,
  rules jsonb not null default '{}',
  cursor jsonb,
  lease_id uuid,
  lease_until timestamptz,
  next_poll timestamptz not null default now(),
  last_poll timestamptz,
  issue text
);

create table if not exists public.funpay_automation_lots (
  sku text primary key,
  owner uuid not null references public.funpay_automation_accounts(owner) on delete cascade,
  offer text unique,
  category text not null,
  title text not null,
  items text[] not null,
  reusable boolean not null default false,
  enabled boolean not null default false
);
create index if not exists funpay_automation_lots_owner_idx on public.funpay_automation_lots(owner);

create table if not exists public.funpay_automation_events (
  owner uuid not null references public.funpay_automation_accounts(owner) on delete cascade,
  event_key text not null,
  state text not null check (state in ('reserved','sent','check','waiting')),
  items text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (owner,event_key)
);

alter table public.funpay_automation_accounts enable row level security;
alter table public.funpay_automation_lots enable row level security;
alter table public.funpay_automation_events enable row level security;
revoke all on public.funpay_automation_accounts, public.funpay_automation_lots, public.funpay_automation_events from anon, authenticated;
grant select, insert, update, delete on public.funpay_automation_accounts, public.funpay_automation_lots, public.funpay_automation_events to service_role;

create or replace function public.funpay_claim_account(p_lease uuid)
returns setof public.funpay_automation_accounts
language sql set search_path = public as $$
  with candidate as (
    select owner from public.funpay_automation_accounts
    where next_poll <= now() and (lease_until is null or lease_until < now())
    order by next_poll limit 1 for update skip locked
  )
  update public.funpay_automation_accounts a
  set lease_id = p_lease, lease_until = now() + interval '2 minutes'
  from candidate where a.owner = candidate.owner returning a.*;
$$;

create or replace function public.funpay_set_rule(p_owner uuid, p_name text, p_body text)
returns jsonb language sql set search_path = public as $$
  update public.funpay_automation_accounts set rules = case
    when p_body is null then rules - p_name
    else jsonb_set(rules, array[p_name], to_jsonb(p_body), true) end
  where owner = p_owner returning rules;
$$;

create or replace function public.funpay_stock_add(p_owner uuid, p_offer text, p_items text[])
returns boolean language sql set search_path = public as $$
  with updated as (
    update public.funpay_automation_lots
    set items = case when reusable then p_items else items || p_items end
    where owner = p_owner and offer = p_offer and enabled
      and (not reusable or cardinality(p_items) = 1)
    returning 1
  )
  select exists(select 1 from updated);
$$;

-- Keep an event reserved as soon as a remote send may happen. A timeout must
-- never cause a second delivery or return a potentially issued item to stock.
create or replace function public.funpay_claim_event(
  p_owner uuid, p_lease uuid, p_event text, p_sku text, p_order_amount int
) returns table(state text, items text[])
language plpgsql set search_path = public as $$
declare
  lot public.funpay_automation_lots%rowtype;
  taken text[] := '{}';
  event_state text := 'reserved';
begin
  perform 1 from public.funpay_automation_accounts
    where owner = p_owner and lease_id = p_lease and lease_until > now() for update;
  if not found then return; end if;

  if exists(select 1 from public.funpay_automation_events e
    where e.owner = p_owner and e.event_key = p_event and e.state <> 'waiting') then return; end if;

  if p_sku is not null then
    select * into lot from public.funpay_automation_lots l
      where l.sku = p_sku and l.owner = p_owner and l.enabled and l.offer is not null for update;
    if not found or p_order_amount < 1 or p_order_amount > 100 then return; end if;
    if cardinality(lot.items) < (case when lot.reusable then 1 else p_order_amount end) then
      event_state := 'waiting';
    elsif lot.reusable then taken := lot.items[1:1];
    else
      taken := lot.items[1:p_order_amount];
      update public.funpay_automation_lots set items = lot.items[p_order_amount+1:cardinality(lot.items)]
        where sku = p_sku;
    end if;
  end if;

  insert into public.funpay_automation_events(owner,event_key,state,items)
    values(p_owner,p_event,event_state,taken)
  on conflict (owner,event_key) do update set state=excluded.state,items=excluded.items;
  return query select event_state,taken;
end;
$$;

revoke all on function public.funpay_claim_account(uuid), public.funpay_set_rule(uuid,text,text),
  public.funpay_stock_add(uuid,text,text[]), public.funpay_claim_event(uuid,uuid,text,text,int) from public, anon, authenticated;
grant execute on function public.funpay_claim_account(uuid), public.funpay_set_rule(uuid,text,text),
  public.funpay_stock_add(uuid,text,text[]), public.funpay_claim_event(uuid,uuid,text,text,int) to service_role;
