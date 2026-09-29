-- Finalize provenance invariants after the legacy-row backfill committed.

begin;

alter table public.profile_images
  alter column source_type set not null,
  drop constraint if exists profile_images_source_type_valid,
  drop constraint if exists profile_images_drive_identity_complete,
  add constraint profile_images_source_type_valid check (
    source_type in ('google_drive', 'admin_upload', 'legacy_unknown', 'legacy_preserved')
  ),
  add constraint profile_images_drive_identity_complete check (
    (source_type = 'google_drive' and source_drive_file_id is not null)
    or (source_type <> 'google_drive' and source_drive_file_id is null and source_drive_folder_id is null)
  );

commit;
