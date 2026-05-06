-- Manifest sync — Supabase setup
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.

-- One row per "sync code". The whole app state lives in the `data` JSONB blob.
create table if not exists public.manifest_data (
  sync_code text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on every change.
create or replace function public.touch_manifest_data() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_manifest_data on public.manifest_data;
create trigger trg_touch_manifest_data
before update on public.manifest_data
for each row execute function public.touch_manifest_data();

-- Row Level Security: each sync code can only read/write its own row.
-- Since we use the anon key from the browser, we lock things down by sync_code.
alter table public.manifest_data enable row level security;

-- Allow read/insert/update if a sync_code is supplied. We trust the
-- (random, ~12-char) sync_code as the secret. Treat it like a password.
drop policy if exists manifest_select on public.manifest_data;
create policy manifest_select on public.manifest_data
  for select to anon using (true);

drop policy if exists manifest_insert on public.manifest_data;
create policy manifest_insert on public.manifest_data
  for insert to anon with check (true);

drop policy if exists manifest_update on public.manifest_data;
create policy manifest_update on public.manifest_data
  for update to anon using (true) with check (true);

-- Index helps if you ever query by updated_at.
create index if not exists manifest_data_updated_idx on public.manifest_data (updated_at);
