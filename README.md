# VSA Profile Discover — Discovery V2

A mobile-first Next.js profile discovery app generated from `FALL 25 MASTER APPS.xlsx`. This version adds search, role and advanced filters, stable randomized discovery, and state-preserving profile navigation while retaining the Google Drive and Supabase image system. The project is pinned to Next.js 16.3.0 and React 19.2.6.

## Included in this build

- 210 profiles imported from the workbook:
  - 123 Littles
  - 65 Bigs
  - 22 Family applicants
- 26 submitted slide-deck links
- Full-screen vertical discovery feed and individual profile pages
- Server-side Google Drive image proxy
- Automatic image fallback sequence
- Drive folder support when Google Drive credentials are configured
- Optional migration of accessible images to a public Supabase Storage bucket
- CSV image-link audit for fixing bad spreadsheet entries
- No phone numbers, emails, birthdays, payment answers, allergy information, or pairing-conflict responses in the public app bundle

## Run locally

If you already have the earlier folder, keep it as a backup and use this V2 folder as the new project root.

Install Node.js 20.9 or newer, open this folder in a terminal, and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How profile photos work

The importer classifies each spreadsheet image cell instead of treating every submitted value as an image.

### Individual Google Drive file links

A link such as:

```text
https://drive.google.com/file/d/FILE_ID/view
```

becomes:

```text
/api/drive-image?fileId=FILE_ID
```

The Next.js route retrieves the image on the server, sends it to the browser with cache headers, and prevents Google Drive preview HTML from being rendered as an image. The endpoint accepts only Drive IDs that were imported into a profile, so it cannot be used as a general proxy for other files accessible to the configured account. If the proxy fails, the browser tries a public Drive thumbnail and then the local placeholder.

Public files generally work without environment variables when their sharing setting is **Anyone with the link — Viewer**.

### Google Drive folder links

A folder link becomes:

```text
/api/drive-image?folderId=FOLDER_ID
```

The route searches the folder for a likely profile image. Folder traversal requires Google Drive API access. A service account is the recommended setup.

### Invalid image submissions

Google Docs, prose, blank values, and unsupported sharing pages use `/profile-placeholder.svg`. Review:

```text
reports/image-import-report.csv
```

The current workbook contains:

- 143 individual Drive file links
- 22 valid Drive folder links
- 45 links or values that need replacement, including one placeholder Drive folder ID, Google Docs/Photos, iCloud/TikTok sharing pages, local paths, text, and blanks

## Configure private Drive files and folders

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Create a service account and download its JSON key.
4. Share the Google Forms upload folder, or the relevant files/folders, with the service-account email as **Viewer**.
5. Copy `.env.example` to `.env.local`.
6. Add either the service-account email/private key or the full JSON value.

Example:

```dotenv
GOOGLE_SERVICE_ACCOUNT_EMAIL=profile-gallery@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Do not commit `.env.local` or any private key. `.env.example` also documents full-JSON, base64-JSON, refresh-token, and optional Workspace impersonation configurations.

If you temporarily keep a downloaded credential file in the project, place it under the gitignored `credentials/` directory and delete it after copying the required values into your environment. Never force-add credential files.

When deploying to Vercel, add the same values under **Project Settings → Environment Variables**. Redeploy after changing them.

## Permanently move Drive images to Supabase Storage

The proxy is convenient, but Supabase Storage is more stable for a production gallery. The included migration script:

1. reads `data/profiles.json`;
2. downloads accessible Drive images;
3. resolves Drive folder links when credentials are available;
4. validates that each response is an image;
5. uploads it to a public Supabase bucket;
6. places the Supabase CDN URL first in each profile’s fallback list;
7. regenerates `lib/profiles.js`.

### 1. Create a Supabase project

Copy `.env.example` to `.env.local`, then add:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=profile-images
```

The service-role key is secret and must never use a `NEXT_PUBLIC_` prefix. It is used only by the local migration script.

The script creates or updates the bucket automatically. Alternatively, run `supabase-storage.sql` in the Supabase SQL editor.

### 2. Validate a small sample

This downloads and validates five images without uploading:

```bash
npm run images:migrate -- --dry-run --limit 5
```

Test one specific profile:

```bash
npm run images:migrate -- --dry-run --profile aiden-wang
```

### 3. Upload and apply the URLs

```bash
npm run images:migrate -- --apply
```

The script writes:

```text
data/profiles.json
lib/profiles.js
reports/supabase-image-migration.csv
```

Before replacing data, it preserves one-time backups:

```text
data/profiles.json.before-supabase
lib/profiles.js.before-supabase
```

Profiles that cannot be downloaded keep their existing Drive proxy or placeholder, so a partial migration remains usable.

### 4. Build after migration

```bash
npm run build
npm run start
```

## Refresh from a newer Google Sheets export

Download the Google Sheet as `.xlsx`, then run from this project folder:

```bash
python3 scripts/import-master-apps.py \
  "/path/to/FALL 25 MASTER APPS.xlsx" \
  lib/profiles.js \
  reports/image-import-report.csv \
  data/profiles.json
```

Run the importer, public-data privacy checks, and Drive-route guard tests with:

```bash
npm test
```

The import command regenerates the spreadsheet snapshot, `lib/drive-image-allowlist.js`, the image audit, and the migration data. It also replaces any previously migrated Supabase URLs. Run the Supabase migration again after importing a newer workbook.

## Deploy to Vercel

1. Push this folder to a private GitHub repository.
2. Import the repository into Vercel.
3. Add Google Drive environment variables only when private files or folder links must work at runtime.
4. Deploy with the default Next.js settings.

Supabase image URLs require no runtime secret. Once migration is complete, the app can display those images directly from the public bucket.

## Important privacy note

This app presents application responses as public-facing profiles. Confirm that every participant consented to publication before deploying the gallery. The organizer-only `data/` and `reports/` folders are gitignored because they retain submitted image links for migration and troubleshooting; do not force-add them to Git. Keep the repository private as an additional safeguard because `lib/profiles.js` still contains the profile fields displayed by the public app.

## Discovery V2 controls

This build adds a stateful discovery layer without changing the spreadsheet format or database schema:

- fixed mobile toolbar with **All**, **Littles**, **Bigs**, **Family**, and **Deck** filters;
- live relevance-ranked search across names, majors, years, interests, hobbies, music, movies, and bios;
- advanced filters for year, major, program, and school;
- stable session-based shuffle, with role balancing to reduce repetitive runs;
- counters based on the active filtered result set;
- saved search, filters, shuffle order, active profile, and feed position when opening a detail page and returning;
- empty-result recovery controls and accessible keyboard/focus behavior.

The main discovery files are:

```text
components/DiscoveryFeed.js       state, persistence, active-card tracking
components/DiscoveryToolbar.js    search, role chips, shuffle, filter trigger
components/FilterSheet.js         advanced mobile filter sheet
components/ProfileCard.js         full-screen feed card
lib/discovery.js                  search scoring, filtering, option cleanup, seeded shuffle
app/globals.css                   discovery and detail-page styling
```

Profile information still comes from `lib/profiles.js`, which is regenerated by the spreadsheet importer. Editing the discovery files above will not be overwritten when profiles are re-imported.
