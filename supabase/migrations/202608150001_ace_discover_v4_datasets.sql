create extension if not exists pgcrypto;

create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 100),
  term text not null check (term in ('Spring', 'Summer', 'Fall', 'Winter')),
  year integer not null check (year between 2020 and 2100),
  status text not null default 'ready' check (status in ('ready', 'active', 'archived')),
  profile_count integer not null default 0 check (profile_count >= 0),
  health jsonb not null default '{}'::jsonb,
  safe_issues jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  imported_at timestamptz not null default now(),
  activated_at timestamptz,
  archived_at timestamptz
);

create unique index if not exists datasets_one_active_idx
  on public.datasets ((status)) where status = 'active';

create table if not exists public.dataset_profiles (
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  profile_id text not null,
  ordinal integer not null check (ordinal >= 0),
  public_data jsonb not null,
  drive_file_id text,
  drive_folder_id text,
  image_kind text,
  image_issue text,
  primary key (dataset_id, profile_id),
  unique (dataset_id, ordinal)
);

create index if not exists dataset_profiles_dataset_idx
  on public.dataset_profiles (dataset_id, ordinal);

create table if not exists public.app_settings (
  singleton boolean primary key default true check (singleton),
  active_dataset_id uuid references public.datasets(id) on delete restrict,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (singleton) values (true)
on conflict (singleton) do nothing;

create table if not exists public.dataset_imports (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  term text not null,
  year integer not null,
  profile_count integer not null,
  normalized_profiles jsonb not null,
  health jsonb not null,
  safe_issues jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

alter table public.datasets enable row level security;
alter table public.dataset_profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.dataset_imports enable row level security;

revoke all on public.datasets from anon, authenticated;
revoke all on public.dataset_profiles from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;
revoke all on public.dataset_imports from anon, authenticated;

create or replace function public.get_active_dataset()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id,
      'slug', d.slug,
      'name', d.name,
      'term', d.term,
      'year', d.year,
      'status', d.status,
      'profile_count', d.profile_count,
      'created_at', d.created_at,
      'imported_at', d.imported_at,
      'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(dp.public_data order by dp.ordinal)
      from public.dataset_profiles dp
      where dp.dataset_id = d.id
    ), '[]'::jsonb)
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  where s.singleton and d.status = 'active';
$$;

create or replace function public.get_published_dataset(requested_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id,
      'slug', d.slug,
      'name', d.name,
      'term', d.term,
      'year', d.year,
      'status', d.status,
      'profile_count', d.profile_count,
      'created_at', d.created_at,
      'imported_at', d.imported_at,
      'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(dp.public_data order by dp.ordinal)
      from public.dataset_profiles dp
      where dp.dataset_id = d.id
    ), '[]'::jsonb)
  )
  from public.datasets d
  where d.slug = requested_slug
    and d.activated_at is not null;
$$;

create or replace function public.is_allowed_drive_source(requested_file_id text, requested_folder_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.dataset_profiles dp
    join public.datasets d on d.id = dp.dataset_id
    where d.activated_at is not null
      and (
        (requested_file_id is not null and requested_file_id <> '' and dp.drive_file_id = requested_file_id)
        or (requested_folder_id is not null and requested_folder_id <> '' and dp.drive_folder_id = requested_folder_id)
      )
  );
$$;

create or replace function public.save_dataset_import(import_id uuid, actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.dataset_imports%rowtype;
  new_dataset public.datasets%rowtype;
begin
  select * into draft
  from public.dataset_imports
  where id = import_id
    and created_by = actor_id
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Import preview was not found or has expired.';
  end if;

  if exists (select 1 from public.datasets where slug = draft.slug) then
    raise exception 'A dataset with slug % already exists.', draft.slug;
  end if;

  insert into public.datasets (
    slug, name, term, year, status, profile_count, health, safe_issues, created_by
  ) values (
    draft.slug, draft.name, draft.term, draft.year, 'ready',
    draft.profile_count, draft.health, draft.safe_issues, actor_id
  ) returning * into new_dataset;

  insert into public.dataset_profiles (
    dataset_id, profile_id, ordinal, public_data, drive_file_id, drive_folder_id,
    image_kind, image_issue
  )
  select
    new_dataset.id,
    item.value->'public'->>'id',
    item.ordinality - 1,
    item.value->'public',
    nullif(item.value->>'driveFileId', ''),
    nullif(item.value->>'driveFolderId', ''),
    nullif(item.value->>'imageKind', ''),
    nullif(item.value->>'imageIssue', '')
  from jsonb_array_elements(draft.normalized_profiles) with ordinality as item(value, ordinality);

  delete from public.dataset_imports where id = import_id;

  return jsonb_build_object(
    'id', new_dataset.id,
    'slug', new_dataset.slug,
    'name', new_dataset.name,
    'status', new_dataset.status,
    'profileCount', new_dataset.profile_count
  );
end;
$$;

create or replace function public.activate_dataset(dataset_id_to_activate uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
begin
  select * into target
  from public.datasets
  where id = dataset_id_to_activate
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;

  update public.datasets
  set status = 'archived', archived_at = coalesce(archived_at, now())
  where status = 'active' and id <> dataset_id_to_activate;

  update public.datasets
  set status = 'active', activated_at = coalesce(activated_at, now()), archived_at = null
  where id = dataset_id_to_activate
  returning * into target;

  insert into public.app_settings (singleton, active_dataset_id, updated_at)
  values (true, dataset_id_to_activate, now())
  on conflict (singleton) do update
    set active_dataset_id = excluded.active_dataset_id,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profileCount', target.profile_count
  );
end;
$$;

revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.is_allowed_drive_source(text, text) from public;
revoke all on function public.save_dataset_import(uuid, uuid) from public;
revoke all on function public.activate_dataset(uuid) from public;

grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.is_allowed_drive_source(text, text) to anon, authenticated;
grant execute on function public.save_dataset_import(uuid, uuid) to service_role;
grant execute on function public.activate_dataset(uuid) to service_role;
