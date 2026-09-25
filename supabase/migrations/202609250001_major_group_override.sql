-- Allow Admins to classify a profile's derived major category without changing
-- the imported major text. This migration is intentionally not applied by the
-- application; deploy it through the normal reviewed migration process.

begin;

create or replace function public.update_profile_public_overrides(
  requested_dataset_id uuid,
  requested_profile_id text,
  requested_overrides jsonb,
  expected_updated_at timestamptz,
  actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.dataset_profiles%rowtype;
  invalid_key text;
begin
  if jsonb_typeof(requested_overrides) <> 'object' then
    raise exception 'Public overrides must be an object.';
  end if;
  select key into invalid_key
  from jsonb_object_keys(requested_overrides) as key
  where key not in (
    'name', 'pronouns', 'year', 'major', 'instagram', 'hobbies', 'hobbyDetails',
    'music', 'movies', 'uniqueThings', 'tagline', 'majorGroup', 'passion', 'perfectDay',
    'idealHangout', 'bucketList', 'hotTake', 'bio', 'aceTraitSlideUrl', 'vibes'
  )
  limit 1;
  if invalid_key is not null then
    raise exception 'The field % cannot be overridden.', invalid_key;
  end if;
  if jsonb_typeof(requested_overrides->'vibes') = 'array'
     and jsonb_array_length(requested_overrides->'vibes') > 5 then
    raise exception 'Vibes must contain at most 5 items.';
  end if;
  if requested_overrides ? 'majorGroup'
     and (jsonb_typeof(requested_overrides->'majorGroup') <> 'string'
       or not (requested_overrides->>'majorGroup' = any (array[
         'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
         'Social Sciences', 'Arts, Media & Design', 'Education & Humanities',
         'Other / Undeclared'
       ]::text[]))) then
    raise exception 'majorGroup must be one of the canonical major groups.';
  end if;

  select * into target
  from public.dataset_profiles
  where dataset_id = requested_dataset_id
    and profile_id = requested_profile_id
  for update;
  if not found then
    raise exception 'Profile not found in the requested dataset.';
  end if;
  if target.public_overrides_updated_at is distinct from expected_updated_at then
    raise exception 'This profile was edited by someone else. Refresh and review the latest values.';
  end if;

  update public.dataset_profiles
  set public_overrides = requested_overrides,
      public_overrides_updated_at = case when requested_overrides = '{}'::jsonb then null else now() end,
      public_overrides_updated_by = case when requested_overrides = '{}'::jsonb then null else actor_id end
  where dataset_id = requested_dataset_id and profile_id = requested_profile_id;

  return jsonb_build_object(
    'profile', public.resolve_effective_public_data(target.public_data, requested_overrides),
    'publicOverrides', requested_overrides,
    'updatedAt', case when requested_overrides = '{}'::jsonb then null else now() end
  );
end;
$$;

revoke all on function public.update_profile_public_overrides(uuid, text, jsonb, timestamptz, uuid)
from public, anon, authenticated;
grant execute on function public.update_profile_public_overrides(uuid, text, jsonb, timestamptz, uuid)
to service_role;

commit;
