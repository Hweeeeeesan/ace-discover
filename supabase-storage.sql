-- Run this in the Supabase SQL editor if you prefer to create the bucket
-- manually instead of letting scripts/migrate-drive-images-to-supabase.mjs do it.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-images',
  'profile-images',
  true,
  26214400,
  array['image/*']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
