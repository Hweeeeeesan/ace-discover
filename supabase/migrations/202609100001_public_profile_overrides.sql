-- Safe Admin/Owner public-profile overrides. Apply after the existing dataset
-- and Google Sheet sync migrations. This migration is intentionally not applied
-- by the application.

begin;

alter table public.dataset_profiles
  add column if not exists public_overrides jsonb not null default '{}'::jsonb,
  add column if not exists public_overrides_updated_at timestamptz,
  add column if not exists public_overrides_updated_by uuid references auth.users(id) on delete set null;

alter table public.dataset_profiles
  drop constraint if exists dataset_profiles_public_overrides_object_check,
  add constraint dataset_profiles_public_overrides_object_check check (jsonb_typeof(public_overrides) = 'object');

create or replace function public.resolve_effective_public_data(imported_data jsonb, overrides jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(imported_data, '{}'::jsonb) || coalesce(overrides, '{}'::jsonb);
$$;

revoke all on function public.resolve_effective_public_data(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_effective_public_data(jsonb, jsonb) to service_role;

create or replace function public.update_profile_public_overrides(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_overrides jsonb,
  expected_updated_at timestamptz,
  actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.dataset_profiles%rowtype;
  invalid_key text;
begin
  if jsonb_typeof(requested_overrides) <> 'object' then
    raise exception 'Public overrides must be an object.';
  end if;
  select key into invalid_key
  from jsonb_object_keys(requested_overrides) as key
  where key not in (
    'name', 'pronouns', 'year', 'major', 'instagram', 'hobbies', 'hobbyDetails',
    'music', 'movies', 'uniqueThings', 'tagline', 'passion', 'perfectDay',
    'idealHangout', 'bucketList', 'hotTake', 'bio', 'vibes'
  )
  limit 1;
  if invalid_key is not null then
    raise exception 'The field % cannot be overridden.', invalid_key;
  end if;
  if jsonb_typeof(requested_overrides->'vibes') = 'array'
     and jsonb_array_length(requested_overrides->'vibes') > 5 then
    raise exception 'Vibes must contain at most 5 items.';
  end if;

  select * into target
  from public.dataset_profiles
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then
    raise exception 'Profile not found in the requested dataset.';
  end if;
  if target.public_overrides_updated_at is distinct from expected_updated_at then
    raise exception 'This profile was edited by someone else. Refresh and review the latest values.';
  end if;

  update public.dataset_profiles
  set public_overrides = requested_overrides,
      public_overrides_updated_at = case when requested_overrides = '{}'::jsonb then null else now() end,
      public_overrides_updated_by = case when requested_overrides = '{}'::jsonb then null else actor_id end
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  return jsonb_build_object(
    'profile', public.resolve_effective_public_data(target.public_data, requested_overrides),
    'publicOverrides', requested_overrides,
    'updatedAt', case when requested_overrides = '{}'::jsonb then null else now() end
  );
end;
$$;

revoke all on function public.update_profile_public_overrides(uuid, text, jsonb, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.update_profile_public_overrides(uuid, text, jsonb, timestamptz, uuid) to service_role;

create or replace function public.get_active_dataset()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id, 'slug', d.slug, 'name', d.name, 'term', d.term, 'year', d.year,
      'status', d.status, 'profile_count', d.profile_count, 'created_at', d.created_at,
      'imported_at', d.imported_at, 'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(public.resolve_effective_public_data(dp.public_data, dp.public_overrides) - 'instagram' order by dp.ordinal)
      from public.dataset_profiles dp where dp.dataset_id = d.id
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
      'id', d.id, 'slug', d.slug, 'name', d.name, 'term', d.term, 'year', d.year,
      'status', d.status, 'profile_count', d.profile_count, 'created_at', d.created_at,
      'imported_at', d.imported_at, 'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(public.resolve_effective_public_data(dp.public_data, dp.public_overrides) - 'instagram' order by dp.ordinal)
      from public.dataset_profiles dp where dp.dataset_id = d.id
    ), '[]'::jsonb)
  )
  from public.datasets d
  where d.slug = requested_slug and d.activated_at is not null;
$$;

create or replace function public.get_published_profile(requested_slug text, requested_profile_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id, 'slug', d.slug, 'name', d.name, 'term', d.term, 'year', d.year,
      'status', d.status, 'profile_count', d.profile_count, 'created_at', d.created_at,
      'imported_at', d.imported_at, 'activated_at', d.activated_at
    ),
    'profile', public.resolve_effective_public_data(dp.public_data, dp.public_overrides)
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  join public.dataset_profiles dp on dp.dataset_id = d.id
  where s.singleton and d.status = 'active' and d.slug = requested_slug
    and dp.profile_id = requested_profile_id;
$$;

commit;
