-- Saved progress, one row per player: each player reads and writes only their own row.
-- Copy to <game>/supabase/migrations/<yyyymmddhhmmss>_progress.sql.
create table public.progress (
  player_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 65536),
  updated_at timestamptz not null default now()
);

alter table public.progress enable row level security;

create policy "players read their own progress" on public.progress
  for select to authenticated using ((select auth.uid()) = player_id);

create policy "players save their own progress" on public.progress
  for insert to authenticated with check ((select auth.uid()) = player_id);

create policy "players update their own progress" on public.progress
  for update to authenticated using ((select auth.uid()) = player_id) with check ((select auth.uid()) = player_id);
