-- Preserve relational primary-image presentation metadata in public payloads
-- after public-profile overrides are applied.
-- Apply after 202609100001_public_profile_overrides.sql.

begin;

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
      select jsonb_agg(
        case
          when coalesce(primary_image.storage_path, dp.storage_image_path) is null
            then public.resolve_effective_public_data(dp.public_data, dp.public_overrides) - 'instagram'
          else jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  public.resolve_effective_public_data(dp.public_data, dp.public_overrides) - 'instagram',
                  '{storageImagePath}',
                  to_jsonb(coalesce(primary_image.storage_path, dp.storage_image_path)),
                  true
                ),
                '{focalX}',
                to_jsonb(coalesce(primary_image.focal_x, 50)),
                true
              ),
              '{focalY}',
              to_jsonb(coalesce(primary_image.focal_y, 35)),
              true
            ),
            '{displayMode}',
            to_jsonb(coalesce(primary_image.display_mode, 'cover')),
            true
          )
        end
        order by dp.ordinal
      )
      from public.dataset_profiles dp
      left join lateral (
        select pi.storage_path, pi.focal_x, pi.focal_y, pi.display_mode
        from public.profile_images pi
        where pi.dataset_id = dp.dataset_id
          and pi.profile_id = dp.profile_id
          and pi.is_primary
        limit 1
      ) primary_image on true
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
  select public.get_active_dataset()
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  where s.singleton and d.status = 'active' and d.slug = requested_slug;
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
    'profile', (
      case
        when coalesce(primary_image.storage_path, dp.storage_image_path) is null
          then public.resolve_effective_public_data(dp.public_data, dp.public_overrides)
        else jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                public.resolve_effective_public_data(dp.public_data, dp.public_overrides),
                '{storageImagePath}',
                to_jsonb(coalesce(primary_image.storage_path, dp.storage_image_path)),
                true
              ),
              '{focalX}',
              to_jsonb(coalesce(primary_image.focal_x, 50)),
              true
            ),
            '{focalY}',
            to_jsonb(coalesce(primary_image.focal_y, 35)),
            true
          ),
          '{displayMode}',
          to_jsonb(coalesce(primary_image.display_mode, 'cover')),
          true
        )
      end
    ) || jsonb_build_object(
      'profileImages', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pi.id,
            'storageImagePath', pi.storage_path,
            'position', pi.position,
            'isPrimary', pi.is_primary,
            'focalX', pi.focal_x,
            'focalY', pi.focal_y,
            'displayMode', pi.display_mode
          ) order by pi.position, pi.id
        )
        from public.profile_images pi
        where pi.dataset_id = dp.dataset_id and pi.profile_id = dp.profile_id
      ), '[]'::jsonb)
    )
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  join public.dataset_profiles dp on dp.dataset_id = d.id
  left join lateral (
    select pi.storage_path, pi.focal_x, pi.focal_y, pi.display_mode
    from public.profile_images pi
    where pi.dataset_id = dp.dataset_id
      and pi.profile_id = dp.profile_id
      and pi.is_primary
    limit 1
  ) primary_image on true
  where s.singleton and d.status = 'active' and d.slug = requested_slug
    and dp.profile_id = requested_profile_id;
$$;

revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.get_published_profile(text, text) from public;
grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.get_published_profile(text, text) to anon, authenticated;

commit;
