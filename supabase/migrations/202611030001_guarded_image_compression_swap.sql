-- Unapplied until a separately approved production pilot.
-- A local service-role operator may swap canonical paths while preserving every
-- gallery row and non-path column. The same guarded function handles rollback.
begin;

create function public.swap_profile_image_compression_assets(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  expected_row jsonb,
  replacement_paths jsonb,
  requested_rollback boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_image public.profile_images;
  updated_image public.profile_images;
  current_fallback text;
  dataset_slug text;
  required_keys text[] := array[
    'id', 'dataset_id', 'profile_id',
    'storage_path', 'profile_storage_path', 'discovery_storage_path',
    'profile_width', 'profile_height', 'profile_mime_type', 'profile_byte_length',
    'discovery_width', 'discovery_height', 'discovery_mime_type', 'discovery_byte_length',
    'updated_at', 'position', 'is_primary', 'focal_x', 'focal_y',
    'display_mode', 'source_type', 'source_drive_file_id',
    'source_drive_folder_id', 'source_filename', 'source_modified_time',
    'source_size'
  ];
  field_name text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required.';
  end if;
  if expected_row is null or replacement_paths is null
    or jsonb_typeof(expected_row) <> 'object'
    or jsonb_typeof(replacement_paths) <> 'object'
    or not (expected_row ?& required_keys)
    or not (replacement_paths ?& array['canonical', 'profile', 'discovery']) then
    raise exception 'A complete expected row and replacement path set are required.';
  end if;
  select slug into dataset_slug from public.datasets where id = requested_dataset_id;
  if not found then raise exception 'Dataset not found.'; end if;

  select * into previous_image from public.profile_images
  where id = requested_image_id and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Image row was deleted or replaced.'; end if;
  if previous_image.id is distinct from (expected_row->>'id')::uuid
    or previous_image.dataset_id is distinct from (expected_row->>'dataset_id')::uuid
    or previous_image.profile_id is distinct from expected_row->>'profile_id'
    or previous_image.storage_path is distinct from expected_row->>'storage_path'
    or previous_image.profile_storage_path is distinct from expected_row->>'profile_storage_path'
    or previous_image.discovery_storage_path is distinct from expected_row->>'discovery_storage_path'
    or previous_image.updated_at is distinct from (expected_row->>'updated_at')::timestamptz then
    raise exception 'Image changed after planning.';
  end if;
  if previous_image.source_modified_time is distinct from (expected_row->>'source_modified_time')::timestamptz then
    raise exception 'Image source timestamp changed after planning.';
  end if;
  foreach field_name in array array['position', 'is_primary', 'focal_x', 'focal_y',
    'display_mode', 'source_type', 'source_drive_file_id',
    'source_drive_folder_id', 'source_filename', 'source_size',
    'profile_width', 'profile_height', 'profile_mime_type', 'profile_byte_length',
    'discovery_width', 'discovery_height', 'discovery_mime_type', 'discovery_byte_length'] loop
    if to_jsonb(previous_image)->field_name is distinct from expected_row->field_name then
      raise exception 'Image metadata changed after planning: %', field_name;
    end if;
  end loop;
  if replacement_paths->>'canonical' is null
    or replacement_paths->>'canonical' = previous_image.storage_path
    or split_part(replacement_paths->>'canonical', '/', 1) <> dataset_slug
    or split_part(replacement_paths->>'canonical', '/', 2) <> requested_profile_id
    or (not requested_rollback and split_part(replacement_paths->>'canonical', '/', 3) !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|webp)$')
    or split_part(replacement_paths->>'canonical', '/', 4) <> '' then
    raise exception 'Replacement canonical path is invalid or not immutable.';
  end if;
  if (previous_image.profile_storage_path is null) <> (replacement_paths->>'profile' is null)
    or (previous_image.discovery_storage_path is null) <> (replacement_paths->>'discovery' is null) then
    raise exception 'Derivative shape cannot change.';
  end if;

  if previous_image.is_primary then
    select storage_image_path into current_fallback from public.dataset_profiles
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id
    for update;
    if not found or current_fallback is distinct from previous_image.storage_path then
      raise exception 'Primary fallback changed or is stale; repair it separately.';
    end if;
  end if;

  -- Existing triggers enforce owner, canonical extension, derivative UUID
  -- identity, one primary, and valid primary fallback format.
  update public.profile_images
  set storage_path = replacement_paths->>'canonical',
      profile_storage_path = replacement_paths->>'profile',
      discovery_storage_path = replacement_paths->>'discovery'
  where id = requested_image_id and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  returning * into updated_image;

  if previous_image.is_primary then
    update public.dataset_profiles
    set storage_image_path = updated_image.storage_path
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id
      and storage_image_path = previous_image.storage_path;
    if not found then raise exception 'Primary fallback changed during swap.'; end if;
  end if;

  return jsonb_build_object(
    'id', updated_image.id,
    'datasetId', updated_image.dataset_id,
    'profileId', updated_image.profile_id,
    'oldPaths', jsonb_build_object('canonical', previous_image.storage_path,
      'profile', previous_image.profile_storage_path,
      'discovery', previous_image.discovery_storage_path),
    'newPaths', jsonb_build_object('canonical', updated_image.storage_path,
      'profile', updated_image.profile_storage_path,
      'discovery', updated_image.discovery_storage_path),
    'updatedAt', updated_image.updated_at,
    'position', updated_image.position,
    'isPrimary', updated_image.is_primary,
    'focalX', updated_image.focal_x,
    'focalY', updated_image.focal_y,
    'displayMode', updated_image.display_mode
  );
end;
$$;

revoke all on function public.swap_profile_image_compression_assets(uuid, text, uuid, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.swap_profile_image_compression_assets(uuid, text, uuid, jsonb, jsonb, boolean)
  to service_role;
commit;
