import { classifyProfileImageSource } from './profile-image-ingestion.js';
import { isValidStorageImagePath } from './profile-images.js';

export function createMigrationSummary(totalProfiles) {
  return {
    totalProfiles,
    eligible: 0,
    alreadyMigrated: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };
}

function failureDetail(error) {
  return {
    category: error?.code || 'migration_error',
    detail: error instanceof Error ? error.message : String(error),
  };
}

export async function migrateDatasetProfiles({
  dataset,
  profiles,
  dryRun = true,
  ingest,
  persistPath,
  storagePathExists = async () => true,
  findExistingPath = async () => '',
  onRow = () => {},
}) {
  if (!dataset?.slug) throw new Error('A dataset slug is required.');
  if (!Array.isArray(profiles)) throw new Error('Dataset profiles must be an array.');
  const summary = createMigrationSummary(profiles.length);
  const rows = [];

  for (const profile of profiles) {
    const base = { profileId: profile.id || '', name: profile.name || profile.id || '' };
    const storedPath = String(profile.storageImagePath || '');
    if (storedPath) {
      if (!isValidStorageImagePath(storedPath)) {
        const row = { ...base, status: 'failed', category: 'malformed_storage_path', storagePath: storedPath, detail: 'The stored image path is malformed.' };
        summary.failed += 1;
        rows.push(row);
        onRow(row);
        continue;
      }
      if (!(await storagePathExists(storedPath))) {
        const row = { ...base, status: 'failed', category: 'missing_storage_object', storagePath: storedPath, detail: 'The canonical Storage object is missing.' };
        summary.failed += 1;
        rows.push(row);
        onRow(row);
        continue;
      }
      const row = { ...base, status: 'already_migrated', category: '', storagePath: storedPath, detail: 'A healthy canonical Storage image already exists.' };
      summary.alreadyMigrated += 1;
      rows.push(row);
      onRow(row);
      continue;
    }

    const source = classifyProfileImageSource(profile);
    if (!source.eligible) {
      const row = { ...base, status: 'skipped', category: source.category, storagePath: '', detail: source.detail };
      summary.skipped += 1;
      rows.push(row);
      onRow(row);
      continue;
    }
    summary.eligible += 1;

    try {
      const existingPath = await findExistingPath(profile);
      if (existingPath) {
        if (!isValidStorageImagePath(existingPath)) throw new Error('Storage returned a malformed existing primary image path.');
        if (!dryRun) await persistPath(profile, existingPath);
        const row = {
          ...base,
          status: dryRun ? 'dry_run_existing' : 'already_migrated',
          category: '',
          storagePath: existingPath,
          detail: dryRun ? 'Would attach the existing Storage object.' : 'Attached an existing Storage object without overwriting it.',
        };
        summary.alreadyMigrated += 1;
        rows.push(row);
        onRow(row);
        continue;
      }

      const result = await ingest(profile);
      if (!result?.storagePath || !isValidStorageImagePath(result.storagePath)) {
        throw new Error('Ingestion did not return a valid canonical Storage path.');
      }
      if (!dryRun) await persistPath(profile, result.storagePath);
      const row = {
        ...base,
        status: dryRun ? 'dry_run_validated' : 'uploaded',
        category: result.recoveryCategory
          ? `${result.recoveryCategory}_${dryRun ? 'validated' : 'uploaded'}`
          : '',
        storagePath: result.storagePath,
        detail: `${result.contentType}; ${result.byteLength} bytes`,
      };
      if (!dryRun) summary.uploaded += 1;
      rows.push(row);
      onRow(row);
    } catch (error) {
      const failure = failureDetail(error);
      const row = { ...base, status: 'failed', ...failure, storagePath: '' };
      summary.failed += 1;
      rows.push(row);
      onRow(row);
    }
  }

  return { summary, rows };
}
