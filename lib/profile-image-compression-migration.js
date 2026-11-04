import {
  isOwnedProfileImageAssetSet,
  isValidDiscoveryStorageImagePath,
  isValidProfileDetailStorageImagePath,
  isValidStorageImagePath,
} from './profile-images.js';
import { sameImageSnapshot, sha256 } from './profile-image-compression.js';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function samePaths(row, paths) {
  return Boolean(row && paths) && row.storage_path === paths.canonical
    && (row.profile_storage_path || null) === (paths.profile || null)
    && (row.discovery_storage_path || null) === (paths.discovery || null);
}

export function sameImageMetadata(old, current) {
  return Boolean(current) && ['id', 'dataset_id', 'profile_id', 'position', 'is_primary',
    'focal_x', 'focal_y', 'display_mode', 'source_type', 'source_drive_file_id',
    'source_drive_folder_id', 'source_filename', 'source_modified_time', 'source_size']
    .concat(['profile_width', 'profile_height', 'profile_mime_type', 'profile_byte_length',
      'discovery_width', 'discovery_height', 'discovery_mime_type', 'discovery_byte_length'])
    .every((key) => (old[key] ?? null) === (current[key] ?? null));
}

export function planMigrationEntry(entry, config) {
  if (!entry || !UUID.test(entry.imageId || '') || !UUID.test(entry.datasetId || '')
    || entry.oldSnapshot?.id !== entry.imageId
    || entry.oldSnapshot?.dataset_id !== entry.datasetId
    || entry.oldSnapshot?.profile_id !== entry.profileId
    || !['validated', 'ready_for_migration'].includes(entry.status)
    || !HASH.test(entry.originalSha256 || '') || !HASH.test(entry.proposedSha256 || '')) {
    throw new Error('Candidate identity, validation, or hashes are incomplete.');
  }
  const old = entry.oldSnapshot;
  const oldPaths = { canonical: old.storage_path, profile: old.profile_storage_path || null,
    discovery: old.discovery_storage_path || null };
  if (!isValidStorageImagePath(oldPaths.canonical)
    || oldPaths.canonical.split('/')[0] !== entry.datasetSlug
    || oldPaths.canonical.split('/')[1] !== entry.profileId
    || Boolean(oldPaths.profile) !== Boolean(oldPaths.discovery)
    || entry.oldPaths?.canonical !== oldPaths.canonical
    || (entry.oldPaths?.profile || null) !== oldPaths.profile
    || (entry.oldPaths?.discovery || null) !== oldPaths.discovery) {
    throw new Error('Old asset paths do not match this image and dataset.');
  }
  if (!Number.isSafeInteger(entry.originalSize) || !Number.isSafeInteger(entry.proposedSize)
    || entry.originalSize <= entry.proposedSize || entry.proposedSize <= 0
    || !['jpeg', 'png'].includes(entry.originalFormat)
    || !['jpeg', 'webp'].includes(entry.proposedFormat)) throw new Error('Candidate size or format is invalid.');
  const rawNew = entry.newPaths;
  if (!rawNew || !UUID.test(rawNew.assetId || '')
    || !isValidStorageImagePath(rawNew.canonical)
    || !rawNew.canonical.startsWith(`${entry.datasetSlug}/${entry.profileId}/${rawNew.assetId}.`)
    || !rawNew.canonical.endsWith(entry.proposedFormat === 'jpeg' ? '.jpg' : '.webp')
    || rawNew.canonical === oldPaths.canonical) throw new Error('New canonical path is invalid.');
  const active = Boolean(oldPaths.profile);
  let profile = null, discovery = null, copiedDerivatives = false;
  if (active) {
    if (!isValidProfileDetailStorageImagePath(oldPaths.profile)
      || !isValidDiscoveryStorageImagePath(oldPaths.discovery)
      || !oldPaths.profile.startsWith(`${entry.datasetSlug}/${entry.profileId}/derived/`)
      || !oldPaths.discovery.startsWith(`${entry.datasetSlug}/${entry.profileId}/derived/`)) {
      throw new Error('Existing derivative paths are invalid.');
    }
    const rowIdentity = oldPaths.profile.endsWith(`/${entry.imageId}-profile.webp`)
      && oldPaths.discovery.endsWith(`/${entry.imageId}-discovery.webp`);
    if (rowIdentity) {
      profile = oldPaths.profile;
      discovery = oldPaths.discovery;
    } else {
      profile = rawNew.profile;
      discovery = rawNew.discovery;
      copiedDerivatives = true;
      if (!isOwnedProfileImageAssetSet({ datasetSlug: entry.datasetSlug,
        profileId: entry.profileId, imageId: entry.imageId, assetId: rawNew.assetId,
        storagePath: rawNew.canonical, profileStoragePath: profile,
        discoveryStoragePath: discovery })) throw new Error('New derivative asset identity is invalid.');
    }
  } else if (rawNew.profile || rawNew.discovery) {
    // The older dry run proposed unused derivative paths for no archived rows.
    throw new Error('Archived canonical-only images must remain canonical-only.');
  }
  if (!Number.isInteger(config?.jpegQuality) || !Number.isInteger(config?.webpQuality)
    || !Number.isFinite(config?.minSavingsPercent)) throw new Error('Compression settings are incomplete.');
  return { imageId: entry.imageId, datasetId: entry.datasetId, datasetSlug: entry.datasetSlug,
    profileId: entry.profileId, oldSnapshot: old, oldPaths,
    newPaths: { canonical: rawNew.canonical, profile, discovery },
    copiedDerivatives, originalSize: entry.originalSize, proposedSize: entry.proposedSize,
    originalSha256: entry.originalSha256, optimizedSha256: entry.proposedSha256,
    proposedFormat: entry.proposedFormat, settings: {
      jpegQuality: config.jpegQuality, webpQuality: config.webpQuality,
      minSavingsPercent: config.minSavingsPercent,
    }, savingsBytes: entry.originalSize - entry.proposedSize,
    reviewDirectory: entry.reviewDirectory || null };
}

