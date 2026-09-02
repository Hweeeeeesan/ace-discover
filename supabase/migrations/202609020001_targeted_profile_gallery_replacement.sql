-- Transactional, single-profile gallery replacement for explicit Drive repair.
-- Storage uploads happen before this RPC and old objects are removed only after
-- it commits, so a failure never leaves the profile without image metadata.

begin;

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
  replacement_count integer;
  distinct_ids integer;
  distinct_paths integer;
  distinct_positions integer;
  primary_count integer;
  minimum_position integer;
  maximum_position integer;
  primary_storage_path text;
begin
  -- Prevent a concurrent Admin insert/delete/reorder from changing the gallery
  -- between the expected-ID check and the atomic delete/insert swap.
  lock table public.profile_images in share row exclusive mode;

  perform 1 from public.dataset_profiles
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

  if cardinality(existing_image_ids) = 0 then
    raise exception 'Targeted replacement requires an existing relational gallery.';
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
  set storage_image_path = primary_storage_path
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  return jsonb_build_object(
    'profileId', requested_profile_id,
    'replacementCount', replacement_count,
    'primaryStoragePath', primary_storage_path,
    'oldStoragePaths', to_jsonb(old_storage_paths)
  );
end;
$$;

revoke all on function public.replace_profile_image_gallery(uuid, text, uuid[], jsonb)
from public, anon, authenticated;
grant execute on function public.replace_profile_image_gallery(uuid, text, uuid[], jsonb)
to service_role;

commit;
