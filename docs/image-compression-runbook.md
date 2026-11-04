# ACE Discover image compression migration runbook

The local audit and migration CLIs require `.env.local` with the existing Supabase URL,
service-role key, and `profile-images` bucket. Reports and journals live under `reports/`
(ignored by Git). They contain profile identifiers and paths, but never credentials.
The CLI has no delete operation and no public endpoint. Keep its files on the operator's
machine and do not commit them.

## Generate a full compression manifest

```bash
npm run images:compression-audit -- --limit 0 --output reports/image-compression-full
```

This is read-only against Supabase and downloads every referenced canonical, so budget
roughly 1.4 GB of one-time egress plus derivative review reads. For a smaller pilot use
`--limit 24` or `--paths-file /absolute/path/paths.json`. Default settings are JPEG
mozjpeg quality 86, progressive; photographic PNG WebP quality 90; original dimensions.
Use `--jpeg-quality`, `--webp-quality`, and `--min-savings-percent` if needed. Re-running
with the same settings resumes completed entries and retries failures. The manifest stores
source and optimized SHA-256, exact paths, technical checks, and rollback references.

## Review and approve one image

Open `reports/image-compression-full/review.html`. Inspect full-resolution original and
optimized files at 100% zoom and compare proposed ProfileDetail and Discovery focal crop
previews with current derivatives. Check faces, skin, hair, text, transparency, color,
and artifacts. The previews use representative landscape and portrait frames; confirm
the final result in the application during the production pilot. PNG conversion is not
approved by a byte-saving threshold alone.

Run a read-only plan for the exact image ID:

```bash
npm run images:compression-migrate -- plan --manifest reports/image-compression-full/manifest.json --image-id IMAGE_UUID
```

The generated `migration-plan.json` contains `approvalRequests`. After visual review,
copy **only that image's exact request object** into a local JSON array, add
`"approved": true` and a real ISO `"reviewedAt"` timestamp, and save it as
`reports/image-compression-full/approvals.json`. This file is not a general approval:
the CLI checks the image ID, dataset/profile, original and optimized hashes, settings,
and every old and new path. A changed source or output invalidates it. No generic
approval flag exists.

## Read-only production preflight

```bash
npm run images:compression-migrate -- plan --manifest reports/image-compression-full/manifest.json --approval-file reports/image-compression-full/approvals.json --image-id IMAGE_UUID
npm run images:compression-migrate -- verify --manifest reports/image-compression-full/manifest.json --approval-file reports/image-compression-full/approvals.json --image-id IMAGE_UUID
npm run images:compression-migrate -- status --manifest reports/image-compression-full/manifest.json --approval-file reports/image-compression-full/approvals.json
```

`plan` and `verify` compare the row, source and optimized hashes and metadata,
derivative existence, primary fallback, and visual approval. They enumerate current Storage objects and report
planned upload size, one-set peak, and estimated download egress. They make **no**
Supabase writes. Upload permission is explicitly **unverified** because a read-only
request cannot establish it. Check the Supabase dashboard's current quota/restriction
state before apply. If uploads are blocked, stop and arrange allowed temporary capacity.
Never overwrite live objects to bypass the Free quota. Run small sequential batches;
the CLI supports one explicit image per apply invocation.

## Apply the guarded SQL migration later

The unapplied file is `supabase/migrations/202611030001_guarded_image_compression_swap.sql`.
After separately approved deployment, apply **only that reviewed file** through the
Supabase SQL Editor or an operator-controlled Postgres connection, for example:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202611030001_guarded_image_compression_swap.sql
```

Do not run `supabase db push` merely for this pilot if it would apply unrelated pending
migrations. The function is granted only to `service_role`. It locks the exact image row,
compares all old paths, `updated_at`, gallery state, and provenance, then atomically
switches paths and the primary fallback. The same guarded function supports rollback.
The seven stale Fall 2025 fallback paths are intentionally rejected and require a
separate guarded repair.

## Single-image apply, verification, and resume

Only after image-level approval, SQL application, and capacity confirmation:

```bash
npm run images:compression-migrate -- apply --manifest reports/image-compression-full/manifest.json --approval-file reports/image-compression-full/approvals.json --image-id IMAGE_UUID --execute --confirm-image-id IMAGE_UUID --accept-unverified-capacity
npm run images:compression-migrate -- status --manifest reports/image-compression-full/manifest.json --image-id IMAGE_UUID
```

Apply re-reads the exact row and original hash, validates approved optimized bytes,
uploads immutable paths with `upsert:false`, downloads them to verify SHA-256, invokes
the guarded RPC, checks the public URLs and database state, and atomically updates
`migration-journal.json` after each step. It never deletes old objects. For the usual
row-ID derivatives it changes only the canonical path. For replacement-ID derivatives
it copies existing derivative bytes to new compatible UUID paths without re-encoding.
Archived rows receive a canonical path only.

If interrupted after upload, re-run the **same** apply command: matching immutable
objects are verified and reused. If interrupted after the RPC commit, the CLI recognizes
the new row state and completes verification without another swap. A different object
at a planned destination, changed Admin row, or uncertain state is a conflict. Do not
retry with a new manifest until the journal and live row are reconciled. Open the public
profile and Admin image view after success. Active images with retained derivatives keep
their public URLs. For changed derivative or archived canonical URLs, old assets remain
available while bounded public ISR refreshes; cache invalidation is never issued before
the database switch.

## Guarded rollback

```bash
npm run images:compression-migrate -- rollback --manifest reports/image-compression-full/manifest.json --image-id IMAGE_UUID --execute --confirm-image-id IMAGE_UUID
```

Rollback checks the committed row snapshot, old canonical hash, and old derivatives.
It rejects any newer Admin edit, atomically restores old references, verifies resolution,
and retains both asset sets. Re-running after an interrupted rollback verifies the old
references and records `rolled_back`. No Storage deletion occurs.

## Orphans and actual Storage reduction

The audit writes `orphan-candidates.json` and `archived-fallback-candidates.json` as
**separate read-only reports**. Before any independent cleanup approval, regenerate
the reports and compare every candidate against current gallery paths, primary
fallbacks, public data, overrides, and public resolution. Do not delete objects from
the compression CLI. The six Cindy Lei candidates and seven archived fallback repairs
are not part of apply or rollback.

Apply temporarily **increases** Storage because old objects remain. `status` reports
new uploaded bytes as actual Storage delta and proposed net savings separately.
Measure real reduction only after a separately approved cleanup and a fresh
`plan`/Storage inventory. Supabase's billing-period GB-hour average will lag the
current object total. Do not claim a 1 GB result from a completed reference switch
alone.
