-- Admin-only profile image metadata operations.
-- Storage bytes are uploaded by the server; these functions keep metadata
-- mutations transactional and scoped to one dataset profile.

begin;

create or replace function public.create_profile_image_metadata(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_storage_path text,
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
  if not exists (
    select 1 from public.dataset_profiles
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id
  ) then
    raise exception 'Profile does not belong to the requested dataset.';
  end if;

  select exists (
    select 1 from public.profile_images
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id
      and is_primary
  ) into has_primary;

  if requested_make_primary or not has_primary then
    update public.profile_images
    set is_primary = false
    where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  end if;

  insert into public.profile_images (
    id, dataset_id, profile_id, storage_path, position, is_primary
  ) values (
    requested_image_id,
    requested_dataset_id,
    requested_profile_id,
    requested_storage_path,
    coalesce((select max(position) + 1 from public.profile_images
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id), 0),
    requested_make_primary or not has_primary
  ) returning * into inserted_image;

  return jsonb_build_object(
    'id', inserted_image.id,
    'storagePath', inserted_image.storage_path,
    'position', inserted_image.position,
    'isPrimary', inserted_image.is_primary,
    'focalX', inserted_image.focal_x,
    'focalY', inserted_image.focal_y,
    'displayMode', inserted_image.display_mode
  );
end;
$$;

create or replace function public.set_profile_image_primary(
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
  selected_image public.profile_images;
begin
  select * into selected_image
  from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;

  update public.profile_images
  set is_primary = false
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  update public.profile_images
  set is_primary = true
  where id = requested_image_id;

  return jsonb_build_object('id', requested_image_id, 'isPrimary', true);
end;
$$;

create or replace function public.reorder_profile_images(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  image_count integer;
  distinct_count integer;
  requested_count integer;
  offset_position integer;
begin
  select count(*) into image_count from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  select count(distinct image_id), cardinality(requested_image_ids)
  into distinct_count, requested_count
  from unnest(requested_image_ids) image_id;
  if image_count <> coalesce(requested_count, 0)
    or distinct_count <> coalesce(requested_count, 0)
    or exists (
      select 1 from public.profile_images pi
      where pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id
        and not (pi.id = any(requested_image_ids))
    ) then
    raise exception 'The reorder list must contain every profile image exactly once.';
  end if;

  select coalesce(max(position), 0) + cardinality(requested_image_ids) + 1
  into offset_position
  from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  update public.profile_images pi
  set position = offset_position + ordering.ordinality
  from unnest(requested_image_ids) with ordinality ordering(image_id, ordinality)
  where pi.id = ordering.image_id
    and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;
  update public.profile_images pi
  set position = ordering.ordinality - 1
  from unnest(requested_image_ids) with ordinality ordering(image_id, ordinality)
  where pi.id = ordering.image_id
    and pi.dataset_id = requested_dataset_id and pi.profile_id = requested_profile_id;

  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'position', position) order by position, id)
    from public.profile_images where dataset_id = requested_dataset_id and profile_id = requested_profile_id), '[]'::jsonb);
end;
$$;

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
  remaining_count integer;
begin
  select * into target from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;

  select count(*) into remaining_count from public.profile_images
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;
  if target.is_primary and remaining_count = 1 then
    raise exception 'The only profile image cannot be removed.';
  end if;

  delete from public.profile_images where id = requested_image_id;
  if target.is_primary then
    update public.profile_images
    set is_primary = true
    where id = (
      select id from public.profile_images
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id
      order by position, id limit 1
    );
  end if;
  return jsonb_build_object('id', target.id, 'storagePath', target.storage_path, 'wasPrimary', target.is_primary);
end;
$$;

create or replace function public.replace_profile_image_storage_path(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_storage_path text
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
  set storage_path = requested_storage_path
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  returning * into updated_image;
  if not found then raise exception 'Profile image was not found.'; end if;
  return jsonb_build_object(
    'id', updated_image.id,
    'storagePath', updated_image.storage_path,
    'position', updated_image.position,
    'isPrimary', updated_image.is_primary,
    'focalX', updated_image.focal_x,
    'focalY', updated_image.focal_y,
    'displayMode', updated_image.display_mode
  );
end;
$$;

revoke all on function public.create_profile_image_metadata(uuid, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.set_profile_image_primary(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.reorder_profile_images(uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.delete_profile_image(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.replace_profile_image_storage_path(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_profile_image_metadata(uuid, text, uuid, text, boolean) to service_role;
grant execute on function public.set_profile_image_primary(uuid, text, uuid) to service_role;
grant execute on function public.reorder_profile_images(uuid, text, uuid[]) to service_role;
grant execute on function public.delete_profile_image(uuid, text, uuid) to service_role;
grant execute on function public.replace_profile_image_storage_path(uuid, text, uuid, text) to service_role;

commit;
