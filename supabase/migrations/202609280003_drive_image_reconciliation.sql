-- Durable source identity and append-only Google Drive reconciliation.
--
-- This migration is intentionally schema/function only.  Historical rows are
-- classified in 202609280004_drive_image_reconciliation_backfill.sql, after
-- this transaction commits.  Keeping the backfill out of this transaction is
-- required because profile_images has a deferred primary-image constraint
-- trigger; PostgreSQL does not allow ALTER TABLE while its trigger events are
-- pending.

begin;

alter table public.profile_images
  add column if not exists source_type text,
  add column if not exists source_drive_file_id text,
  add column if not exists source_drive_folder_id text,
  add column if not exists source_filename text,
  add column if not exists source_modified_time timestamptz,
  add column if not exists source_size bigint;

alter table public.profile_images
  alter column source_type set default 'admin_upload',
  add constraint profile_images_source_type_valid check (
    source_type is null
    or source_type in ('google_drive', 'admin_upload', 'legacy_unknown', 'legacy_preserved')
  ),
  add constraint profile_images_drive_identity_complete check (
    source_type is null
    or (source_type = 'google_drive' and source_drive_file_id is not null)
    or (source_type <> 'google_drive' and source_drive_file_id is null and source_drive_folder_id is null)
  ),
  add constraint profile_images_drive_file_id_valid check (
    source_drive_file_id is null or source_drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'
  ),
  add constraint profile_images_drive_folder_id_valid check (
    source_drive_folder_id is null or source_drive_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'
  ),
  add constraint profile_images_source_size_valid check (
    source_size is null or source_size >= 0
  );

create unique index if not exists profile_images_drive_source_identity_idx
  on public.profile_images (dataset_id, profile_id, source_drive_file_id)
  where source_drive_file_id is not null;

create index if not exists profile_images_source_review_idx
  on public.profile_images (dataset_id, profile_id, source_type);

