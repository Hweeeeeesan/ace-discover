-- Optional database table for a future live-data version. The current app still
-- reads the generated lib/profiles.js snapshot.
create table if not exists public.profiles (
  id text primary key,
  name text not null,
  role text,
  major text,
  year text,
  school text,
  bio text,
  interests text[] default '{}',
  image_url text,
  image_source_kind text,
  slide_deck_url text,
  source_group text,
  source_row integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
