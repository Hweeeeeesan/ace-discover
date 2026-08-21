-- ACE Discover ordered profile-image foundation.
-- Apply after 202608200001_profile_image_storage.sql.
-- This migration backfills metadata only; it does not upload, move, or delete
-- any Supabase Storage object.

begin;

-- Keep the legacy compatibility field valid for both existing primary.*
-- objects and future stable UUID-named image objects.
alter table public.dataset_profiles
  drop constraint if exists dataset_profiles_storage_image_path_format;

alter table public.dataset_profiles
  add constraint dataset_profiles_storage_image_path_format check (
    storage_image_path is null
    or storage_image_path ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?/(?:primary|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(avif|gif|jpg|png|webp)$'
  );

create table if not exists public.profile_images (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null,
  profile_id text not null,
  storage_path text not null,
  position integer not null check (position >= 0),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_images_dataset_profile_fk
    foreign key (dataset_id, profile_id)
    references public.dataset_profiles(dataset_id, profile_id)
    on delete cascade,
  constraint profile_images_storage_path_unique
    unique (dataset_id, profile_id, storage_path),
  constraint profile_images_position_unique
    unique (dataset_id, profile_id, position)
    deferrable initially deferred
);

create unique index if not exists profile_images_one_primary_idx
  on public.profile_images (dataset_id, profile_id)
  where is_primary;

create index if not exists profile_images_order_idx
  on public.profile_images (dataset_id, profile_id, position, id);

create or replace function public.keep_profile_image_owner_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.dataset_id is distinct from old.dataset_id
    or new.profile_id is distinct from old.profile_id then
    raise exception 'A profile image cannot be moved to another dataset profile.';
  end if;
  return new;
end;
$$;

drop trigger if exists profile_images_keep_owner on public.profile_images;
create trigger profile_images_keep_owner
before update of dataset_id, profile_id on public.profile_images
for each row execute function public.keep_profile_image_owner_immutable();

create or replace function public.validate_profile_image_storage_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
begin
  select slug into dataset_slug
  from public.datasets
  where id = new.dataset_id;

  if not found then
    raise exception 'Dataset not found for profile image.';
  end if;
  if new.storage_path is null
    or split_part(new.storage_path, '/', 1) <> dataset_slug
    or split_part(new.storage_path, '/', 2) <> new.profile_id
    or split_part(new.storage_path, '/', 3) !~ '^(?:primary|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(avif|gif|jpg|png|webp)$'
    or split_part(new.storage_path, '/', 4) <> '' then
    raise exception 'Profile image Storage path does not match its dataset and profile.';
  end if;
  return new;
end;
$$;

drop trigger if exists profile_images_validate_storage_path on public.profile_images;
create trigger profile_images_validate_storage_path
before insert or update of dataset_id, profile_id, storage_path on public.profile_images
for each row execute function public.validate_profile_image_storage_path();

create or replace function public.touch_profile_image_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profile_images_touch_updated_at on public.profile_images;
create trigger profile_images_touch_updated_at
before update on public.profile_images
for each row execute function public.touch_profile_image_updated_at();

create or replace function public.enforce_profile_image_primary()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_dataset_id uuid := coalesce(new.dataset_id, old.dataset_id);
  target_profile_id text := coalesce(new.profile_id, old.profile_id);
  image_count integer;
  primary_count integer;
begin
  select count(*), count(*) filter (where is_primary)
  into image_count, primary_count
  from public.profile_images
  where dataset_id = target_dataset_id
    and profile_id = target_profile_id;

  if image_count > 0 and primary_count <> 1 then
    raise exception 'A profile with images must have exactly one primary image.';
  end if;
  return null;
end;
$$;

drop trigger if exists profile_images_require_primary on public.profile_images;
create constraint trigger profile_images_require_primary
after insert or update or delete on public.profile_images
deferrable initially deferred
for each row execute function public.enforce_profile_image_primary();

alter table public.profile_images enable row level security;
revoke all on table public.profile_images from anon, authenticated;
grant select, insert, update, delete on table public.profile_images to service_role;

-- Rerunnable metadata backfill for every existing canonical primary object.
-- The legacy column remains in place as a compatibility cache/fallback.
insert into public.profile_images (
  dataset_id,
  profile_id,
  storage_path,
  position,
  is_primary
)
select
  dataset_id,
  profile_id,
  storage_image_path,
  0,
  true
from public.dataset_profiles
where storage_image_path is not null
  and not exists (
    select 1
    from public.profile_images existing_image
    where existing_image.dataset_id = dataset_profiles.dataset_id
      and existing_image.profile_id = dataset_profiles.profile_id
  )
on conflict (dataset_id, profile_id, storage_path) do nothing;

-- Bulk discovery exposes only the relational primary path. It intentionally
-- does not include the full image collection in every discovery card payload.
create or replace function public.get_active_dataset()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id,
      'slug', d.slug,
      'name', d.name,
      'term', d.term,
      'year', d.year,
      'status', d.status,
      'profile_count', d.profile_count,
      'created_at', d.created_at,
      'imported_at', d.imported_at,
      'activated_at', d.activated_at
    ),
    'profiles', coalesce((
      select jsonb_agg(
        case
          when coalesce(primary_image.storage_path, dp.storage_image_path) is null
            then dp.public_data - 'instagram'
          else jsonb_set(
            dp.public_data - 'instagram',
            '{storageImagePath}',
            to_jsonb(coalesce(primary_image.storage_path, dp.storage_image_path)),
            true
          )
        end
        order by dp.ordinal
      )
      from public.dataset_profiles dp
      left join lateral (
        select pi.storage_path
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
  where s.singleton
    and d.status = 'active'
    and d.slug = requested_slug;
$$;

-- Detail payloads include the ordered collection for future gallery work, but
-- current rendering still resolves and displays only the primary image.
create or replace function public.get_published_profile(
  requested_slug text,
  requested_profile_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dataset', jsonb_build_object(
      'id', d.id,
      'slug', d.slug,
      'name', d.name,
      'term', d.term,
      'year', d.year,
      'status', d.status,
      'profile_count', d.profile_count,
      'created_at', d.created_at,
      'imported_at', d.imported_at,
      'activated_at', d.activated_at
    ),
    'profile', (
      case
        when coalesce(primary_image.storage_path, dp.storage_image_path) is null
          then dp.public_data
        else jsonb_set(
          dp.public_data,
          '{storageImagePath}',
          to_jsonb(coalesce(primary_image.storage_path, dp.storage_image_path)),
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
            'isPrimary', pi.is_primary
          )
          order by pi.position, pi.id
        )
        from public.profile_images pi
        where pi.dataset_id = dp.dataset_id
          and pi.profile_id = dp.profile_id
      ), '[]'::jsonb)
    )
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  join public.dataset_profiles dp on dp.dataset_id = d.id
  left join lateral (
    select pi.storage_path
    from public.profile_images pi
    where pi.dataset_id = dp.dataset_id
      and pi.profile_id = dp.profile_id
      and pi.is_primary
    limit 1
  ) primary_image on true
  where s.singleton
    and d.status = 'active'
    and d.slug = requested_slug
    and dp.profile_id = requested_profile_id;
