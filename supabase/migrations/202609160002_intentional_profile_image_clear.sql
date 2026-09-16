-- Persist an explicit Admin decision to show no profile image. Natural profiles
-- with no relational gallery retain the existing compatibility fallback path.

begin;

alter table public.dataset_profiles
  add column if not exists image_cleared_by_admin boolean not null default false;

create or replace function public.sync_profile_storage_image_path()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  public_path text;
begin
  if new.image_cleared_by_admin then
    new.storage_image_path := null;
    new.public_data := coalesce(new.public_data, '{}'::jsonb) - 'storageImagePath';
    return new;
  end if;

  public_path := nullif(new.public_data->>'storageImagePath', '');
  if new.storage_image_path is null and public_path is not null then
    new.storage_image_path := public_path;
  elsif new.storage_image_path is not null and public_path is distinct from new.storage_image_path then
    new.public_data := jsonb_set(
      coalesce(new.public_data, '{}'::jsonb),
      '{storageImagePath}',
      to_jsonb(new.storage_image_path),
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists dataset_profiles_sync_storage_image_path on public.dataset_profiles;
create trigger dataset_profiles_sync_storage_image_path
before insert or update of public_data, storage_image_path, image_cleared_by_admin
on public.dataset_profiles
for each row execute function public.sync_profile_storage_image_path();

create or replace function public.clear_intentional_profile_image_state_on_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.dataset_profiles
  set image_cleared_by_admin = false
  where dataset_id = new.dataset_id
    and profile_id = new.profile_id
    and image_cleared_by_admin;
  return new;
end;
$$;

drop trigger if exists profile_images_clear_intentional_state on public.profile_images;
create trigger profile_images_clear_intentional_state
after insert on public.profile_images
for each row execute function public.clear_intentional_profile_image_state_on_insert();

create or replace function public.delete_profile_image(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.profile_images;
  next_primary public.profile_images;
  remaining_count integer;
  intentionally_cleared boolean := false;
begin
  perform 1
  from public.dataset_profiles
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile does not belong to the requested dataset.'; end if;

  select * into target from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;

  delete from public.profile_images where id = requested_image_id;

  select count(*) into remaining_count
  from public.profile_images
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id;

  if remaining_count = 0 then
    update public.dataset_profiles
    set storage_image_path = null,
        public_data = coalesce(public_data, '{}'::jsonb) - array[
          'storageImagePath', 'profileImages', 'image', 'imageCandidates',
          'imageSourceUrl', 'storagePath', 'resolvedDriveFileId',
          'focalX', 'focalY', 'displayMode'
        ]::text[],
        image_cleared_by_admin = true
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id;
    intentionally_cleared := true;
  elsif target.is_primary then
    select * into next_primary
    from public.profile_images
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id
    order by position, id
    limit 1
    for update;

    update public.profile_images
    set is_primary = true
    where id = next_primary.id;

    update public.dataset_profiles
    set storage_image_path = next_primary.storage_path,
        public_data = jsonb_set(
          coalesce(public_data, '{}'::jsonb),
          '{storageImagePath}',
          to_jsonb(next_primary.storage_path),
          true
        ),
        image_cleared_by_admin = false
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id;
  end if;

  return jsonb_build_object(
    'id', target.id,
    'storagePath', target.storage_path,
    'wasPrimary', target.is_primary,
    'remainingCount', remaining_count,
    'intentionallyCleared', intentionally_cleared
  );
end;
$$;

create or replace function public.create_profile_image_gallery_if_empty(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_images jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_status text;
  existing_storage_path text;
  intentionally_cleared boolean;
  requested_count integer;
  inserted_count integer;
  primary_storage_path text;
begin
  select d.status, dp.storage_image_path, dp.image_cleared_by_admin
  into dataset_status, existing_storage_path, intentionally_cleared
  from public.dataset_profiles dp
  join public.datasets d on d.id = dp.dataset_id
  where dp.dataset_id = requested_dataset_id
    and dp.profile_id = requested_profile_id
  for update of dp;

  if not found then
    raise exception 'Profile does not belong to the requested dataset.';
  end if;
  if dataset_status not in ('active', 'ready') then
    raise exception 'Archived datasets must be restored before importing profile images.';
  end if;
  if intentionally_cleared then
    return jsonb_build_object('created', false, 'reason', 'intentionally_cleared', 'imageCount', 0);
  end if;
  if existing_storage_path is not null or exists (
    select 1 from public.profile_images
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  ) then
    return jsonb_build_object('created', false, 'reason', 'gallery_exists', 'imageCount', 0);
  end if;
  if jsonb_typeof(requested_images) <> 'array' then
    raise exception 'Requested images must be an array.';
  end if;

  requested_count := jsonb_array_length(requested_images);
  if requested_count < 1 or requested_count > 1000 then
    raise exception 'A gallery must contain between 1 and 1000 images.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(requested_images) as image(
      "imageId" uuid,
      "storagePath" text,
      position integer
    )
    where image."imageId" is null
      or image."storagePath" is null
      or image.position is null
      or image.position < 0
  ) then
    raise exception 'Requested image metadata is invalid.';
  end if;
  if (
    select count(distinct image."imageId") = requested_count
      and count(distinct image."storagePath") = requested_count
      and count(distinct image.position) = requested_count
      and min(image.position) = 0
      and max(image.position) = requested_count - 1
    from jsonb_to_recordset(requested_images) as image(
      "imageId" uuid,
      "storagePath" text,
      position integer
    )
  ) is not true then
    raise exception 'Requested images must have unique IDs, paths, and contiguous positions.';
  end if;

  insert into public.profile_images (
    id, dataset_id, profile_id, storage_path, position, is_primary
  )
  select
    image."imageId",
    requested_dataset_id,
    requested_profile_id,
    image."storagePath",
    image.position,
    image.position = 0
  from jsonb_to_recordset(requested_images) as image(
    "imageId" uuid,
    "storagePath" text,
    position integer
  )
  order by image.position;
  get diagnostics inserted_count = row_count;

  select image."storagePath"
  into primary_storage_path
  from jsonb_to_recordset(requested_images) as image(
    "imageId" uuid,
    "storagePath" text,
    position integer
  )
  where image.position = 0;

  update public.dataset_profiles
  set storage_image_path = primary_storage_path
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  return jsonb_build_object(
    'created', true,
    'imageCount', inserted_count,
    'primaryStoragePath', primary_storage_path
  );
end;
$$;

create or replace function public.replace_profile_image_gallery(
  requested_dataset_id uuid,
  requested_profile_id text,
  expected_existing_image_ids uuid[],
  replacement_images jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_image_ids uuid[];
  old_storage_paths text[];
  was_intentionally_cleared boolean;
  replacement_count integer;
  distinct_ids integer;
  distinct_paths integer;
  distinct_positions integer;
  primary_count integer;
  minimum_position integer;
  maximum_position integer;
  primary_storage_path text;
begin
  lock table public.profile_images in share row exclusive mode;

  select image_cleared_by_admin into was_intentionally_cleared
  from public.dataset_profiles
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;
  if not found then
    raise exception 'Profile does not belong to the requested dataset.';
  end if;

  perform 1 from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;

  select
    coalesce(array_agg(id order by position, id), '{}'::uuid[]),
    coalesce(array_agg(storage_path order by position, id), '{}'::text[])
  into existing_image_ids, old_storage_paths
  from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  if cardinality(existing_image_ids) = 0 and not was_intentionally_cleared then
    raise exception 'Targeted replacement requires an existing relational gallery or an intentionally cleared profile.';
  end if;
  if existing_image_ids is distinct from expected_existing_image_ids then
    raise exception 'The gallery changed after it was inspected; replacement was cancelled.';
  end if;
  if jsonb_typeof(replacement_images) is distinct from 'array' then
    raise exception 'Replacement images must be a JSON array.';
  end if;

  replacement_count := jsonb_array_length(replacement_images);
  if replacement_count < 1 or replacement_count > 1000 then
    raise exception 'Replacement gallery must contain between 1 and 1000 images.';
  end if;

  select
    count(distinct replacement."imageId"),
    count(distinct replacement."storagePath"),
    count(distinct replacement.position),
    count(*) filter (where replacement."isPrimary"),
    min(replacement.position),
    max(replacement.position)
  into distinct_ids, distinct_paths, distinct_positions, primary_count, minimum_position, maximum_position
  from jsonb_to_recordset(replacement_images) as replacement(
    "imageId" uuid,
    "storagePath" text,
    position integer,
    "isPrimary" boolean,
    "focalX" numeric,
    "focalY" numeric,
    "displayMode" text
  );

  if distinct_ids <> replacement_count
    or distinct_paths <> replacement_count
    or distinct_positions <> replacement_count
    or minimum_position <> 0
    or maximum_position <> replacement_count - 1
    or primary_count <> 1 then
    raise exception 'Replacement images must have unique IDs, paths, contiguous positions, and exactly one primary.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(replacement_images) as replacement(
      "imageId" uuid,
      "storagePath" text,
      position integer,
      "isPrimary" boolean,
      "focalX" numeric,
      "focalY" numeric,
      "displayMode" text
    )
    where replacement."imageId" is null
      or replacement."storagePath" is null
      or replacement.position is null
      or replacement."isPrimary" is null
      or replacement."displayMode" is null
      or replacement."displayMode" not in ('cover', 'portrait')
      or (replacement."focalX" is not null and replacement."focalX" not between 0 and 100)
      or (replacement."focalY" is not null and replacement."focalY" not between 0 and 100)
  ) then
    raise exception 'Replacement image metadata is invalid.';
  end if;

  delete from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  insert into public.profile_images (
    id, dataset_id, profile_id, storage_path, position, is_primary,
    focal_x, focal_y, display_mode
  )
  select
    replacement."imageId",
    requested_dataset_id,
    requested_profile_id,
    replacement."storagePath",
    replacement.position,
    replacement."isPrimary",
    replacement."focalX",
    replacement."focalY",
    replacement."displayMode"
  from jsonb_to_recordset(replacement_images) as replacement(
    "imageId" uuid,
    "storagePath" text,
    position integer,
    "isPrimary" boolean,
    "focalX" numeric,
    "focalY" numeric,
    "displayMode" text
  );

  select replacement."storagePath"
  into primary_storage_path
  from jsonb_to_recordset(replacement_images) as replacement(
    "imageId" uuid,
    "storagePath" text,
    position integer,
    "isPrimary" boolean,
    "focalX" numeric,
    "focalY" numeric,
    "displayMode" text
  )
  where replacement."isPrimary";

  update public.dataset_profiles
  set storage_image_path = primary_storage_path,
      image_cleared_by_admin = false
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  return jsonb_build_object(
    'profileId', requested_profile_id,
    'replacementCount', replacement_count,
    'primaryStoragePath', primary_storage_path,
    'oldStoragePaths', to_jsonb(old_storage_paths),
    'restoredIntentionallyClearedProfile', was_intentionally_cleared
  );
