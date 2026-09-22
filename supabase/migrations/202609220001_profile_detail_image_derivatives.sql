-- Add immutable ProfileDetail delivery derivatives while preserving canonical
-- storage_path objects and the existing Discovery derivative contract.

begin;

alter table public.profile_images
  add column if not exists profile_storage_path text,
  add column if not exists profile_width integer,
  add column if not exists profile_height integer,
  add column if not exists profile_mime_type text,
  add column if not exists profile_byte_length bigint;

alter table public.profile_images
  add constraint profile_images_profile_metadata_complete check (
    (profile_storage_path is null and profile_width is null and profile_height is null
      and profile_mime_type is null and profile_byte_length is null)
    or
    (profile_storage_path is not null and profile_width is not null and profile_height is not null
      and profile_mime_type is not null and profile_byte_length is not null)
  ),
  add constraint profile_images_profile_dimensions_valid check (
    profile_width is null or (profile_width > 0 and profile_height > 0)
  ),
  add constraint profile_images_profile_mime_valid check (
    profile_mime_type is null or profile_mime_type = 'image/webp'
  ),
  add constraint profile_images_profile_byte_length_valid check (
    profile_byte_length is null or profile_byte_length between 1 and 15728640
  );

create unique index profile_images_profile_storage_path_idx
  on public.profile_images (profile_storage_path)
  where profile_storage_path is not null;

create or replace function public.validate_profile_image_profile_storage_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
begin
  if new.profile_storage_path is null then return new; end if;
  select slug into dataset_slug from public.datasets where id = new.dataset_id;
  if not found then raise exception 'Dataset not found for ProfileDetail derivative.'; end if;
  if split_part(new.profile_storage_path, '/', 1) <> dataset_slug
    or split_part(new.profile_storage_path, '/', 2) <> new.profile_id
    or split_part(new.profile_storage_path, '/', 3) <> 'derived'
    or split_part(new.profile_storage_path, '/', 4) <> (new.id::text || '-profile.webp')
    or split_part(new.profile_storage_path, '/', 5) <> '' then
    raise exception 'ProfileDetail derivative path does not match its profile image.';
  end if;
  return new;
end;
$$;

create trigger profile_images_validate_profile_storage_path
before insert or update of id, dataset_id, profile_id, profile_storage_path
on public.profile_images
for each row execute function public.validate_profile_image_profile_storage_path();

create function public.create_profile_image_with_derivative(
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
  requested_make_primary boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  has_primary boolean;
  inserted_image public.profile_images;
begin
  perform 1 from public.dataset_profiles
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile does not belong to the requested dataset.'; end if;

  select exists (
    select 1 from public.profile_images
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id and is_primary
  ) into has_primary;
  if requested_make_primary or not has_primary then
    update public.profile_images set is_primary = false
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  end if;

  insert into public.profile_images (
    id, dataset_id, profile_id, storage_path,
    profile_storage_path, profile_width, profile_height, profile_mime_type, profile_byte_length,
    discovery_storage_path, discovery_width, discovery_height, discovery_mime_type, discovery_byte_length,
    position, is_primary
  ) values (
    requested_image_id, requested_dataset_id, requested_profile_id, requested_storage_path,
    requested_profile_storage_path, requested_profile_width, requested_profile_height,
    requested_profile_mime_type, requested_profile_byte_length,
    requested_discovery_storage_path, requested_discovery_width, requested_discovery_height,
    requested_discovery_mime_type, requested_discovery_byte_length,
    coalesce((select max(position) + 1 from public.profile_images
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id), 0),
    requested_make_primary or not has_primary
  ) returning * into inserted_image;

  if inserted_image.is_primary then
    update public.dataset_profiles
    set storage_image_path = inserted_image.storage_path, image_cleared_by_admin = false
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  end if;

  return jsonb_build_object(
    'id', inserted_image.id,
    'storagePath', inserted_image.storage_path,
    'profileStoragePath', inserted_image.profile_storage_path,
    'profileWidth', inserted_image.profile_width,
    'profileHeight', inserted_image.profile_height,
    'profileMimeType', inserted_image.profile_mime_type,
    'profileByteLength', inserted_image.profile_byte_length,
    'discoveryStoragePath', inserted_image.discovery_storage_path,
    'discoveryWidth', inserted_image.discovery_width,
    'discoveryHeight', inserted_image.discovery_height,
    'discoveryMimeType', inserted_image.discovery_mime_type,
    'discoveryByteLength', inserted_image.discovery_byte_length,
    'position', inserted_image.position,
    'isPrimary', inserted_image.is_primary,
    'focalX', inserted_image.focal_x,
    'focalY', inserted_image.focal_y,
    'displayMode', inserted_image.display_mode
  );
end;
$$;

create function public.create_profile_image_gallery_with_profile_derivatives_if_empty(
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
      "discoveryMimeType" text, "discoveryByteLength" bigint, position integer
    )
    where image."profileStoragePath" is null or image."profileWidth" is null
      or image."profileHeight" is null or image."profileMimeType" <> 'image/webp'
      or image."profileByteLength" is null
      or image."discoveryStoragePath" is null or image."discoveryWidth" is null
      or image."discoveryHeight" is null or image."discoveryMimeType" <> 'image/webp'
      or image."discoveryByteLength" is null
  ) then
    raise exception 'Complete ProfileDetail and Discovery derivative metadata is required.';
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
        discovery_byte_length = image."discoveryByteLength"
    from jsonb_to_recordset(requested_images) as image(
      "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
      "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
      "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
      "discoveryMimeType" text, "discoveryByteLength" bigint
    )
    where pi.id = image."imageId"
      and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
  end if;
  return result;