export function approvalRequest(plan) {
  return { imageId: plan.imageId, datasetId: plan.datasetId, profileId: plan.profileId,
    originalSha256: plan.originalSha256, optimizedSha256: plan.optimizedSha256,
    settings: plan.settings, oldPaths: plan.oldPaths, newPaths: plan.newPaths };
}

export function isApproved(plan, approvals) {
  const approval = Array.isArray(approvals)
    ? approvals.find((item) => item?.imageId === plan.imageId) : null;
  if (!approval || approval.approved !== true || !approval.reviewedAt
    || Number.isNaN(Date.parse(approval.reviewedAt))) return false;
  const expected = approvalRequest(plan);
  return Object.entries(expected).every(([key, value]) => JSON.stringify(approval[key]) === JSON.stringify(value));
}

export async function applyOne(plan, approved, journal, adapters) {
  if (!approved) return { status: 'skipped', reason: 'Per-image visual approval is missing or stale.' };
  try {
  const row = await adapters.readRow(plan);
  if (samePaths(row, plan.newPaths)) {
    // The RPC may have committed before the local process saved its journal.
    if (journal.committedSnapshot
      ? !sameImageSnapshot(journal.committedSnapshot, row)
      : !sameImageMetadata(plan.oldSnapshot, row)) {
      return { status: 'conflicted', reason: 'Image metadata changed after the database switch.' };
    }
    journal.dbSwitchStatus = 'committed';
    journal.committedSnapshot = row;
    journal.status = 'applied';
  } else if (!sameImageSnapshot(plan.oldSnapshot, row)) {
    return { status: 'conflicted', reason: 'Image changed after planning.' };
  } else if (journal.dbSwitchStatus === 'committed') {
    return { status: 'conflicted', reason: 'Recorded migration was replaced or rolled back.' };
  }
  if (journal.dbSwitchStatus !== 'committed') {
    const assets = await adapters.prepareAssets(plan);
    if (!assets.length || assets[0].path !== plan.newPaths.canonical
      || assets[0].bytes.length !== plan.proposedSize
      || sha256(assets[0].bytes) !== plan.optimizedSha256) {
      return { status: 'failed', reason: 'Optimized bytes do not match approved manifest.' };
    }
    for (const asset of assets) {
      const existing = await adapters.readObject(asset.path);
      if (existing) {
        if (sha256(existing) !== sha256(asset.bytes)) return { status: 'conflicted', reason: 'Immutable destination has different bytes.' };
      } else {
        try { await adapters.upload(asset); } catch (error) {
          // An upload can succeed remotely and still return an uncertain error.
          const afterError = await adapters.readObject(asset.path);
          if (!afterError || sha256(afterError) !== sha256(asset.bytes)) return { status: 'failed', reason: `Upload failed: ${error.message}` };
        }
      }
      const confirmed = await adapters.readObject(asset.path);
      if (!confirmed || sha256(confirmed) !== sha256(asset.bytes)) return { status: 'failed', reason: 'Uploaded object verification failed.' };
      journal.uploads ||= {};
      journal.uploads[asset.path] = { status: 'verified', bytes: asset.bytes.length, sha256: sha256(asset.bytes) };
      await adapters.saveJournal(journal);
    }
    try {
      await adapters.swap(plan, plan.oldSnapshot, plan.newPaths, false);
    } catch (error) {
      const afterError = await adapters.readRow(plan);
      if (!samePaths(afterError, plan.newPaths) || !sameImageMetadata(plan.oldSnapshot, afterError)) {
        return { status: 'failed', reason: `Database swap failed: ${error.message}` };
      }
    }
    const switched = await adapters.readRow(plan);
    if (!samePaths(switched, plan.newPaths)) return { status: 'conflicted', reason: 'Database switch state is uncertain.' };
    journal.dbSwitchStatus = 'committed';
    journal.committedSnapshot = switched;
    journal.status = 'applied';
    await adapters.saveJournal(journal);
  }
  const verified = await adapters.verifyResolved(plan, journal.committedSnapshot);
  if (!verified) return { status: 'failed', reason: 'Post-switch resolution needs review.', rollbackAvailable: true };
  journal.postVerificationStatus = 'verified';
  journal.status = 'verified';
  await adapters.saveJournal(journal);
  return { status: 'verified', savingsBytes: plan.savingsBytes, rollbackAvailable: true };
  } catch (error) {
    return { status: journal.dbSwitchStatus === 'committed' ? 'rollback_required' : 'failed',
      reason: String(error), rollbackAvailable: journal.dbSwitchStatus === 'committed' };
  }
}

