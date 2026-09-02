begin;

alter table public.datasets
  add column if not exists deletion_pending boolean not null default false;

create or replace function public.protect_dataset_deletion_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.deletion_pending and new.status is distinct from old.status then
    raise exception 'A dataset being removed cannot change status.';
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'active' then
      raise exception 'The active dataset cannot be removed. Activate another dataset first.';
    end if;
    if not old.deletion_pending then
      raise exception 'Dataset deletion must be prepared before removal.';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists datasets_protect_deletion_state on public.datasets;
create trigger datasets_protect_deletion_state
before update of status or delete on public.datasets
for each row execute function public.protect_dataset_deletion_state();

create or replace function public.prepare_dataset_deletion(requested_dataset_id uuid)
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
  where id = requested_dataset_id
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;
  if target.status = 'active' or coalesce((
    select active_dataset_id = target.id
    from public.app_settings
    where singleton
  ), false) then
    raise exception 'The active dataset cannot be removed. Activate another dataset first.';
  end if;

  update public.datasets
  set deletion_pending = true
  where id = target.id
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

create or replace function public.cancel_dataset_deletion(requested_dataset_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.datasets
  set deletion_pending = false
  where id = requested_dataset_id
    and status <> 'active';
  return found;
end;
$$;

create or replace function public.delete_prepared_dataset(requested_dataset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
  stored_profile_count integer;
  stored_image_count integer;
begin
  insert into public.app_settings (singleton) values (true)
  on conflict (singleton) do nothing;

  perform 1 from public.app_settings where singleton for update;

  select * into target
  from public.datasets
  where id = requested_dataset_id
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;
  if target.status = 'active' or coalesce((
    select active_dataset_id = target.id
    from public.app_settings
    where singleton
  ), false) then
    raise exception 'The active dataset cannot be removed. Activate another dataset first.';
  end if;
  if not target.deletion_pending then
    raise exception 'Dataset deletion has not been prepared.';
  end if;

  select count(*) into stored_profile_count
  from public.dataset_profiles
  where dataset_id = target.id;

  select count(*) into stored_image_count
  from public.profile_images
  where dataset_id = target.id;

  delete from public.datasets where id = target.id;

  return jsonb_build_object(
    'id', target.id,
    'slug', target.slug,
    'name', target.name,
    'status', target.status,
    'profilesDeleted', stored_profile_count,
    'imageRowsDeleted', stored_image_count
  );
end;
$$;

revoke all on function public.protect_dataset_deletion_state() from public, anon, authenticated;
revoke all on function public.prepare_dataset_deletion(uuid) from public, anon, authenticated;
revoke all on function public.cancel_dataset_deletion(uuid) from public, anon, authenticated;
revoke all on function public.delete_prepared_dataset(uuid) from public, anon, authenticated;

grant execute on function public.prepare_dataset_deletion(uuid) to service_role;
grant execute on function public.cancel_dataset_deletion(uuid) to service_role;
grant execute on function public.delete_prepared_dataset(uuid) to service_role;

commit;
