import 'server-only';

import {
  getDriveAuth,
  getDriveFileMetadata,
  listFilesInFolder,
} from './google-drive-server.js';
import { loadImageImportContext } from './profile-image-batch-server.js';
import {
  classifyDriveImageReconciliation,
  imageDifferenceStatus,
  IMAGE_DIFFERENCE_STATUSES,
} from './profile-image-reconciliation.js';

const CONCURRENCY = 3;

async function mapWithConcurrency(items, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

function isDriveBacked(profile) {
  return Boolean(profile.driveFolderId || profile.driveFileId);
}

function sourceError(profile, message) {
  return {
    profileId: profile.id,
    name: profile.name || profile.id,
    status: IMAGE_DIFFERENCE_STATUSES.SOURCE_ERROR,
    difference: false,
    reviewRequired: true,
    message,
    existingCount: profile.profileImages.length,
    supportedCount: null,
    newCount: null,
    missingCount: null,
    legacyCount: profile.profileImages.filter((image) => image.sourceType === 'legacy_unknown').length,
    unsupportedCount: null,
  };
}

function present(profile, reconciliation) {
  const status = imageDifferenceStatus(reconciliation);
  return {
    profileId: profile.id,
    name: profile.name || profile.id,
    status,
    difference: [
      IMAGE_DIFFERENCE_STATUSES.NEW_IN_DRIVE,
      IMAGE_DIFFERENCE_STATUSES.MISSING_FROM_DRIVE,
      IMAGE_DIFFERENCE_STATUSES.COUNT_MISMATCH,
    ].includes(status),
    reviewRequired: status !== IMAGE_DIFFERENCE_STATUSES.UP_TO_DATE,
    existingCount: reconciliation.existingCount,
    supportedCount: reconciliation.supportedCount,
    newCount: reconciliation.newCount,
    missingCount: reconciliation.missingFromDriveCount,
    legacyCount: reconciliation.legacyCount,
    unsupportedCount: reconciliation.unsupportedCount,
    state: reconciliation.state,
    message: '',
  };
}

async function driveFilesForProfile(profile, driveAuth) {
  if (profile.driveFolderId) return listFilesInFolder(profile.driveFolderId, driveAuth);
  if (profile.driveFileId) {
    const file = await getDriveFileMetadata(profile.driveFileId, driveAuth);
    return file ? [file] : [];
  }
  return [];
}

/**
 * Read-only dataset inventory. It enumerates current Drive metadata, compares
 * immutable IDs with profile_images provenance, and never writes gallery rows,
 * provenance, Storage objects, or source data.
 */
export async function scanDatasetImageDifferences(datasetId, options = {}) {
  const context = options.context || await loadImageImportContext(datasetId, undefined, {
    requireImportable: false,
  });
  const profiles = context.profiles.filter(isDriveBacked);
  let driveAuth;
  try {
    driveAuth = options.driveAuth || await getDriveAuth({ strict: true, serviceAccountOnly: true });
  } catch (error) {
    const scanned = profiles.map((profile) => sourceError(profile, error.message || 'Google Drive authentication failed.'));
    return summarize(context, scanned);
  }

  const scanned = await mapWithConcurrency(profiles, async (profile) => {
    if (!context.provenanceAvailable) {
      return sourceError(profile, 'Drive provenance migration is required before exact comparison.');
    }
    try {
      const driveFiles = await driveFilesForProfile(profile, driveAuth);
      const reconciliation = classifyDriveImageReconciliation({ profile, driveFiles });
      return present(profile, reconciliation);
    } catch (error) {
      return sourceError(profile, error.message || 'Drive source could not be compared.');
    }
  });
  return summarize(context, scanned);
}

function summarize(context, profiles) {
  const counts = Object.fromEntries(Object.values(IMAGE_DIFFERENCE_STATUSES).map((status) => [status, 0]));
  for (const profile of profiles) counts[profile.status] += 1;
  return {
    ok: true,
    readOnly: true,
    dataset: {
      id: context.dataset.id,
      slug: context.dataset.slug,
      name: context.dataset.name,
    },
    scannedAt: new Date().toISOString(),
    concurrency: CONCURRENCY,
    summary: {
      driveBacked: profiles.length,
      differences: profiles.filter((profile) => profile.difference).length,
      reviewRequired: profiles.filter((profile) => profile.reviewRequired).length,
      upToDate: counts[IMAGE_DIFFERENCE_STATUSES.UP_TO_DATE],
      newInDrive: counts[IMAGE_DIFFERENCE_STATUSES.NEW_IN_DRIVE],
      missingFromDrive: counts[IMAGE_DIFFERENCE_STATUSES.MISSING_FROM_DRIVE],
      countMismatch: counts[IMAGE_DIFFERENCE_STATUSES.COUNT_MISMATCH],
      legacyReview: counts[IMAGE_DIFFERENCE_STATUSES.LEGACY_REVIEW],
      sourceErrors: counts[IMAGE_DIFFERENCE_STATUSES.SOURCE_ERROR],
    },
    profiles,
  };
}
