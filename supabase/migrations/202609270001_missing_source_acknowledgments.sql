-- Persist Admin review of profiles absent from the current import source.
-- This migration is intentionally not applied automatically.

begin;

create table if not exists public.dataset_profile_source_acknowledgments (
  dataset_id uuid not null,
  profile_id text not null,
  acknowledged_at timestamptz not null default now(),
  acknowledged_by uuid references auth.users(id) on delete set null,
  primary key (dataset_id, profile_id),
  constraint dataset_profile_source_ack_dataset_fk
    foreign key (dataset_id, profile_id)
    references public.dataset_profiles(dataset_id, profile_id)
    on delete cascade,
  constraint dataset_profile_source_ack_profile_id_check
    check (char_length(profile_id) between 1 and 160)
);

create index if not exists dataset_profile_source_ack_dataset_idx
  on public.dataset_profile_source_acknowledgments (dataset_id);

revoke all on table public.dataset_profile_source_acknowledgments from public, anon, authenticated;
grant select, insert, update, delete on table public.dataset_profile_source_acknowledgments to service_role;

create or replace function public.acknowledge_missing_source_profiles(
  requested_dataset_id uuid,
  requested_profile_ids text[],
  actor_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  acknowledged_count integer;
begin
  if requested_dataset_id is null
    or requested_profile_ids is null
    or coalesce(array_length(requested_profile_ids, 1), 0) = 0 then
    return 0;
  end if;

  insert into public.dataset_profile_source_acknowledgments (dataset_id, profile_id, acknowledged_by)
  select requested_dataset_id, profile_id, actor_id
  from unnest(requested_profile_ids) as requested(profile_id)
  where exists (
    select 1
    from public.dataset_profiles
    where dataset_id = requested_dataset_id
      and profile_id = requested.profile_id
  )
  on conflict (dataset_id, profile_id) do update
    set acknowledged_at = now(), acknowledged_by = excluded.acknowledged_by;

  get diagnostics acknowledged_count = row_count;
  return acknowledged_count;
end;
$$;

revoke all on function public.acknowledge_missing_source_profiles(uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.acknowledge_missing_source_profiles(uuid, text[], uuid) to service_role;

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

  -- Presence in a successfully applied source snapshot starts a new normal
  -- state; a later disappearance must require fresh review.
  delete from public.dataset_profile_source_acknowledgments acknowledgment
  where acknowledgment.dataset_id = target.id
    and exists (
      select 1
      from jsonb_array_elements(draft.normalized_profiles) as item(value)
      where item.value->'public'->>'id' = acknowledgment.profile_id
    );

  update public.datasets
  set profile_count = draft.profile_count,
      health = draft.health,
      safe_issues = draft.safe_issues,
      imported_at = now(),
      source_type = case
        when target.source_type = 'google_sheet' and draft.source_type = 'excel' then target.source_type
        else draft.source_type
      end,
      google_sheet_id = case when draft.source_type = 'google_sheet' then draft.google_sheet_id else target.google_sheet_id end,
      google_sheet_tab = case when draft.source_type = 'google_sheet' then draft.google_sheet_tab else target.google_sheet_tab end,
      google_sheet_title = case when draft.source_type = 'google_sheet' then draft.google_sheet_title else target.google_sheet_title end,
      last_source_sync_at = case when draft.source_type = 'google_sheet' then now() else target.last_source_sync_at end,
      last_source_hash = case when draft.source_type = 'google_sheet' then draft.source_hash else target.last_source_hash end
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