$$;

-- Preserve the existing migration tool contract while making every successful
-- canonical-path attachment create its relational primary row atomically.
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
    or split_part(requested_storage_path, '/', 3) !~ '^(?:primary|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(avif|gif|jpg|png|webp)$'
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

  insert into public.profile_images (
    dataset_id,
    profile_id,
    storage_path,
    position,
    is_primary
  ) values (
    requested_dataset_id,
    requested_profile_id,
    requested_storage_path,
    0,
    true
  )
  on conflict (dataset_id, profile_id, storage_path) do nothing;

  if not exists (
    select 1
    from public.profile_images
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id
      and storage_path = requested_storage_path
      and is_primary
  ) then
    raise exception 'The canonical image row could not be confirmed as primary.';
  end if;

  return jsonb_build_object(
    'datasetId', requested_dataset_id,
    'profileId', requested_profile_id,
    'storageImagePath', updated_path
  );
end;
$$;

revoke all on function public.get_active_dataset() from public;
revoke all on function public.get_published_dataset(text) from public;
revoke all on function public.get_published_profile(text, text) from public;
revoke all on function public.set_profile_storage_image_path(uuid, text, text) from public;

grant execute on function public.get_active_dataset() to anon, authenticated;
grant execute on function public.get_published_dataset(text) to anon, authenticated;
grant execute on function public.get_published_profile(text, text) to anon, authenticated;
grant execute on function public.set_profile_storage_image_path(uuid, text, text) to service_role;

commit;
