-- ACE Discover v4 hardening. Apply after 202608150001_ace_discover_v4_datasets.sql.
-- Bulk reads deliberately remove Instagram. Only the active dataset's single-profile
-- function may return the complete normalized public profile.

begin;

create index if not exists dataset_imports_expires_at_idx
  on public.dataset_imports (expires_at);

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
      select jsonb_agg(dp.public_data - 'instagram' order by dp.ordinal)
      from public.dataset_profiles dp
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
      select jsonb_agg(dp.public_data - 'instagram' order by dp.ordinal)
      from public.dataset_profiles dp
      where dp.dataset_id = d.id
    ), '[]'::jsonb)
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  where s.singleton
    and d.status = 'active'
    and d.slug = requested_slug;
$$;

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
    'profile', dp.public_data
  )
  from public.app_settings s
  join public.datasets d on d.id = s.active_dataset_id
  join public.dataset_profiles dp on dp.dataset_id = d.id
  where s.singleton
    and d.status = 'active'
    and d.slug = requested_slug
    and dp.profile_id = requested_profile_id;
$$;

create or replace function public.is_allowed_drive_source(
  requested_file_id text,
  requested_folder_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_settings s
    join public.datasets d on d.id = s.active_dataset_id
    join public.dataset_profiles dp on dp.dataset_id = d.id
    where s.singleton
      and d.status = 'active'
      and (
        (requested_file_id is not null and requested_file_id <> '' and dp.drive_file_id = requested_file_id)
        or (requested_folder_id is not null and requested_folder_id <> '' and dp.drive_folder_id = requested_folder_id)
      )
  );
$$;

