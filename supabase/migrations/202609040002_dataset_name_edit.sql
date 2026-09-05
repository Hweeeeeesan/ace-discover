-- Allow authorized Admin/Owner users to rename a dataset without changing its slug or contents.

begin;

create or replace function public.update_dataset_name(
  dataset_id_to_update uuid,
  requested_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.datasets%rowtype;
  normalized_name text := btrim(requested_name);
begin
  if char_length(normalized_name) not between 1 and 100 then
    raise exception 'Dataset name must be between 1 and 100 characters.';
  end if;

  select * into target
  from public.datasets
  where id = dataset_id_to_update
  for update;

  if not found then
    raise exception 'Dataset not found.';
  end if;

  update public.datasets
  set name = normalized_name
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

revoke all on function public.update_dataset_name(uuid, text) from public;
grant execute on function public.update_dataset_name(uuid, text) to service_role;

commit;
