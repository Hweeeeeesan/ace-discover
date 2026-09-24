-- Reversible profile-level public visibility for Admin moderation.
-- Hidden profiles remain fully preserved and visible to Admin readers.

begin;

alter table public.dataset_profiles
  add column if not exists public_hidden boolean not null default false;

create index if not exists dataset_profiles_public_visibility_idx
  on public.dataset_profiles (dataset_id, public_hidden, ordinal);

create or replace function public.set_profile_public_visibility(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_hidden boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_profile public.dataset_profiles%rowtype;
begin
  if requested_dataset_id is null
    or requested_profile_id is null
    or requested_profile_id = '' then
    raise exception 'Dataset and profile IDs are required.';
  end if;

  update public.dataset_profiles
  set public_hidden = requested_hidden
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  returning * into updated_profile;

  if not found then
    raise exception 'Profile does not belong to the requested dataset.';
  end if;

  return jsonb_build_object(
    'datasetId', updated_profile.dataset_id,
    'profileId', updated_profile.profile_id,
    'publicHidden', updated_profile.public_hidden
  );
end;
$$;

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
      'status', d.status,
      'profile_count', (
        select count(*)::integer
        from public.dataset_profiles visible_dp
        where visible_dp.dataset_id = d.id
          and not visible_dp.public_hidden
      ),
      'created_at', d.created_at, 'imported_at', d.imported_at, 'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(
        public.resolve_public_profile_image_state(
          dp.dataset_id,
          dp.profile_id,
          dp.public_data,
          dp.public_overrides,
          dp.storage_image_path,
          dp.image_cleared_by_admin,
          false
        ) - 'instagram'
        order by dp.ordinal
      )
      from public.dataset_profiles dp
      where dp.dataset_id = d.id
        and not dp.public_hidden
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
  select public.get_active_dataset()
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  where s.singleton and d.status = 'active' and d.slug = requested_slug;
$$;

create or replace function public.get_published_profile(
  requested_slug text,
  requested_profile_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id, 'slug', d.slug, 'name', d.name, 'term', d.term, 'year', d.year,
      'status', d.status,
      'profile_count', (
        select count(*)::integer
        from public.dataset_profiles visible_dp
        where visible_dp.dataset_id = d.id
          and not visible_dp.public_hidden
      ),
      'created_at', d.created_at, 'imported_at', d.imported_at, 'activated_at', d.activated_at
    ),
    'profile', public.resolve_public_profile_image_state(
      dp.dataset_id,
      dp.profile_id,
      dp.public_data,
      dp.public_overrides,
      dp.storage_image_path,
      dp.image_cleared_by_admin,
      true
    )
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  join public.dataset_profiles dp on dp.dataset_id = d.id
  where s.singleton
    and d.status = 'active'
    and d.slug = requested_slug
    and dp.profile_id = requested_profile_id
    and not dp.public_hidden;
$$;

create or replace function public.is_allowed_drive_source(
  requested_file_id text,
  requested_folder_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_settings s
    join public.datasets d on d.id = s.active_dataset_id
    join public.dataset_profiles dp on dp.dataset_id = d.id
    where s.singleton
      and d.status = 'active'
      and not dp.public_hidden
      and (
        (requested_file_id is not null and requested_file_id <> '' and dp.drive_file_id = requested_file_id)
        or (requested_folder_id is not null and requested_folder_id <> '' and dp.drive_folder_id = requested_folder_id)
      )
  );
$$;

revoke all on function public.set_profile_public_visibility(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.set_profile_public_visibility(uuid, text, boolean) to service_role;

revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.get_published_profile(text, text) from public;
grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.get_published_profile(text, text) to anon, authenticated;

commit;
