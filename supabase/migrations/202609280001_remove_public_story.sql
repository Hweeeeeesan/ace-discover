-- Remove Profile Story, stored historically as bio (and sometimes story),
-- from public profile payloads and public overrides.
-- This migration is intentionally not applied automatically.

begin;

create or replace function public.resolve_effective_public_data(imported_data jsonb, overrides jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select (
    coalesce(imported_data, '{}'::jsonb) || coalesce(overrides, '{}'::jsonb)
  ) - 'story' - 'bio';
$$;

revoke all on function public.resolve_effective_public_data(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_effective_public_data(jsonb, jsonb) to service_role;

-- Remove only Profile Story keys. Other public fields, images, and source
-- metadata remain unchanged.
update public.dataset_profiles
set public_data = public_data - 'story' - 'bio',
    public_overrides = public_overrides - 'story' - 'bio'
where public_data ?| array['story', 'bio']
   or public_overrides ?| array['story', 'bio'];

alter table public.dataset_profiles
  drop constraint if exists dataset_profiles_public_overrides_no_profile_story,
  add constraint dataset_profiles_public_overrides_no_profile_story check (
    not (public_overrides ?| array['story', 'bio'])
  );

commit;
