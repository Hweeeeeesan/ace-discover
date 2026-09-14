-- Admin-only deterministic public-content QA dispositions. This migration is
-- intentionally not applied by the application.

begin;

create table if not exists public.profile_content_qa_dispositions (
  dataset_id uuid not null,
  profile_id text not null,
  field text not null check (field ~ '^[a-z][a-zA-Z0-9]{1,79}$'),
  rule text not null check (rule ~ '^[a-z][a-z0-9_]{1,79}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  disposition text not null check (disposition = 'keep_as_submitted'),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  primary key (dataset_id, profile_id, field, rule, source_hash),
  foreign key (dataset_id, profile_id)
    references public.dataset_profiles(dataset_id, profile_id) on delete cascade
);

create index if not exists profile_content_qa_dispositions_dataset_idx
  on public.profile_content_qa_dispositions(dataset_id, profile_id);

alter table public.profile_content_qa_dispositions enable row level security;

revoke all on public.profile_content_qa_dispositions from public, anon, authenticated;
grant select, insert, update, delete on public.profile_content_qa_dispositions to service_role;

commit;
