-- Unapplied. This registry closes the database side of the check/delete race.
-- Storage deletion remains an operator action performed only after reservation.
begin;

create table public.profile_image_compression_cleanups (
  operation_id uuid primary key,
  image_id uuid not null,
  dataset_id uuid not null,
  profile_id text not null,
  old_storage_path text not null unique,
  new_storage_path text not null,
  expected_updated_at timestamptz not null,
  original_sha256 text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  optimized_sha256 text not null check (optimized_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('reserved', 'deleted', 'cancelled')),
  reserved_at timestamptz not null default now(),
  deleted_at timestamptz,
  cancelled_at timestamptz
);

create unique index profile_image_compression_cleanups_active_image_idx
  on public.profile_image_compression_cleanups(image_id)
  where status = 'reserved';

alter table public.profile_image_compression_cleanups enable row level security;
revoke all on public.profile_image_compression_cleanups from public, anon, authenticated;
grant select on public.profile_image_compression_cleanups to service_role;

create function public.reject_profile_image_cleaned_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocked_path text;
begin
  select c.old_storage_path into blocked_path
  from public.profile_image_compression_cleanups c
  where (c.status = 'reserved' and c.image_id = new.id)
    or (c.status in ('reserved', 'deleted')
      and c.old_storage_path in (new.storage_path,
        coalesce(new.profile_storage_path, ''), coalesce(new.discovery_storage_path, '')))
  limit 1;
  if found then
    raise exception 'Storage path is reserved or deleted by image compression cleanup: %', blocked_path;
  end if;
  return new;
end;
$$;

create trigger profile_images_reject_cleaned_path
before insert or update
on public.profile_images
for each row execute function public.reject_profile_image_cleaned_path();

create function public.reject_dataset_profile_cleaned_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocked_path text;
begin
  select c.old_storage_path into blocked_path
  from public.profile_image_compression_cleanups c
  where c.status in ('reserved', 'deleted')
    and (new.storage_image_path = c.old_storage_path
      or position(c.old_storage_path in coalesce(new.public_data, '{}'::jsonb)::text) > 0
      or position(c.old_storage_path in coalesce(new.public_overrides, '{}'::jsonb)::text) > 0)
  limit 1;
  if found then
    raise exception 'Profile fallback references a reserved or deleted image: %', blocked_path;
  end if;
  return new;
end;
$$;

create trigger dataset_profiles_reject_cleaned_path
before insert or update of storage_image_path, public_data, public_overrides
on public.dataset_profiles
for each row execute function public.reject_dataset_profile_cleaned_path();

create function public.reject_dataset_import_cleaned_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  blocked_path text;
begin
  select c.old_storage_path into blocked_path
  from public.profile_image_compression_cleanups c
  where c.status in ('reserved', 'deleted')
    and position(c.old_storage_path in new.normalized_profiles::text) > 0
  limit 1;
  if found then
    raise exception 'Dataset import references a reserved or deleted image: %', blocked_path;
  end if;
  return new;
end;
$$;

create trigger dataset_imports_reject_cleaned_path
before insert or update of normalized_profiles on public.dataset_imports
for each row execute function public.reject_dataset_import_cleaned_path();

