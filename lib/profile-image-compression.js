import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildDiscoveryDerivativeStoragePath,
  buildProfileDetailDerivativeStoragePath,
  buildProfileImageStoragePath,
  isOwnedProfileImageAssetSet,
  isValidStorageImagePath,
} from './profile-images.js';

export const COMPRESSION_STATUSES = Object.freeze([
  'pending', 'validated', 'skipped', 'failed', 'ready_for_migration',
]);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameImageSnapshot(expected, current) {
  return Boolean(current)
    && ['id', 'dataset_id', 'profile_id', 'storage_path', 'profile_storage_path',
      'discovery_storage_path', 'profile_width', 'profile_height', 'profile_mime_type',
      'profile_byte_length', 'discovery_width', 'discovery_height', 'discovery_mime_type',
      'discovery_byte_length', 'updated_at', 'position', 'is_primary', 'focal_x', 'focal_y',
      'display_mode', 'source_type', 'source_drive_file_id', 'source_drive_folder_id',
      'source_filename', 'source_modified_time', 'source_size']
      .every((key) => (expected[key] ?? null) === (current[key] ?? null));
}

export function canResumeCandidate(entry, current) {
  return Boolean(entry)
    && ['validated', 'ready_for_migration', 'skipped'].includes(entry.status)
    && sameImageSnapshot(entry.oldSnapshot, current);
}

export function proposedPaths({ datasetSlug, row, contentType, assetId = randomUUID() }) {
  const canonical = buildProfileImageStoragePath(datasetSlug, row.profile_id, assetId, contentType);
  const active = Boolean(row.profile_storage_path && row.discovery_storage_path);
  const profile = active ? buildProfileDetailDerivativeStoragePath(datasetSlug, row.profile_id, assetId) : null;
  const discovery = active ? buildDiscoveryDerivativeStoragePath(datasetSlug, row.profile_id, assetId) : null;
  if (!isValidStorageImagePath(canonical) || (active && !isOwnedProfileImageAssetSet({
    datasetSlug, profileId: row.profile_id, imageId: row.id, assetId,
    storagePath: canonical, profileStoragePath: profile, discoveryStoragePath: discovery,
  }))) throw new Error('Proposed paths fail image ownership validation.');
  return { assetId, canonical, profile, discovery };
}

export async function optimizeCanonical(bytes, {
  jpegQuality = 86, webpQuality = 90, minSavingsPercent = 10, allowPng = true,
} = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Empty canonical image.');
  if (![jpegQuality, webpQuality].every((quality) => Number.isInteger(quality) && quality >= 1 && quality <= 100)) {
    throw new Error('Quality must be an integer from 1 to 100.');
  }
  const original = await sharp(bytes, { failOn: 'error' }).metadata();
  const width = original.autoOrient?.width || original.width;
  const height = original.autoOrient?.height || original.height;
  const hasAlpha = Boolean(original.hasAlpha);
  const orientation = original.orientation || 1;
  if (!['srgb', 'rgb'].includes(original.space)) return { status: 'skipped', reason: 'Non-sRGB source needs color review',
    original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length } };
  let pipeline = sharp(bytes, { failOn: 'error' }).autoOrient();
  let contentType;
  if (original.format === 'jpeg') {
    contentType = 'image/jpeg';
    pipeline = pipeline.jpeg({ quality: jpegQuality, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' });
  } else if (original.format === 'png' && allowPng) {
    contentType = 'image/webp';
    pipeline = pipeline.webp({ quality: webpQuality, alphaQuality: 100, effort: 4, smartSubsample: true });
  } else {
    return { status: 'skipped', reason: original.format === 'png' ? 'PNG conversion disabled' : 'Format not targeted',
      original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length } };
  }
  const output = await pipeline.toBuffer();
  const optimized = await sharp(output, { failOn: 'error' }).metadata();
  const invalidReason = optimized.width !== width || optimized.height !== height
    ? 'Dimensions changed unexpectedly'
    : hasAlpha && !optimized.hasAlpha ? 'Alpha channel was not retained'
      : (optimized.orientation || 1) !== 1 ? 'Orientation changed unexpectedly' : '';
  if (invalidReason) return { status: 'skipped', reason: invalidReason,
    original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length },
    proposedBytes: output.length };
  if (hasAlpha) {
    const oldAlpha = await sharp(bytes).autoOrient().extractChannel('alpha').raw().toBuffer();
    const newAlpha = await sharp(output).extractChannel('alpha').raw().toBuffer();
    if (!oldAlpha.equals(newAlpha)) return { status: 'skipped', reason: 'Transparency pixels changed',
      original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length },
      proposedBytes: output.length };
  }
  const saving = bytes.length - output.length;
  const savingPercent = 100 * saving / bytes.length;
  if (saving <= 0 || savingPercent < minSavingsPercent) {
    return { status: 'skipped', reason: saving <= 0 ? 'Output is not smaller' : 'Savings below threshold',
      original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length },
      proposedBytes: output.length, savingPercent };
  }
  return {
    status: 'validated', bytes: output, contentType, sha256: sha256(output),
    original: { format: original.format, width, height, hasAlpha, orientation, bytes: bytes.length, sha256: sha256(bytes) },
    optimized: { format: optimized.format, width: optimized.width, height: optimized.height,
      hasAlpha: Boolean(optimized.hasAlpha), orientation: optimized.orientation || 1, bytes: output.length },
    saving, savingPercent,
  };
}

// This adapter is intentionally detached from Supabase. Tests exercise failure and
// rollback bookkeeping; the dry-run CLI never calls it.
export async function stageAssetSwap({ entry, upload, verify, compareAndSwap, verifyPublic }) {
  if (entry.status !== 'ready_for_migration') throw new Error('Visual approval is required.');
  const staged = [];
  let swapped = false;
  try {
    for (const asset of entry.newAssets) {
      await upload(asset);
      staged.push(asset.path);
      await verify(asset);
    }
    const updated = await compareAndSwap(entry.oldSnapshot, entry.newPaths);
    if (!updated) return { status: 'conflict', staged, rollback: { old: entry.oldSnapshot, next: entry.newPaths } };
    swapped = true;
    await verifyPublic(entry);
    return { status: 'migrated_retained_old', staged,
      rollback: { old: entry.oldSnapshot, next: entry.newPaths } };
  } catch (error) {
    return { status: swapped ? 'rollback_required' : 'failed', error: String(error), staged,
      rollback: { old: entry.oldSnapshot, next: entry.newPaths } };
  }
}
