-- ACE Discover v4 service-role Data API privileges.
-- Apply after 202608150001_ace_discover_v4_datasets.sql and
-- 202608150002_ace_discover_v4_hardening.sql.
-- RLS remains enabled; anon/authenticated retain no direct table access.

begin;

-- Admin list and READY preview reads.
grant select on table public.datasets to service_role;
grant select on table public.dataset_profiles to service_role;

-- Import preview creation uses INSERT ... SELECT (returning id/expires_at).
grant select, insert on table public.dataset_imports to service_role;

-- All app_settings and dataset/profile writes occur inside SECURITY DEFINER
-- functions, so no direct service_role table write grant is necessary.
-- No separate profiles table exists in the ACE Discover v4 schema or backend.

-- Reassert the private table boundary explicitly for the low-privilege roles.
revoke all on table public.datasets from anon, authenticated;
revoke all on table public.dataset_profiles from anon, authenticated;
revoke all on table public.app_settings from anon, authenticated;
revoke all on table public.dataset_imports from anon, authenticated;

-- Server-only administrative RPCs used by the Admin UI and seed/import tools.
grant execute on function public.cleanup_expired_dataset_imports() to service_role;
grant execute on function public.save_dataset_import(uuid, uuid) to service_role;
grant execute on function public.activate_dataset(uuid) to service_role;
grant execute on function public.set_dataset_status(uuid, text) to service_role;
grant execute on function public.seed_fall_2025_dataset(jsonb, jsonb, jsonb) to service_role;

commit;
