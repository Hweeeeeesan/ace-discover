-- Optional Google Sheets source metadata and atomic dataset snapshot refresh.
-- Apply after 202609020001_targeted_profile_gallery_replacement.sql.
-- This migration does not contact Google, alter Storage objects, or publish data.

begin;

alter table public.datasets
  add column if not exists source_type text not null default 'excel',
  add column if not exists google_sheet_id text,
  add column if not exists google_sheet_tab text,
  add column if not exists google_sheet_title text,
  add column if not exists last_source_sync_at timestamptz,
  add column if not exists last_source_hash text;

alter table public.datasets
  drop constraint if exists datasets_source_type_check,
  add constraint datasets_source_type_check check (source_type in ('excel', 'google_sheet')),
  drop constraint if exists datasets_google_sheet_id_check,
  add constraint datasets_google_sheet_id_check check (
    google_sheet_id is null or google_sheet_id ~ '^[A-Za-z0-9_-]{20,200}$'
  ),
  drop constraint if exists datasets_google_sheet_tab_check,
  add constraint datasets_google_sheet_tab_check check (
    google_sheet_tab is null or char_length(google_sheet_tab) between 1 and 200
  ),
  drop constraint if exists datasets_google_sheet_title_check,
  add constraint datasets_google_sheet_title_check check (
    google_sheet_title is null or char_length(google_sheet_title) between 1 and 200
  ),
  drop constraint if exists datasets_last_source_hash_check,
  add constraint datasets_last_source_hash_check check (
    last_source_hash is null or last_source_hash ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists datasets_google_sheet_source_check,
  add constraint datasets_google_sheet_source_check check (
    source_type = 'excel'
    or (google_sheet_id is not null and google_sheet_tab is not null)
  );

alter table public.dataset_imports
  add column if not exists target_dataset_id uuid references public.datasets(id) on delete cascade,
  add column if not exists target_imported_at timestamptz,
  add column if not exists source_type text not null default 'excel',
  add column if not exists google_sheet_id text,
  add column if not exists google_sheet_tab text,
  add column if not exists google_sheet_title text,
  add column if not exists source_hash text,
  add column if not exists sync_diff jsonb not null default '{}'::jsonb,
  add column if not exists removed_profile_ids jsonb not null default '[]'::jsonb;

alter table public.dataset_imports
  drop constraint if exists dataset_imports_source_type_check,
  add constraint dataset_imports_source_type_check check (source_type in ('excel', 'google_sheet')),
  drop constraint if exists dataset_imports_target_version_check,
  add constraint dataset_imports_target_version_check check (
    (target_dataset_id is null and target_imported_at is null)
    or (target_dataset_id is not null and target_imported_at is not null)
  ),
  drop constraint if exists dataset_imports_google_sheet_id_check,
  add constraint dataset_imports_google_sheet_id_check check (
    google_sheet_id is null or google_sheet_id ~ '^[A-Za-z0-9_-]{20,200}$'
  ),
  drop constraint if exists dataset_imports_google_sheet_tab_check,
  add constraint dataset_imports_google_sheet_tab_check check (
    google_sheet_tab is null or char_length(google_sheet_tab) between 1 and 200
  ),
  drop constraint if exists dataset_imports_google_sheet_title_check,
  add constraint dataset_imports_google_sheet_title_check check (
    google_sheet_title is null or char_length(google_sheet_title) between 1 and 200
  ),
  drop constraint if exists dataset_imports_source_hash_check,
  add constraint dataset_imports_source_hash_check check (
    source_hash is null or source_hash ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists dataset_imports_removed_profile_ids_check,
  add constraint dataset_imports_removed_profile_ids_check check (
    jsonb_typeof(removed_profile_ids) = 'array'
  );

create index if not exists dataset_imports_target_dataset_idx
  on public.dataset_imports (target_dataset_id)
  where target_dataset_id is not null;

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
    and target_dataset_id is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Import preview was not found or has expired.';
  end if;
  if exists (select 1 from public.datasets where slug = draft.slug) then
    raise exception 'A dataset with slug % already exists.', draft.slug;
  end if;

  insert into public.datasets (
    slug, name, term, year, status, profile_count, health, safe_issues, created_by,
    source_type, google_sheet_id, google_sheet_tab, google_sheet_title,
    last_source_sync_at, last_source_hash
  ) values (
    draft.slug, draft.name, draft.term, draft.year, 'ready',
    draft.profile_count, draft.health, draft.safe_issues, actor_id,
    draft.source_type, draft.google_sheet_id, draft.google_sheet_tab, draft.google_sheet_title,
    case when draft.source_type = 'google_sheet' then now() else null end,
    draft.source_hash
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
    'profileCount', new_dataset.profile_count,
    'sourceType', new_dataset.source_type
  );
end;
$$;

create or replace function public.apply_dataset_sync(
  import_id uuid,
  target_id uuid,
  actor_id uuid,
  acknowledge_removed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.dataset_imports%rowtype;
  target public.datasets%rowtype;
  ordinal_offset integer;
  stored_count integer;
  removed_count integer;
begin
  delete from public.dataset_imports where expires_at <= now();

  select * into draft
  from public.dataset_imports
  where id = import_id
    and created_by = actor_id
    and target_dataset_id = target_id
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Sync preview was not found or has expired.';
  end if;

  removed_count := jsonb_array_length(draft.removed_profile_ids);
  if removed_count > 0 and acknowledge_removed is not true then
    raise exception 'Acknowledge the profiles missing from the source before applying. They will be preserved.';
  end if;

  select * into target from public.datasets where id = target_id for update;
  if not found then
    raise exception 'Dataset not found.';
  end if;
  if target.slug <> draft.slug then
    raise exception 'Sync preview does not match the target dataset.';
  end if;
  if target.imported_at is distinct from draft.target_imported_at then
    raise exception 'The dataset changed after this preview. Check for updates again.';
  end if;

  -- Move current ordinals out of the incoming range, then upsert the complete
  -- sanitized snapshot. Existing parent rows are updated in place, so their
  -- relational profile_images rows and Storage paths remain authoritative.
  select coalesce(max(ordinal), -1) + draft.profile_count + 1000
  into ordinal_offset
  from public.dataset_profiles
  where dataset_id = target.id;
  update public.dataset_profiles
  set ordinal = ordinal + ordinal_offset
  where dataset_id = target.id;

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
  from jsonb_array_elements(draft.normalized_profiles) with ordinality as item(value, ordinality)
  on conflict (dataset_id, profile_id) do update set
    ordinal = excluded.ordinal,
    public_data = excluded.public_data,
    drive_file_id = excluded.drive_file_id,
    drive_folder_id = excluded.drive_folder_id,
    image_kind = excluded.image_kind,
    image_issue = excluded.image_issue;

  select count(*) into stored_count
  from public.dataset_profiles
  where dataset_id = target.id;
  if stored_count <> draft.profile_count then
    raise exception 'Sync integrity verification failed; no dataset changes were applied.';
  end if;

  update public.datasets
  set profile_count = draft.profile_count,
      health = draft.health,
      safe_issues = draft.safe_issues,
      imported_at = now(),
      source_type = case
        when target.source_type = 'google_sheet' and draft.source_type = 'excel' then target.source_type
        else draft.source_type
      end,
      google_sheet_id = case
        when draft.source_type = 'google_sheet' then draft.google_sheet_id
        else target.google_sheet_id
      end,
      google_sheet_tab = case
        when draft.source_type = 'google_sheet' then draft.google_sheet_tab
        else target.google_sheet_tab
      end,
      google_sheet_title = case
        when draft.source_type = 'google_sheet' then draft.google_sheet_title
        else target.google_sheet_title
      end,
      last_source_sync_at = case
        when draft.source_type = 'google_sheet' then now()
        else target.last_source_sync_at
      end,
      last_source_hash = case
        when draft.source_type = 'google_sheet' then draft.source_hash
        else target.last_source_hash
      end
  where id = target.id
  returning * into target;

  delete from public.dataset_imports where id = import_id;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profileCount', target.profile_count,
    'sourceType', target.source_type,
    'removedProfilesPreserved', removed_count
  );
end;
$$;

revoke all on function public.apply_dataset_sync(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_dataset_sync(uuid, uuid, uuid, boolean) to service_role;

commit;
