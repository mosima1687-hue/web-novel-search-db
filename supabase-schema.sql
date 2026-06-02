create extension if not exists "pgcrypto";

create table if not exists public.novels (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  code text not null,
  genre text not null,
  world text not null,
  settings jsonb not null default '[]'::jsonb,
  characters jsonb not null default '[]'::jsonb,
  keywords jsonb not null default '[]'::jsonb,
  platform text not null default '',
  serialization text not null default '',
  source_url text not null default '',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists novels_created_at_idx on public.novels (created_at desc);
create index if not exists novels_title_idx on public.novels (title);
create index if not exists novels_genre_idx on public.novels (genre);
create index if not exists novels_world_idx on public.novels (world);

alter table public.novels enable row level security;

drop policy if exists "server service role manages novels" on public.novels;

create policy "server service role manages novels"
on public.novels
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
