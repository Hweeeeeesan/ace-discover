-- Atomically create an ordered profile gallery only while it is still empty.
-- Drive downloads and Storage uploads remain server-side; this function is the
-- final concurrency boundary for the Admin missing-image batch workflow.

begin;

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
  requested_count integer;
  inserted_count integer;
  primary_storage_path text;
begin
  select d.status, dp.storage_image_path
  into dataset_status, existing_storage_path
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

revoke all on function public.create_profile_image_gallery_if_empty(uuid, text, jsonb)
from public, anon, authenticated;
grant execute on function public.create_profile_image_gallery_if_empty(uuid, text, jsonb)
to service_role;

commit;
