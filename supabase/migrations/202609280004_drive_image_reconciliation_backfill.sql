-- Classify pre-provenance profile_images rows conservatively.
--
-- This is deliberately a DML-only transaction.  The UPDATE fires the
-- deferred profile_images_require_primary constraint trigger; no ALTER TABLE
-- follows it in this transaction.

begin;

update public.profile_images
set source_type = 'legacy_unknown'
where source_type is null;

commit;
