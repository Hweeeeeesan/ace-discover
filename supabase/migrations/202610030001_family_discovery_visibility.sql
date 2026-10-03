-- Dataset-scoped public Discovery inclusion for Family profiles.
-- Existing datasets retain their current public behavior; newly created
-- datasets default to Family excluded from Discovery.

begin;

alter table public.datasets
  add column if not exists show_family_in_discovery boolean not null default true;

alter table public.datasets
  alter column show_family_in_discovery set default false;

create or replace function public.set_dataset_family_discovery_visibility(
  requested_dataset_id uuid,
  requested_show boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_dataset public.datasets%rowtype;
begin
  if requested_dataset_id is null or requested_show is null then
    raise exception 'Dataset ID and Family Discovery setting are required.';
  end if;

  update public.datasets
  set show_family_in_discovery = requested_show
  where id = requested_dataset_id
  returning * into updated_dataset;

  if not found then
    raise exception 'Dataset was not found.';
  end if;

  return jsonb_build_object(
    'id', updated_dataset.id,
    'slug', updated_dataset.slug,
    'showFamilyInDiscovery', updated_dataset.show_family_in_discovery
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
      'show_family_in_discovery', d.show_family_in_discovery,
      'profile_count', (
        select count(*)::integer
        from public.dataset_profiles visible_dp
        where visible_dp.dataset_id = d.id
          and not visible_dp.public_hidden
          and (d.show_family_in_discovery or coalesce(visible_dp.public_data->>'role', '') <> 'Family')
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
        and (d.show_family_in_discovery or coalesce(dp.public_data->>'role', '') <> 'Family')
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
      'show_family_in_discovery', d.show_family_in_discovery,
      'profile_count', (
        select count(*)::integer
        from public.dataset_profiles visible_dp
        where visible_dp.dataset_id = d.id
          and not visible_dp.public_hidden
          and (d.show_family_in_discovery or coalesce(visible_dp.public_data->>'role', '') <> 'Family')
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

revoke all on function public.set_dataset_family_discovery_visibility(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_dataset_family_discovery_visibility(uuid, boolean) to service_role;

revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.get_published_profile(text, text) from public;
grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.get_published_profile(text, text) to anon, authenticated;

commit;