create function public.reserve_profile_image_compression_cleanup(
  requested_operation_id uuid,
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_old_storage_path text,
  requested_new_storage_path text,
  expected_updated_at timestamptz,
  requested_original_sha256 text,
  requested_optimized_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_image public.profile_images;
  existing public.profile_image_compression_cleanups;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  if requested_operation_id is null or requested_old_storage_path is null
    or requested_new_storage_path is null or requested_old_storage_path = requested_new_storage_path
    or requested_original_sha256 !~ '^[0-9a-f]{64}$'
    or requested_optimized_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Complete exact cleanup identity is required.';
  end if;

  -- Brief table locks serialize the initial no-reference check with all writers.
  lock table public.profile_images in share mode;
  lock table public.dataset_profiles in share mode;
  lock table public.dataset_imports in share mode;

  select * into existing from public.profile_image_compression_cleanups
  where operation_id = requested_operation_id or old_storage_path = requested_old_storage_path
  for update;
  if found then
    if existing.operation_id = requested_operation_id
      and existing.image_id = requested_image_id
      and existing.old_storage_path = requested_old_storage_path
      and existing.new_storage_path = requested_new_storage_path
      and existing.status in ('reserved', 'deleted') then
      return to_jsonb(existing);
    end if;
    raise exception 'A different cleanup already owns this image or path.';
  end if;

  select * into current_image from public.profile_images
  where id = requested_image_id and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found or current_image.storage_path is distinct from requested_new_storage_path
    or current_image.updated_at is distinct from expected_updated_at then
    raise exception 'Image changed after cleanup verification.';
  end if;
  if exists (select 1 from public.profile_images pi
      where requested_old_storage_path in (pi.storage_path,
        coalesce(pi.profile_storage_path, ''), coalesce(pi.discovery_storage_path, '')))
    or exists (select 1 from public.dataset_profiles dp
      where dp.storage_image_path = requested_old_storage_path
        or position(requested_old_storage_path in dp.public_data::text) > 0
        or position(requested_old_storage_path in dp.public_overrides::text) > 0)
    or exists (select 1 from public.dataset_imports di
      where di.expires_at > now()
        and position(requested_old_storage_path in di.normalized_profiles::text) > 0) then
    raise exception 'Old path is still referenced.';
  end if;

  insert into public.profile_image_compression_cleanups (
    operation_id, image_id, dataset_id, profile_id, old_storage_path,
    new_storage_path, expected_updated_at, original_sha256, optimized_sha256, status
  ) values (
    requested_operation_id, requested_image_id, requested_dataset_id, requested_profile_id,
    requested_old_storage_path, requested_new_storage_path, expected_updated_at,
    requested_original_sha256, requested_optimized_sha256, 'reserved'
  ) returning * into existing;
  return to_jsonb(existing);
end;
$$;

create function public.finalize_profile_image_compression_cleanup(
  requested_operation_id uuid,
  requested_image_id uuid,
  requested_old_storage_path text,
  expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleanup public.profile_image_compression_cleanups;
  current_image public.profile_images;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  lock table public.profile_images in share mode;
  lock table public.dataset_profiles in share mode;
  lock table public.dataset_imports in share mode;
  select * into cleanup from public.profile_image_compression_cleanups
  where operation_id = requested_operation_id and image_id = requested_image_id
    and old_storage_path = requested_old_storage_path
  for update;
  if not found then raise exception 'Cleanup reservation not found.'; end if;
  if cleanup.status = 'deleted' then return to_jsonb(cleanup); end if;
  if cleanup.status <> 'reserved' then raise exception 'Cleanup reservation is not active.'; end if;
  select * into current_image from public.profile_images where id = requested_image_id for update;
  if not found or current_image.storage_path is distinct from cleanup.new_storage_path
    or current_image.updated_at is distinct from expected_updated_at then
    raise exception 'Image changed after cleanup reservation.';
  end if;
  if exists (select 1 from public.profile_images pi
      where requested_old_storage_path in (pi.storage_path,
        coalesce(pi.profile_storage_path, ''), coalesce(pi.discovery_storage_path, '')))
    or exists (select 1 from public.dataset_profiles dp
      where dp.storage_image_path = requested_old_storage_path
        or position(requested_old_storage_path in dp.public_data::text) > 0
        or position(requested_old_storage_path in dp.public_overrides::text) > 0)
    or exists (select 1 from public.dataset_imports di
      where di.expires_at > now()
        and position(requested_old_storage_path in di.normalized_profiles::text) > 0) then
    raise exception 'Old path became referenced during cleanup.';
  end if;
  update public.profile_image_compression_cleanups
  set status = 'deleted', deleted_at = now()
  where operation_id = requested_operation_id returning * into cleanup;
  return to_jsonb(cleanup);
end;
$$;

revoke all on function public.reject_profile_image_cleaned_path() from public, anon, authenticated;
revoke all on function public.reject_dataset_profile_cleaned_path() from public, anon, authenticated;
revoke all on function public.reject_dataset_import_cleaned_path() from public, anon, authenticated;
revoke all on function public.reserve_profile_image_compression_cleanup(uuid, uuid, text, uuid, text, text, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_profile_image_compression_cleanup(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_profile_image_compression_cleanup(uuid, uuid, text, uuid, text, text, timestamptz, text, text)
  to service_role;
grant execute on function public.finalize_profile_image_compression_cleanup(uuid, uuid, text, timestamptz)
  to service_role;

commit;
