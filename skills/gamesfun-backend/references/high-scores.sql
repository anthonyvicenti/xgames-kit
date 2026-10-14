-- A high-score table: everyone may read the board; a player may add only their own scores, never change or remove one.
-- Copy to <game>/supabase/migrations/<yyyymmddhhmmss>_high_scores.sql. Players sign in anonymously (backend.json
-- "players": "anonymous"), so auth.uid() is each player's own id; anonymous users have the role `authenticated`.
create table public.high_scores (
  id bigint generated always as identity primary key,
  player_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  score integer not null check (score >= 0 and score < 1000000),
  created_at timestamptz not null default now()
);

alter table public.high_scores enable row level security;

create policy "anyone reads the board" on public.high_scores
  for select to anon, authenticated using (true);

create policy "players add their own scores" on public.high_scores
  for insert to authenticated with check ((select auth.uid()) = player_id);

create index high_scores_by_score on public.high_scores (score desc);