end;
$$;

create function public.replace_profile_image_gallery_with_profile_derivatives(
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
      "discoveryMimeType" text, "discoveryByteLength" bigint
    )
    where image."profileStoragePath" is null or image."profileWidth" is null
      or image."profileHeight" is null or image."profileMimeType" <> 'image/webp'
      or image."profileByteLength" is null
      or image."discoveryStoragePath" is null or image."discoveryWidth" is null
      or image."discoveryHeight" is null or image."discoveryMimeType" <> 'image/webp'
      or image."discoveryByteLength" is null
  ) then
    raise exception 'Complete ProfileDetail and Discovery derivative metadata is required.';
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
      discovery_byte_length = image."discoveryByteLength"
  from jsonb_to_recordset(replacement_images) as image(
    "imageId" uuid, "profileStoragePath" text, "profileWidth" integer,
    "profileHeight" integer, "profileMimeType" text, "profileByteLength" bigint,
    "discoveryStoragePath" text, "discoveryWidth" integer, "discoveryHeight" integer,
    "discoveryMimeType" text, "discoveryByteLength" bigint
  )
  where pi.id = image."imageId"
    and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
  return result;
end;
$$;

create function public.replace_profile_image_assets(
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
  requested_discovery_byte_length bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_image public.profile_images;
  updated_image public.profile_images;
begin
  select * into previous_image from public.profile_images
  where id = requested_image_id and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;

  update public.profile_images
  set storage_path = requested_storage_path,
      profile_storage_path = requested_profile_storage_path,
      profile_width = requested_profile_width,
      profile_height = requested_profile_height,
      profile_mime_type = requested_profile_mime_type,
      profile_byte_length = requested_profile_byte_length,
      discovery_storage_path = requested_discovery_storage_path,
      discovery_width = requested_discovery_width,
      discovery_height = requested_discovery_height,
      discovery_mime_type = requested_discovery_mime_type,
      discovery_byte_length = requested_discovery_byte_length
  where id = requested_image_id
  returning * into updated_image;

  if updated_image.is_primary then
    update public.dataset_profiles set storage_image_path = updated_image.storage_path
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  end if;

  return jsonb_build_object(
    'id', updated_image.id,
    'storagePath', updated_image.storage_path,
    'profileStoragePath', updated_image.profile_storage_path,
    'discoveryStoragePath', updated_image.discovery_storage_path,
    'position', updated_image.position,
    'isPrimary', updated_image.is_primary,
    'focalX', updated_image.focal_x,
    'focalY', updated_image.focal_y,
    'displayMode', updated_image.display_mode,
    'previousStoragePath', previous_image.storage_path,
    'previousProfileStoragePath', previous_image.profile_storage_path,
    'previousDiscoveryStoragePath', previous_image.discovery_storage_path
  );
end;
$$;

create function public.set_profile_image_profile_derivative(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  expected_storage_path text,
  requested_profile_storage_path text,
  requested_profile_width integer,
  requested_profile_height integer,
  requested_profile_mime_type text,
  requested_profile_byte_length bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_image public.profile_images;
begin
  update public.profile_images
  set profile_storage_path = requested_profile_storage_path,
      profile_width = requested_profile_width,
      profile_height = requested_profile_height,
      profile_mime_type = requested_profile_mime_type,
      profile_byte_length = requested_profile_byte_length
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
    and storage_path = expected_storage_path
    and profile_storage_path is null
  returning * into updated_image;
  if not found then
    raise exception 'The image changed or already has a ProfileDetail derivative.';
  end if;
  return jsonb_build_object(
    'id', updated_image.id,
    'storagePath', updated_image.storage_path,
    'profileStoragePath', updated_image.profile_storage_path,
    'profileWidth', updated_image.profile_width,
    'profileHeight', updated_image.profile_height,
    'profileMimeType', updated_image.profile_mime_type,
    'profileByteLength', updated_image.profile_byte_length
  );
end;
$$;

-- Detail receives only the optimized path when present; Discovery remains on
-- discovery_storage_path. Canonical paths are retained only as fallbacks.
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
  primary_profile_storage_path text;
  primary_discovery_storage_path text;
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
    select pi.storage_path, pi.profile_storage_path, pi.discovery_storage_path,
      pi.focal_x, pi.focal_y, pi.display_mode
    into primary_storage_path, primary_profile_storage_path, primary_discovery_storage_path,
      primary_focal_x, primary_focal_y, primary_display_mode
    from public.profile_images pi
    where pi.dataset_id = requested_dataset_id
      and pi.profile_id = requested_profile_id and pi.is_primary
    limit 1;

    effective_storage_path := case
      when include_gallery then coalesce(primary_profile_storage_path, primary_storage_path, legacy_storage_image_path)
      else coalesce(primary_discovery_storage_path, primary_storage_path, legacy_storage_image_path)
    end;
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
          'storageImagePath', coalesce(pi.profile_storage_path, pi.storage_path),
          'position', pi.position,
          'isPrimary', pi.is_primary,
          'focalX', pi.focal_x,
          'focalY', pi.focal_y,
          'displayMode', pi.display_mode
        ) order by pi.position, pi.id
      ), '[]'::jsonb)
      into gallery
      from public.profile_images pi
      where pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
    end if;
    resolved := resolved || jsonb_build_object('profileImages', gallery);
  end if;
  return resolved;
end;
$$;

revoke all on function public.validate_profile_image_profile_storage_path() from public, anon, authenticated;
revoke all on function public.create_profile_image_with_derivative(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.create_profile_image_gallery_with_profile_derivatives_if_empty(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.replace_profile_image_gallery_with_profile_derivatives(uuid, text, uuid[], jsonb) from public, anon, authenticated;
revoke all on function public.replace_profile_image_assets(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint) from public, anon, authenticated;
revoke all on function public.set_profile_image_profile_derivative(uuid, text, uuid, text, text, integer, integer, text, bigint) from public, anon, authenticated;

grant execute on function public.create_profile_image_with_derivative(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint, boolean) to service_role;
grant execute on function public.create_profile_image_gallery_with_profile_derivatives_if_empty(uuid, text, jsonb) to service_role;
grant execute on function public.replace_profile_image_gallery_with_profile_derivatives(uuid, text, uuid[], jsonb) to service_role;
grant execute on function public.replace_profile_image_assets(uuid, text, uuid, text, text, integer, integer, text, bigint, text, integer, integer, text, bigint) to service_role;
grant execute on function public.set_profile_image_profile_derivative(uuid, text, uuid, text, text, integer, integer, text, bigint) to service_role;

commit;
