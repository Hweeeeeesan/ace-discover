-- ACE Discover single-primary-image Supabase Storage foundation.
-- Apply after 202608160001_ace_discover_v4_service_role_grants.sql.
-- This migration creates no image records and performs no remote ingestion.

begin;

alter table public.dataset_profiles
  add column if not exists storage_image_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'dataset_profiles_storage_image_path_format'
      and conrelid = 'public.dataset_profiles'::regclass
  ) then
    alter table public.dataset_profiles
      add constraint dataset_profiles_storage_image_path_format check (
        storage_image_path is null
        or storage_image_path ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?/primary\.(avif|gif|jpg|png|webp)$'
      );
  end if;
end;
$$;

create or replace function public.sync_profile_storage_image_path()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  public_path text;
begin
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
before insert or update of public_data, storage_image_path on public.dataset_profiles
for each row execute function public.sync_profile_storage_image_path();

update public.dataset_profiles
set storage_image_path = nullif(public_data->>'storageImagePath', '')
where storage_image_path is null
  and nullif(public_data->>'storageImagePath', '') is not null;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-images',
  'profile-images',
  true,
  15728640,
  array['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public reads are limited to this public-content bucket. No INSERT, UPDATE,
-- or DELETE policy is created for anon/authenticated users; writes use the
-- server-only service role through the migration tool.
drop policy if exists "ACE profile images are publicly readable" on storage.objects;
create policy "ACE profile images are publicly readable"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'profile-images');

create or replace function public.set_profile_storage_image_path(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
  updated_path text;
begin
  select slug into dataset_slug
  from public.datasets
  where id = requested_dataset_id;

  if not found then
    raise exception 'Dataset not found.';
  end if;
  if requested_profile_id is null or requested_profile_id = '' then
    raise exception 'Profile ID is required.';
  end if;
  if requested_storage_path is null
    or split_part(requested_storage_path, '/', 1) <> dataset_slug
    or split_part(requested_storage_path, '/', 2) <> requested_profile_id
    or split_part(requested_storage_path, '/', 3) !~ '^primary\.(avif|gif|jpg|png|webp)$'
    or split_part(requested_storage_path, '/', 4) <> '' then
    raise exception 'Storage path does not match the requested dataset and profile.';
  end if;

  update public.dataset_profiles
  set storage_image_path = requested_storage_path
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
    and (storage_image_path is null or storage_image_path = requested_storage_path)
  returning storage_image_path into updated_path;

  if not found then
    if exists (
      select 1 from public.dataset_profiles
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id
    ) then
      raise exception 'A different canonical Storage path is already attached to this profile.';
    end if;
    raise exception 'Profile not found in the requested dataset.';
  end if;

  return jsonb_build_object(
    'datasetId', requested_dataset_id,
    'profileId', requested_profile_id,
    'storageImagePath', updated_path
  );
end;
$$;

revoke all on function public.set_profile_storage_image_path(uuid, text, text) from public;
grant execute on function public.set_profile_storage_image_path(uuid, text, text) to service_role;

commit;
