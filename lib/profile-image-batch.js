import { classifyProfileImageSource } from './profile-image-ingestion.js';

const IMPORTABLE_DATASET_STATUSES = new Set(['active', 'ready']);
const READY_STATUSES = new Set(['dry_run_validated', 'uploaded', 'uploaded_with_rejections']);
const INACCESSIBLE_CATEGORIES = new Set([
  'credentials_missing',
  'drive_download_failure',
  'folder_inaccessible',
  'permission_denied_after_auth',
  'permission_fetch_failure',
]);

export function assertImageImportDataset(dataset) {
  if (!dataset?.id || !dataset?.slug) throw new Error('Dataset was not found.');
  if (!IMPORTABLE_DATASET_STATUSES.has(dataset.status)) {
    throw new Error('Archived datasets must be restored before importing profile images.');
  }
  return dataset;
}

export function profileNeedsImageImport(profile = {}) {
  const hasRelationalGallery = Array.isArray(profile.profileImages) && profile.profileImages.length > 0;
  if (hasRelationalGallery || profile.storageImagePath) return false;
  return classifyProfileImageSource(profile).eligible;
}

export function imageImportStatus(dataset, profiles = []) {
  assertImageImportDataset(dataset);
  return {
    dataset: { id: dataset.id, name: dataset.name, slug: dataset.slug },
    profilesScanned: profiles.length,
    profilesNeedingImport: profiles.filter(profileNeedsImageImport).length,
    profilesSkippedExistingGallery: profiles.filter((profile) => (
      (Array.isArray(profile.profileImages) && profile.profileImages.length > 0)
      || Boolean(profile.storageImagePath)
    )).length,
  };
}

function safeDimensions(row) {
  return (row.imageDimensions || []).map((image) => ({
    width: Number(image.width) || 0,
    height: Number(image.height) || 0,
  }));
}

function rejectedCount(row) {
  return Array.isArray(row.rejected) ? row.rejected.length : 0;
}

function isInaccessible(row) {
  return INACCESSIBLE_CATEGORIES.has(row.category)
    || (row.rejected || []).some((rejected) => INACCESSIBLE_CATEGORIES.has(rejected.category));
}

export function presentImageImportResult(dataset, migration, { dryRun }) {
  const eligibleRows = migration.rows.filter((row) => (
    READY_STATUSES.has(row.status)
    || row.status === 'failed'
    || row.status === 'gallery_create_unconfirmed'
  ));
  const readyRows = eligibleRows.filter((row) => READY_STATUSES.has(row.status));
  const failedRows = eligibleRows.filter((row) => !READY_STATUSES.has(row.status));
  const rejectedFiles = eligibleRows.reduce((count, row) => count + rejectedCount(row), 0);

  return {
    ok: true,
    mode: dryRun ? 'preview' : 'apply',
    dataset: { id: dataset.id, name: dataset.name, slug: dataset.slug },
    summary: {
      profilesScanned: migration.summary.totalProfiles,
      profilesNeedingImport: migration.summary.eligible,
      readyProfiles: readyRows.length,
      validImagesDiscovered: readyRows.reduce(
        (count, row) => count + (dryRun ? safeDimensions(row).length : Number(row.uploaded || 0)),
        0,
      ),
      rejectedFiles,
      inaccessibleSources: eligibleRows.filter(isInaccessible).length,
      profilesSkippedExistingGallery: migration.summary.galleriesPreserved,
      failedProfiles: failedRows.length,
      profilesImported: dryRun ? 0 : readyRows.length,
      imagesUploaded: dryRun ? 0 : migration.summary.uploaded,
    },
    profiles: eligibleRows.map((row) => ({
      id: row.profileId,
      name: row.name,
      status: READY_STATUSES.has(row.status) ? 'ready' : 'failed',
      imagesReady: dryRun ? safeDimensions(row).length : Number(row.uploaded || 0),
      rejectedFiles: rejectedCount(row),
      dimensions: safeDimensions(row),
      inaccessible: isInaccessible(row),
      message: READY_STATUSES.has(row.status)
        ? ''
        : 'The Drive source could not be imported. Check its access and supported image files.',
    })),
  };
}
