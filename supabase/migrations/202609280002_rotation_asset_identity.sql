-- Rotation preserves the relational profile_images row ID while replacing its
-- immutable Storage asset set with a new UUID. Validate both the historical
-- row-ID convention and the replacement asset-set convention without allowing
-- cross-profile, cross-image, or malformed derivative paths.

begin;

create or replace function public.validate_profile_image_storage_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
  canonical_asset_id text;
  profile_asset_id text;
  discovery_asset_id text;
begin
  select slug into dataset_slug from public.datasets where id = new.dataset_id;
  if not found then raise exception 'Dataset not found for profile image.'; end if;

  if new.storage_path is null
    or split_part(new.storage_path, '/', 1) <> dataset_slug
    or split_part(new.storage_path, '/', 2) <> new.profile_id
    or split_part(new.storage_path, '/', 3) !~ '^(?:primary|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(avif|gif|jpg|png|webp)$'
    or split_part(new.storage_path, '/', 4) <> '' then
    raise exception 'Profile image Storage path does not match its dataset and profile.';
  end if;

  canonical_asset_id := substring(
    split_part(new.storage_path, '/', 3)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.'
  );
  profile_asset_id := substring(
    split_part(coalesce(new.profile_storage_path, ''), '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-profile\.webp$'
  );
  discovery_asset_id := substring(
    split_part(coalesce(new.discovery_storage_path, ''), '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-discovery\.webp$'
  );

  if profile_asset_id is not null
    and profile_asset_id <> new.id::text
    and profile_asset_id is distinct from canonical_asset_id then
    raise exception 'ProfileDetail derivative path does not match its profile image.';
  end if;
  if discovery_asset_id is not null
    and discovery_asset_id <> new.id::text
    and discovery_asset_id is distinct from canonical_asset_id then
    raise exception 'Discovery derivative path does not match its profile image.';
  end if;
  if profile_asset_id is not null and discovery_asset_id is not null
    and profile_asset_id <> discovery_asset_id then
    raise exception 'Profile image derivative paths do not share an asset identity.';
  end if;
  return new;
end;
$$;

create or replace function public.validate_profile_image_profile_storage_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
  canonical_asset_id text;
  profile_asset_id text;
  discovery_asset_id text;
begin
  if new.profile_storage_path is null then return new; end if;
  select slug into dataset_slug from public.datasets where id = new.dataset_id;
  if not found then raise exception 'Dataset not found for ProfileDetail derivative.'; end if;

  canonical_asset_id := substring(
    split_part(new.storage_path, '/', 3)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.'
  );
  profile_asset_id := substring(
    split_part(new.profile_storage_path, '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-profile\.webp$'
  );
  discovery_asset_id := substring(
    split_part(coalesce(new.discovery_storage_path, ''), '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-discovery\.webp$'
  );

  if split_part(new.profile_storage_path, '/', 1) <> dataset_slug
    or split_part(new.profile_storage_path, '/', 2) <> new.profile_id
    or split_part(new.profile_storage_path, '/', 3) <> 'derived'
    or profile_asset_id is null
    or split_part(new.profile_storage_path, '/', 5) <> ''
    or (profile_asset_id <> new.id::text and profile_asset_id is distinct from canonical_asset_id)
    or (discovery_asset_id is not null and discovery_asset_id <> profile_asset_id) then
    raise exception 'ProfileDetail derivative path does not match its profile image.';
  end if;
  return new;
end;
$$;

create or replace function public.validate_profile_image_discovery_storage_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dataset_slug text;
  canonical_asset_id text;
  profile_asset_id text;
  discovery_asset_id text;
begin
  if new.discovery_storage_path is null then return new; end if;
  select slug into dataset_slug from public.datasets where id = new.dataset_id;
  if not found then raise exception 'Dataset not found for profile image derivative.'; end if;

  canonical_asset_id := substring(
    split_part(new.storage_path, '/', 3)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.'
  );
  profile_asset_id := substring(
    split_part(coalesce(new.profile_storage_path, ''), '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-profile\.webp$'
  );
  discovery_asset_id := substring(
    split_part(new.discovery_storage_path, '/', 4)
    from '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-discovery\.webp$'
  );

  if split_part(new.discovery_storage_path, '/', 1) <> dataset_slug
    or split_part(new.discovery_storage_path, '/', 2) <> new.profile_id
    or split_part(new.discovery_storage_path, '/', 3) <> 'derived'
    or discovery_asset_id is null
    or split_part(new.discovery_storage_path, '/', 5) <> ''
    or (discovery_asset_id <> new.id::text and discovery_asset_id is distinct from canonical_asset_id)
    or (profile_asset_id is not null and profile_asset_id <> discovery_asset_id) then
    raise exception 'Discovery derivative path does not match its profile image.';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_profile_image_storage_path() from public, anon, authenticated;
revoke all on function public.validate_profile_image_profile_storage_path() from public, anon, authenticated;
revoke all on function public.validate_profile_image_discovery_storage_path() from public, anon, authenticated;

commit;