end;
$$;

create or replace function public.strip_public_profile_image_data(payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(payload, '{}'::jsonb) - array[
    'storageImagePath', 'profileImages', 'image', 'imageCandidates',
    'imageSourceUrl', 'storagePath', 'driveFileId', 'driveFolderId',
    'resolvedDriveFileId', 'imageKind', 'imageIssue',
    'focalX', 'focalY', 'displayMode'
  ]::text[];
$$;

create or replace function public.resolve_public_profile_image_state(
  requested_dataset_id uuid,
  requested_profile_id text,
  imported_public_data jsonb,
  public_overrides jsonb,
  legacy_storage_image_path text,
  intentionally_cleared boolean,
  include_gallery boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  resolved jsonb;
  primary_storage_path text;
  primary_focal_x numeric;
  primary_focal_y numeric;
  primary_display_mode text;
  effective_storage_path text;
  gallery jsonb;
begin
  resolved := public.resolve_effective_public_data(imported_public_data, public_overrides)
    - array['imageClearedByAdmin', 'image_cleared_by_admin']::text[];

  if intentionally_cleared then
    resolved := public.strip_public_profile_image_data(resolved);
  else
    select pi.storage_path, pi.focal_x, pi.focal_y, pi.display_mode
    into primary_storage_path, primary_focal_x, primary_focal_y, primary_display_mode
    from public.profile_images pi
    where pi.dataset_id = requested_dataset_id
      and pi.profile_id = requested_profile_id
      and pi.is_primary
    limit 1;

    effective_storage_path := coalesce(primary_storage_path, legacy_storage_image_path);
    if effective_storage_path is not null then
      resolved := jsonb_set(resolved, '{storageImagePath}', to_jsonb(effective_storage_path), true);
      resolved := jsonb_set(resolved, '{focalX}', to_jsonb(coalesce(primary_focal_x, 50)), true);
      resolved := jsonb_set(resolved, '{focalY}', to_jsonb(coalesce(primary_focal_y, 35)), true);
      resolved := jsonb_set(resolved, '{displayMode}', to_jsonb(coalesce(primary_display_mode, 'cover')), true);
    end if;
  end if;

  if include_gallery then
    if intentionally_cleared then
      gallery := '[]'::jsonb;
    else
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', pi.id,
          'storageImagePath', pi.storage_path,
          'position', pi.position,
          'isPrimary', pi.is_primary,
          'focalX', pi.focal_x,
          'focalY', pi.focal_y,
          'displayMode', pi.display_mode
        ) order by pi.position, pi.id
      ), '[]'::jsonb)
      into gallery
      from public.profile_images pi
      where pi.dataset_id = requested_dataset_id
        and pi.profile_id = requested_profile_id;
    end if;
    resolved := resolved || jsonb_build_object('profileImages', gallery);
  end if;

  return resolved;
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
      'status', d.status, 'profile_count', d.profile_count, 'created_at', d.created_at,
      'imported_at', d.imported_at, 'activated_at', d.activated_at
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
  where s.singleton and d.status = 'active' and d.slug = requested_slug
    and dp.profile_id = requested_profile_id;
$$;

revoke all on function public.clear_intentional_profile_image_state_on_insert() from public, anon, authenticated;
revoke all on function public.delete_profile_image(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.create_profile_image_gallery_if_empty(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.replace_profile_image_gallery(uuid, text, uuid[], jsonb) from public, anon, authenticated;
revoke all on function public.strip_public_profile_image_data(jsonb) from public, anon, authenticated;
revoke all on function public.resolve_public_profile_image_state(uuid, text, jsonb, jsonb, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.get_published_profile(text, text) from public;

grant execute on function public.delete_profile_image(uuid, text, uuid) to service_role;
grant execute on function public.create_profile_image_gallery_if_empty(uuid, text, jsonb) to service_role;
grant execute on function public.replace_profile_image_gallery(uuid, text, uuid[], jsonb) to service_role;
grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.get_published_profile(text, text) to anon, authenticated;

commit;
