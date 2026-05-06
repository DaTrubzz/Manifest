-- Manifest sync — Supabase setup (auth edition)
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- NOTE: This replaces the old sync-code table. If you ran the previous version,
-- this script drops it and creates the new auth-based table.

drop table if exists public.manifest_data cascade;

-- One row per authenticated user.
create table public.manifest_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on every write.
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

-- RLS: each user can only read/write their own row.
alter table public.manifest_data enable row level security;

drop policy if exists manifest_select on public.manifest_data;
create policy manifest_select on public.manifest_data
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists manifest_insert on public.manifest_data;
create policy manifest_insert on public.manifest_data
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists manifest_update on public.manifest_data;
create policy manifest_update on public.manifest_data
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists manifest_data_updated_idx on public.manifest_data (updated_at);