create or replace function public.create_google_drive_profile_image_with_derivatives(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_storage_path text,
  requested_profile_storage_path text,
  requested_profile_width integer,
  requested_profile_height integer,
  requested_profile_mime_type text,
  requested_profile_byte_length bigint,
  requested_discovery_storage_path text,
  requested_discovery_width integer,
  requested_discovery_height integer,
  requested_discovery_mime_type text,
  requested_discovery_byte_length bigint,
  requested_drive_file_id text,
  requested_drive_folder_id text default null,
  requested_source_filename text default null,
  requested_source_modified_time timestamptz default null,
  requested_source_size bigint default null,
  requested_make_primary boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if requested_drive_file_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or (requested_drive_folder_id is not null and requested_drive_folder_id !~ '^[A-Za-z0-9_-]{10,200}$') then
    raise exception 'Invalid Google Drive source identity.';
  end if;

  result := public.create_profile_image_with_derivative(
    requested_dataset_id, requested_profile_id, requested_image_id, requested_storage_path,
    requested_profile_storage_path, requested_profile_width, requested_profile_height,
    requested_profile_mime_type, requested_profile_byte_length,
    requested_discovery_storage_path, requested_discovery_width, requested_discovery_height,
    requested_discovery_mime_type, requested_discovery_byte_length, requested_make_primary
  );

  update public.profile_images
  set source_type = 'google_drive',
      source_drive_file_id = requested_drive_file_id,
      source_drive_folder_id = requested_drive_folder_id,
      source_filename = nullif(requested_source_filename, ''),
      source_modified_time = requested_source_modified_time,
      source_size = requested_source_size
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id;

  return result || jsonb_build_object('sourceType', 'google_drive');
end;
$$;

create or replace function public.attach_profile_image_drive_provenance(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_drive_file_id text,
  requested_drive_folder_id text,
  requested_source_filename text default null,
  requested_source_modified_time timestamptz default null,
  requested_source_size bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.profile_images;
  profile_folder_id text;
begin
  select drive_folder_id into profile_folder_id
  from public.dataset_profiles
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile does not belong to the requested dataset.'; end if;
  if profile_folder_id is distinct from requested_drive_folder_id then
    raise exception 'Drive folder does not match the profile source.';
  end if;

  select * into target from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;
  if target.source_type <> 'legacy_unknown' then
    raise exception 'Only an unreviewed legacy image can receive reviewed provenance.';
  end if;

  update public.profile_images
  set source_type = 'google_drive',
      source_drive_file_id = requested_drive_file_id,
      source_drive_folder_id = requested_drive_folder_id,
      source_filename = nullif(requested_source_filename, ''),
      source_modified_time = requested_source_modified_time,
      source_size = requested_source_size
  where id = requested_image_id;

  return jsonb_build_object('id', requested_image_id, 'sourceType', 'google_drive');
end;
$$;

create or replace function public.mark_profile_image_legacy_preserved(
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
begin
  perform 1 from public.dataset_profiles
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile does not belong to the requested dataset.'; end if;

  select * into target from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;
  if target.source_type <> 'legacy_unknown' then
    raise exception 'Only an unreviewed legacy image can be marked as preserved.';
  end if;

  update public.profile_images
  set source_type = 'legacy_preserved',
      source_drive_file_id = null,
      source_drive_folder_id = null
  where id = requested_image_id;
  return jsonb_build_object('id', requested_image_id, 'sourceType', 'legacy_preserved');
end;
$$;

create or replace function public.append_google_drive_profile_images(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_drive_folder_id text,
  requested_images jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.dataset_profiles;
  image jsonb;
  next_position integer;
  inserted_id uuid;
  appended_ids uuid[] := '{}'::uuid[];
  skipped_drive_ids text[] := '{}'::text[];
begin
  select * into profile_row from public.dataset_profiles
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile does not belong to the requested dataset.'; end if;
  if profile_row.image_cleared_by_admin then
    raise exception 'An intentionally cleared gallery cannot be restored by reconciliation.';
  end if;
  if profile_row.drive_folder_id is distinct from requested_drive_folder_id then
    raise exception 'Drive folder does not match the profile source.';
  end if;
  if not exists (select 1 from public.profile_images where dataset_id = requested_dataset_id and profile_id = requested_profile_id) then
    raise exception 'Append reconciliation requires an existing relational gallery.';
  end if;
  if exists (
    select 1 from public.profile_images
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id
      and source_type = 'legacy_unknown'
  ) then
    raise exception 'Legacy image identity review must be completed before append reconciliation.';
  end if;
  if jsonb_typeof(requested_images) is distinct from 'array'
    or jsonb_array_length(requested_images) < 1
    or jsonb_array_length(requested_images) > 100 then
    raise exception 'Requested images must be a non-empty array of at most 100 images.';
  end if;

  select coalesce(max(position) + 1, 0) into next_position
  from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  for image in select value from jsonb_array_elements(requested_images) loop
    if nullif(image->>'imageId', '') is null
      or nullif(image->>'storagePath', '') is null
      or nullif(image->>'profileStoragePath', '') is null
      or nullif(image->>'discoveryStoragePath', '') is null
      or nullif(image->>'driveFileId', '') is null then
      raise exception 'Complete image and Drive provenance metadata is required.';
    end if;

    if exists (
      select 1 from public.profile_images
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id
        and source_drive_file_id = image->>'driveFileId'
    ) then
      skipped_drive_ids := array_append(skipped_drive_ids, image->>'driveFileId');
      continue;
    end if;

    insert into public.profile_images (
      id, dataset_id, profile_id, storage_path,
      profile_storage_path, profile_width, profile_height, profile_mime_type, profile_byte_length,
      discovery_storage_path, discovery_width, discovery_height, discovery_mime_type, discovery_byte_length,
      position, is_primary, source_type, source_drive_file_id, source_drive_folder_id,
      source_filename, source_modified_time, source_size
    ) values (
      (image->>'imageId')::uuid, requested_dataset_id, requested_profile_id, image->>'storagePath',
      image->>'profileStoragePath', (image->>'profileWidth')::integer, (image->>'profileHeight')::integer,
      image->>'profileMimeType', (image->>'profileByteLength')::bigint,
      image->>'discoveryStoragePath', (image->>'discoveryWidth')::integer,
      (image->>'discoveryHeight')::integer, image->>'discoveryMimeType',
      (image->>'discoveryByteLength')::bigint,
      next_position, false, 'google_drive', image->>'driveFileId', requested_drive_folder_id,
      nullif(image->>'sourceFilename', ''), nullif(image->>'sourceModifiedTime', '')::timestamptz,
      nullif(image->>'sourceSize', '')::bigint
    ) returning id into inserted_id;
    appended_ids := array_append(appended_ids, inserted_id);
    next_position := next_position + 1;
  end loop;

  return jsonb_build_object(
    'appendedCount', cardinality(appended_ids),
    'appendedImageIds', to_jsonb(appended_ids),
    'skippedDriveFileIds', to_jsonb(skipped_drive_ids)
  );
end;
$$;

create or replace function public.create_profile_image_gallery_with_profile_derivatives_if_empty(
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
  result jsonb;
begin
  if jsonb_typeof(requested_images) is distinct from 'array' then
    raise exception 'Requested images must be an array.';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(requested_images) as image(
      "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
      "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
      "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
      "discoveryMimeType" text, "discoveryByteLength" bigint, "driveFileId" text
    )
    where image."profileStoragePath" is null or image."profileWidth" is null
      or image."profileHeight" is null or image."profileMimeType" <> 'image/webp'
      or image."profileByteLength" is null or image."discoveryStoragePath" is null
      or image."discoveryWidth" is null or image."discoveryHeight" is null
      or image."discoveryMimeType" <> 'image/webp' or image."discoveryByteLength" is null
      or image."driveFileId" is null
  ) then
    raise exception 'Complete derivative and Google Drive provenance metadata is required.';
  end if;

  result := public.create_profile_image_gallery_if_empty(
    requested_dataset_id, requested_profile_id, requested_images
  );
  if coalesce((result->>'created')::boolean, false) then
    update public.profile_images pi
    set profile_storage_path = image."profileStoragePath",
        profile_width = image."profileWidth",
        profile_height = image."profileHeight",
        profile_mime_type = image."profileMimeType",
        profile_byte_length = image."profileByteLength",
        discovery_storage_path = image."discoveryStoragePath",
        discovery_width = image."discoveryWidth",
        discovery_height = image."discoveryHeight",
        discovery_mime_type = image."discoveryMimeType",
        discovery_byte_length = image."discoveryByteLength",
        source_type = 'google_drive',
        source_drive_file_id = image."driveFileId",
        source_drive_folder_id = image."driveFolderId",
        source_filename = nullif(image."sourceFilename", ''),
        source_modified_time = image."sourceModifiedTime",
        source_size = image."sourceSize"
    from jsonb_to_recordset(requested_images) as image(
      "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
      "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
      "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
      "discoveryMimeType" text, "discoveryByteLength" bigint,
      "driveFileId" text, "driveFolderId" text, "sourceFilename" text,
      "sourceModifiedTime" timestamptz, "sourceSize" bigint
    )
    where pi.id = image."imageId"
      and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
  end if;
  return result;
end;
$$;

create or replace function public.replace_profile_image_gallery_with_profile_derivatives(
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
  result jsonb;
begin
  if jsonb_typeof(replacement_images) is distinct from 'array' then
    raise exception 'Replacement images must be a JSON array.';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(replacement_images) as image(
      "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
      "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
      "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
      "discoveryMimeType" text, "discoveryByteLength" bigint, "driveFileId" text
    )
    where image."profileStoragePath" is null or image."profileWidth" is null
      or image."profileHeight" is null or image."profileMimeType" <> 'image/webp'
      or image."profileByteLength" is null or image."discoveryStoragePath" is null
      or image."discoveryWidth" is null or image."discoveryHeight" is null
      or image."discoveryMimeType" <> 'image/webp' or image."discoveryByteLength" is null
      or image."driveFileId" is null
  ) then
    raise exception 'Complete derivative and Google Drive provenance metadata is required.';
  end if;

  result := public.replace_profile_image_gallery(
    requested_dataset_id, requested_profile_id, expected_existing_image_ids, replacement_images
  );
  update public.profile_images pi
  set profile_storage_path = image."profileStoragePath",
      profile_width = image."profileWidth",
      profile_height = image."profileHeight",
      profile_mime_type = image."profileMimeType",
      profile_byte_length = image."profileByteLength",
      discovery_storage_path = image."discoveryStoragePath",
      discovery_width = image."discoveryWidth",
      discovery_height = image."discoveryHeight",
      discovery_mime_type = image."discoveryMimeType",
      discovery_byte_length = image."discoveryByteLength",
      source_type = 'google_drive',
      source_drive_file_id = image."driveFileId",
      source_drive_folder_id = nullif(image."driveFolderId", ''),
      source_filename = nullif(image."sourceFilename", ''),
      source_modified_time = image."sourceModifiedTime",
      source_size = image."sourceSize"
  from jsonb_to_recordset(replacement_images) as image(
    "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
    "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
    "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
    "discoveryMimeType" text, "discoveryByteLength" bigint,
    "driveFileId" text, "driveFolderId" text, "sourceFilename" text,
    "sourceModifiedTime" timestamptz, "sourceSize" bigint
  )
  where pi.id = image."imageId"
    and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
  return result;
end;
$$;

revoke all on function public.create_google_drive_profile_image_with_derivatives(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint, text, text, text, timestamptz, bigint, boolean) from public, anon, authenticated;
revoke all on function public.attach_profile_image_drive_provenance(uuid, text, uuid, text, text, text, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.mark_profile_image_legacy_preserved(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.append_google_drive_profile_images(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.create_profile_image_gallery_with_profile_derivatives_if_empty(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.replace_profile_image_gallery_with_profile_derivatives(uuid, text, uuid[], jsonb) from public, anon, authenticated;

grant execute on function public.create_google_drive_profile_image_with_derivatives(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint, text, text, text, timestamptz, bigint, boolean) to service_role;
grant execute on function public.attach_profile_image_drive_provenance(uuid, text, uuid, text, text, text, timestamptz, bigint) to service_role;
grant execute on function public.mark_profile_image_legacy_preserved(uuid, text, uuid) to service_role;
grant execute on function public.append_google_drive_profile_images(uuid, text, text, jsonb) to service_role;
grant execute on function public.create_profile_image_gallery_with_profile_derivatives_if_empty(uuid, text, jsonb) to service_role;
grant execute on function public.replace_profile_image_gallery_with_profile_derivatives(uuid, text, uuid[], jsonb) to service_role;

commit;