export async function rollbackOne(plan, journal, adapters) {
  try {
  if (!journal.committedSnapshot || journal.dbSwitchStatus !== 'committed') {
    return { status: 'skipped', reason: 'No committed migration is recorded.' };
  }
  const row = await adapters.readRow(plan);
  if (samePaths(row, plan.oldPaths)) {
    const original = await adapters.readObject(plan.oldPaths.canonical);
    if (!original || sha256(original) !== plan.originalSha256
      || !await adapters.verifyResolved({ ...plan, newPaths: plan.oldPaths }, row)) {
      return { status: 'failed', reason: 'Restored references need verification.' };
    }
    journal.status = 'rolled_back';
    journal.rollbackSnapshot = row;
    await adapters.saveJournal(journal);
    return { status: 'rolled_back' };
  }
  if (!sameImageSnapshot(journal.committedSnapshot, row)) {
    return { status: 'conflicted', reason: 'Image changed after migration.' };
  }
  const original = await adapters.readObject(plan.oldPaths.canonical);
  if (!original || sha256(original) !== plan.originalSha256) {
    return { status: 'failed', reason: 'Original canonical object is missing or changed.' };
  }
  for (const derivative of [plan.oldPaths.profile, plan.oldPaths.discovery].filter(Boolean)) {
    if (!await adapters.readObject(derivative)) return { status: 'failed', reason: 'Original derivative is missing.' };
  }
  try { await adapters.swap(plan, journal.committedSnapshot, plan.oldPaths, true); }
  catch (error) {
    const afterError = await adapters.readRow(plan);
    if (!samePaths(afterError, plan.oldPaths)) return { status: 'failed', reason: `Rollback RPC failed: ${error.message}` };
  }
  const restored = await adapters.readRow(plan);
  if (!samePaths(restored, plan.oldPaths) || !await adapters.verifyResolved({ ...plan, newPaths: plan.oldPaths }, restored)) {
    return { status: 'failed', reason: 'Rollback verification failed.' };
  }
  journal.status = 'rolled_back';
  journal.rollbackSnapshot = restored;
  await adapters.saveJournal(journal);
  return { status: 'rolled_back' };
  } catch (error) { return { status: 'failed', reason: String(error) }; }
}