create or replace function public.cleanup_expired_dataset_imports()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  delete from public.dataset_imports where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.save_dataset_import(import_id uuid, actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.dataset_imports%rowtype;
  new_dataset public.datasets%rowtype;
begin
  delete from public.dataset_imports where expires_at <= now();

  select * into draft
  from public.dataset_imports
  where id = import_id
    and created_by = actor_id
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Import preview was not found or has expired.';
  end if;

  if exists (select 1 from public.datasets where slug = draft.slug) then
    raise exception 'A dataset with slug % already exists.', draft.slug;
  end if;

  insert into public.datasets (
    slug, name, term, year, status, profile_count, health, safe_issues, created_by
  ) values (
    draft.slug, draft.name, draft.term, draft.year, 'ready',
    draft.profile_count, draft.health, draft.safe_issues, actor_id
  ) returning * into new_dataset;

  insert into public.dataset_profiles (
    dataset_id, profile_id, ordinal, public_data, drive_file_id, drive_folder_id,
    image_kind, image_issue
  )
  select
    new_dataset.id,
    item.value->'public'->>'id',
    item.ordinality - 1,
    item.value->'public',
    nullif(item.value->>'driveFileId', ''),
    nullif(item.value->>'driveFolderId', ''),
    nullif(item.value->>'imageKind', ''),
    nullif(item.value->>'imageIssue', '')
  from jsonb_array_elements(draft.normalized_profiles) with ordinality as item(value, ordinality);

  delete from public.dataset_imports where id = import_id;

  return jsonb_build_object(
    'id', new_dataset.id,
    'slug', new_dataset.slug,
    'name', new_dataset.name,
    'status', new_dataset.status,
    'profileCount', new_dataset.profile_count
  );
end;
$$;

create or replace function public.activate_dataset(dataset_id_to_activate uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
begin
  insert into public.app_settings (singleton) values (true)
  on conflict (singleton) do nothing;

  perform 1 from public.app_settings where singleton for update;

  select * into target
  from public.datasets
  where id = dataset_id_to_activate
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;
  if target.profile_count <= 0 then
    raise exception 'An empty dataset cannot be activated.';
  end if;
  if (select count(*) from public.dataset_profiles where dataset_id = target.id) <> target.profile_count then
    raise exception 'Dataset profile count does not match its stored profiles.';
  end if;

  update public.datasets
  set status = 'archived', archived_at = coalesce(archived_at, now())
  where status = 'active' and id <> dataset_id_to_activate;

  update public.datasets
  set status = 'active', activated_at = coalesce(activated_at, now()), archived_at = null
  where id = dataset_id_to_activate
  returning * into target;

  update public.app_settings
  set active_dataset_id = dataset_id_to_activate, updated_at = now()
  where singleton;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profileCount', target.profile_count
  );
end;
$$;

create or replace function public.set_dataset_status(
  dataset_id_to_update uuid,
  requested_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
begin
  if requested_status not in ('ready', 'archived') then
    raise exception 'Invalid dataset status.';
  end if;

  insert into public.app_settings (singleton) values (true)
  on conflict (singleton) do nothing;

  perform 1 from public.app_settings where singleton for update;

  select * into target
  from public.datasets
  where id = dataset_id_to_update
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;
  if target.status = 'active' or (
    select active_dataset_id = dataset_id_to_update
    from public.app_settings
    where singleton
  ) then
    raise exception 'The live dataset cannot change status. Activate another dataset first.';
  end if;

  update public.datasets
  set status = requested_status,
      archived_at = case when requested_status = 'archived' then coalesce(archived_at, now()) else null end
  where id = dataset_id_to_update
  returning * into target;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profileCount', target.profile_count
  );
end;
$$;

create or replace function public.seed_fall_2025_dataset(
  seed_profiles jsonb,
  seed_health jsonb,
  seed_safe_issues jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
  stored_count integer;
  distinct_count integer;
begin
  if jsonb_typeof(seed_profiles) <> 'array' or jsonb_array_length(seed_profiles) <> 210 then
    raise exception 'Fall 2025 seed must contain exactly 210 profiles.';
  end if;
  select count(distinct (item.value->'public'->>'id')) into distinct_count
  from jsonb_array_elements(seed_profiles) as item(value);
  if distinct_count <> 210 or exists (
    select 1 from jsonb_array_elements(seed_profiles) as item(value)
    where coalesce(item.value->'public'->>'id', '') = ''
  ) then
    raise exception 'Fall 2025 seed profile IDs must be present and unique.';
  end if;

  insert into public.app_settings (singleton) values (true)
  on conflict (singleton) do nothing;
  perform 1 from public.app_settings where singleton for update;

  select * into target from public.datasets where slug = 'fall-2025' for update;
  if not found then
    insert into public.datasets (
      slug, name, term, year, status, profile_count, health, safe_issues
    ) values (
      'fall-2025', 'Fall 2025', 'Fall', 2025, 'ready', 0,
      coalesce(seed_health, '{}'::jsonb), coalesce(seed_safe_issues, '{}'::jsonb)
    ) returning * into target;
  end if;

  delete from public.dataset_profiles where dataset_id = target.id;
  insert into public.dataset_profiles (
    dataset_id, profile_id, ordinal, public_data, drive_file_id, drive_folder_id,
    image_kind, image_issue
  )
  select
    target.id,
    item.value->'public'->>'id',
    item.ordinality - 1,
    item.value->'public',
    nullif(item.value->>'driveFileId', ''),
    nullif(item.value->>'driveFolderId', ''),
    nullif(item.value->>'imageKind', ''),
    nullif(item.value->>'imageIssue', '')
  from jsonb_array_elements(seed_profiles) with ordinality as item(value, ordinality);

  select count(*), count(distinct profile_id)
  into stored_count, distinct_count
  from public.dataset_profiles
  where dataset_id = target.id;
  if stored_count <> 210 or distinct_count <> 210 then
    raise exception 'Fall 2025 seed integrity verification failed.';
  end if;

  update public.datasets
  set name = 'Fall 2025', term = 'Fall', year = 2025,
      profile_count = 210,
      health = coalesce(seed_health, '{}'::jsonb),
      safe_issues = coalesce(seed_safe_issues, '{}'::jsonb),
      imported_at = now()
  where id = target.id;

  update public.datasets
  set status = 'archived', archived_at = coalesce(archived_at, now())
  where status = 'active' and id <> target.id;

  update public.datasets
  set status = 'active', activated_at = coalesce(activated_at, now()), archived_at = null
  where id = target.id
  returning * into target;

  update public.app_settings
  set active_dataset_id = target.id, updated_at = now()
  where singleton;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profileCount', target.profile_count,
    'storedProfileCount', stored_count
  );
end;
$$;

revoke all on function public.get_published_profile(text, text) from public;
revoke all on function public.cleanup_expired_dataset_imports() from public;
revoke all on function public.set_dataset_status(uuid, text) from public;
revoke all on function public.seed_fall_2025_dataset(jsonb, jsonb, jsonb) from public;

grant execute on function public.get_published_profile(text, text) to anon, authenticated;
grant execute on function public.cleanup_expired_dataset_imports() to service_role;
grant execute on function public.set_dataset_status(uuid, text) to service_role;
grant execute on function public.seed_fall_2025_dataset(jsonb, jsonb, jsonb) to service_role;

commit;
