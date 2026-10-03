-- Distinguish removing the final image for replacement from intentionally
-- clearing a profile. The existing delete_profile_image RPC retains its
-- historical intentional-clear behavior for older callers.

begin;

create or replace function public.delete_profile_image_with_intent(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_image_id uuid,
  requested_intentionally_clear boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if requested_intentionally_clear is null then
    raise exception 'Final-image removal intent is required.';
  end if;

  -- The established RPC owns row locking, primary reassignment, compatibility
  -- metadata cleanup, and relational deletion. This wrapper changes only the
  -- durable intent recorded when that deletion leaves an empty gallery.
  result := public.delete_profile_image(
    requested_dataset_id,
    requested_profile_id,
    requested_image_id
  );

  if coalesce((result->>'remainingCount')::integer, -1) = 0
    and not requested_intentionally_clear then
    update public.dataset_profiles
    set image_cleared_by_admin = false
    where dataset_id = requested_dataset_id
      and profile_id = requested_profile_id;

    result := result
      || jsonb_build_object(
        'intentionallyCleared', false,
        'replacementAllowed', true
      );
  else
    result := result
      || jsonb_build_object(
        'intentionallyCleared', coalesce((result->>'intentionallyCleared')::boolean, false),
        'replacementAllowed', false
      );
  end if;

  return result;
end;
$$;

revoke all on function public.delete_profile_image_with_intent(uuid, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.delete_profile_image_with_intent(uuid, text, uuid, boolean)
  to service_role;

commit;
