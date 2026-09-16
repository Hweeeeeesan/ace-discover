-- Allow Admin to remove the final relational profile image. Keep the legacy
-- compatibility pointer synchronized so a deleted object cannot reappear as
-- stale public image metadata.

begin;

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
  next_primary public.profile_images;
begin
  select * into target from public.profile_images
  where id = requested_image_id
    and dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then raise exception 'Profile image was not found.'; end if;

  delete from public.profile_images where id = requested_image_id;

  if target.is_primary then
    select * into next_primary
    from public.profile_images
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id
    order by position, id
    limit 1
    for update;

    if found then
      update public.profile_images
      set is_primary = true
      where id = next_primary.id;

      update public.dataset_profiles
      set storage_image_path = next_primary.storage_path,
          public_data = jsonb_set(
            coalesce(public_data, '{}'::jsonb),
            '{storageImagePath}',
            to_jsonb(next_primary.storage_path),
            true
          )
      where dataset_id = requested_dataset_id
        and profile_id = requested_profile_id;
    else
      update public.dataset_profiles
      set storage_image_path = null,
          public_data = coalesce(public_data, '{}'::jsonb) - 'storageImagePath'
      where dataset_id = requested_dataset_id
        and profile_id = requested_profile_id;
    end if;
  end if;

  return jsonb_build_object(
    'id', target.id,
    'storagePath', target.storage_path,
    'wasPrimary', target.is_primary,
    'remainingCount', (
      select count(*) from public.profile_images
      where dataset_id = requested_dataset_id and profile_id = requested_profile_id
    )
  );
end;
$$;

revoke all on function public.delete_profile_image(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.delete_profile_image(uuid, text, uuid) to service_role;

commit;
