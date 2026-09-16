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

export function createGalleryMigrationSummary(totalProfiles) {
  return {
    totalProfiles,
    eligible: 0,
    galleriesPreserved: 0,
    intentionallyCleared: 0,
    filesDiscovered: 0,
    supportedImages: 0,
    uploaded: 0,
    replaced: 0,
    rejected: 0,
    skipped: 0,
    failed: 0,
  };
}

function orderedImages(images) {
  return [...images].sort((left, right) => (
    Number(left?.position || 0) - Number(right?.position || 0)
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  ));
}

export function buildGalleryReplacementPlan(existingImages, replacementImages) {
  const existing = orderedImages(existingImages || []);
  const replacements = [...(replacementImages || [])];
  const preserveByPosition = existing.length === replacements.length && existing.length > 0;

  return {
    metadataStrategy: preserveByPosition ? 'preserve_by_position' : 'reset_to_defaults',
    expectedExistingImageIds: existing.map((image) => image.id),
    oldStoragePaths: existing.map((image) => image.storagePath),
    replacementRows: replacements.map((image, position) => {
      const prior = preserveByPosition ? existing[position] : null;
      return {
        imageId: image.imageId,
        storagePath: image.storagePath,
        position,
        isPrimary: prior ? Boolean(prior.isPrimary) : position === 0,
        focalX: prior?.focalX ?? null,
        focalY: prior?.focalY ?? null,
        displayMode: prior?.displayMode === 'portrait' ? 'portrait' : 'cover',
      };
    }),
  };
}

async function cleanupStoragePaths(paths, removeStorage) {
  const failures = [];
  for (const storagePath of paths) {
    try {
      await removeStorage(storagePath);
    } catch (error) {
      failures.push({ storagePath, detail: error?.message || String(error) });
    }
  }
  return failures;
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

/**
 * Migrate Drive sources into ordered relational galleries. Any existing
 * relational gallery (including Admin-created or previously migrated rows) is
 * authoritative and is never replaced or appended to automatically.
 */
export async function migrateDatasetProfileGalleries({
  dataset,
  profiles,
  dryRun = true,
  ingestGallery,
  createImage,
  createGallery,
  recheckGallery,
  replaceExisting = false,
  replaceGallery,
  removeStorage = async () => {},
  onRow = () => {},
}) {
  if (!dataset?.slug) throw new Error('A dataset slug is required.');
  if (!Array.isArray(profiles)) throw new Error('Dataset profiles must be an array.');
  if (typeof ingestGallery !== 'function') throw new Error('A gallery ingestion function is required.');
  const summary = createGalleryMigrationSummary(profiles.length);
  const rows = [];

  for (const profile of profiles) {
    const base = { profileId: profile.id || '', name: profile.name || profile.id || '' };
    const existingImages = Array.isArray(profile.profileImages) ? profile.profileImages : [];
    if (profile.imageClearedByAdmin === true && !replaceExisting) {
      const row = {
        ...base,
        status: 'gallery_preserved',
        category: 'intentionally_cleared',
        sourceKind: profile.driveFolderId ? 'folder' : profile.driveFileId ? 'file' : '',
        filesDiscovered: 0,
        supportedImages: 0,
        uploaded: 0,
        skippedExisting: 0,
        rejected: [],
        diagnostics: [],
        imageDimensions: [],
        primaryStoragePath: '',
        detail: 'The profile image was intentionally cleared by Admin; automatic missing-image import was skipped.',
      };
      summary.intentionallyCleared += 1;
      rows.push(row);
      onRow(row);
      continue;
    }
    if ((existingImages.length || profile.storageImagePath) && !replaceExisting) {
      const row = {
        ...base,
        status: 'gallery_preserved',
        category: existingImages.length ? 'existing_relational_gallery' : 'legacy_storage_image',
        sourceKind: profile.driveFolderId ? 'folder' : profile.driveFileId ? 'file' : '',
        filesDiscovered: 0,
        supportedImages: 0,
        uploaded: 0,
        skippedExisting: existingImages.length || 1,
        rejected: [],
        diagnostics: [],
        imageDimensions: [],
        primaryStoragePath: existingImages.find((image) => image.isPrimary)?.storagePath
          || profile.storageImagePath
          || existingImages[0]?.storagePath
          || '',
        detail: 'Existing relational/Admin-managed image metadata is authoritative; Drive import was not run.',
      };
      summary.galleriesPreserved += 1;
      rows.push(row);
      onRow(row);
      continue;
    }

    if (replaceExisting && existingImages.length === 0 && profile.imageClearedByAdmin !== true) {
      const row = {
        ...base,
        status: 'failed',
        category: 'replacement_requires_relational_gallery',
        sourceKind: profile.driveFolderId ? 'folder' : profile.driveFileId ? 'file' : '',
        filesDiscovered: 0,
        supportedImages: 0,
        uploaded: 0,
        skippedExisting: profile.storageImagePath ? 1 : 0,
        rejected: [],
        diagnostics: [],
        imageDimensions: [],
        primaryStoragePath: profile.storageImagePath || '',
        detail: 'Targeted replacement requires an existing relational profile_images gallery.',
      };
      summary.failed += 1;
      rows.push(row);
      onRow(row);
      continue;
    }

    const source = classifyProfileImageSource(profile);
    if (!source.eligible) {
      const row = {
        ...base,
        status: 'skipped',
        category: source.category,
        sourceKind: '',
        filesDiscovered: 0,
        supportedImages: 0,
        uploaded: 0,
        skippedExisting: 0,
        rejected: [],
        diagnostics: [],
        imageDimensions: [],
        primaryStoragePath: '',
        detail: source.detail,
      };
      summary.skipped += 1;
      rows.push(row);
      onRow(row);
      continue;
    }
    summary.eligible += 1;

    if (!dryRun && !replaceExisting && typeof recheckGallery === 'function') {
      try {
        if (await recheckGallery(profile)) {
          const row = {
            ...base,
            status: 'gallery_preserved',
            category: 'existing_relational_gallery_after_preview',
            sourceKind: profile.driveFolderId ? 'folder' : 'file',
            filesDiscovered: 0,
            supportedImages: 0,
            uploaded: 0,
            skippedExisting: 1,
            rejected: [],
            diagnostics: [],
            imageDimensions: [],
            primaryStoragePath: '',
            detail: 'A relational gallery was created after preview, so Drive import was skipped.',
          };
          summary.galleriesPreserved += 1;
          rows.push(row);
          onRow(row);
          continue;
        }
      } catch (error) {
        const failure = failureDetail(error);
        const row = {
          ...base,
          status: 'failed',
          ...failure,
          category: 'gallery_recheck_failure',
          sourceKind: profile.driveFolderId ? 'folder' : 'file',
          filesDiscovered: 0,
          supportedImages: 0,
          uploaded: 0,
          skippedExisting: 0,
          rejected: [],
          diagnostics: [],
          imageDimensions: [],
          primaryStoragePath: '',
          detail: `The current gallery state could not be verified safely: ${error?.message || error}`,
        };
        summary.failed += 1;
        rows.push(row);
        onRow(row);
        continue;
      }
    }

    try {
      const ingested = await ingestGallery(profile);
      const rejected = [...(ingested.rejected || [])];
      const diagnostics = [...(ingested.diagnostics || [])];
      const imageDimensions = (ingested.images || []).map((image) => ({
        driveFileId: image.resolvedDriveFileId || '',
        name: image.name || '',
        width: image.width,
        height: image.height,
        byteLength: image.byteLength,
        downloadSource: image.downloadSource || 'unspecified',
      }));
      const created = [];
      summary.filesDiscovered += Number(ingested.filesDiscovered || 0);
      summary.supportedImages += Number(ingested.supportedImages || 0);

      if (replaceExisting) {
        const replacementReady = Boolean(ingested.allSupportedValidated)
          && Number(ingested.supportedImages || 0) > 0
          && (ingested.images || []).length === Number(ingested.supportedImages || 0);
        const plan = buildGalleryReplacementPlan(existingImages, ingested.images || []);

        if (!replacementReady) {
          const cleanupFailures = dryRun
            ? []
            : await cleanupStoragePaths((ingested.images || []).map((image) => image.storagePath), removeStorage);
          diagnostics.push(...cleanupFailures.map((failure) => ({
            category: 'replacement_cleanup_failure',
            detail: `A staged replacement object could not be removed: ${failure.detail}`,
          })));
          const row = {
            ...base,
            status: 'replacement_failed_preserved',
            category: rejected[0]?.category || 'replacement_incomplete',
            sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
            filesDiscovered: Number(ingested.filesDiscovered || 0),
            supportedImages: Number(ingested.supportedImages || 0),
            uploaded: 0,
            skippedExisting: existingImages.length,
            rejected,
            diagnostics,
            imageDimensions,
            primaryStoragePath: existingImages.find((image) => image.isPrimary)?.storagePath
              || existingImages[0]?.storagePath
              || '',
            detail: 'Replacement was not complete, so the existing gallery and primary image were preserved.',
            metadataStrategy: plan.metadataStrategy,
          };
          summary.failed += 1;
          summary.rejected += rejected.length;
          rows.push(row);
          onRow(row);
          continue;
        }

        if (dryRun) {
          const row = {
            ...base,
            status: 'dry_run_replacement_validated',
            category: '',
            sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
            filesDiscovered: Number(ingested.filesDiscovered || 0),
            supportedImages: Number(ingested.supportedImages || 0),
            uploaded: 0,
            skippedExisting: existingImages.length,
            rejected,
            diagnostics,
            imageDimensions,
            primaryStoragePath: plan.replacementRows.find((image) => image.isPrimary)?.storagePath
              || plan.replacementRows[0]?.storagePath
              || '',
            detail: `${plan.replacementRows.length} replacement image${plan.replacementRows.length === 1 ? '' : 's'} validated; no Storage or database changes were made.`,
            metadataStrategy: plan.metadataStrategy,
          };
          summary.rejected += rejected.length;
          rows.push(row);
          onRow(row);
          continue;
        }

        try {
          if (typeof replaceGallery !== 'function') {
            throw new Error('A transactional gallery replacement function is required for apply mode.');
          }
          await replaceGallery({ profile, plan });
        } catch (error) {
          const cleanupFailures = error?.preserveStagedObjects
            ? []
            : await cleanupStoragePaths(
              (ingested.images || []).map((image) => image.storagePath),
              removeStorage,
            );
          const cleanupDetail = cleanupFailures.length
            ? ` ${cleanupFailures.length} staged Storage object(s) also could not be cleaned up.`
            : '';
          const row = {
            ...base,
            status: error?.preserveStagedObjects ? 'replacement_unconfirmed' : 'replacement_failed_preserved',
            category: error?.preserveStagedObjects
              ? 'metadata_replacement_unconfirmed'
              : 'metadata_replacement_failure',
            sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
            filesDiscovered: Number(ingested.filesDiscovered || 0),
            supportedImages: Number(ingested.supportedImages || 0),
            uploaded: 0,
            skippedExisting: existingImages.length,
            rejected,
            diagnostics,
            imageDimensions,
            primaryStoragePath: error?.preserveStagedObjects
              ? ''
              : existingImages.find((image) => image.isPrimary)?.storagePath
                || existingImages[0]?.storagePath
                || '',
            detail: error?.preserveStagedObjects
              ? `The transactional outcome could not be confirmed; staged objects were retained to avoid deleting a possibly active gallery. ${error?.message || error}`
              : `Transactional metadata replacement failed; the existing gallery remains authoritative. ${error?.message || error}${cleanupDetail}`,
            metadataStrategy: plan.metadataStrategy,
          };
          summary.failed += 1;
          rows.push(row);
          onRow(row);
          continue;
        }

        const oldCleanupFailures = await cleanupStoragePaths(plan.oldStoragePaths, removeStorage);
        diagnostics.push(...oldCleanupFailures.map((failure) => ({
          category: 'old_storage_cleanup_failure',
          detail: `Replaced metadata is healthy, but an old unreferenced Storage object could not be removed: ${failure.detail}`,
        })));
        const primaryStoragePath = plan.replacementRows.find((image) => image.isPrimary)?.storagePath
          || plan.replacementRows[0]?.storagePath
          || '';
        const row = {
          ...base,
          status: oldCleanupFailures.length ? 'replaced_with_cleanup_warnings' : 'replaced',
          category: '',
          sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
          filesDiscovered: Number(ingested.filesDiscovered || 0),
          supportedImages: Number(ingested.supportedImages || 0),
          uploaded: plan.replacementRows.length,
          skippedExisting: 0,
          rejected,
          diagnostics,
          imageDimensions,
          primaryStoragePath,
          detail: `${plan.replacementRows.length} image${plan.replacementRows.length === 1 ? '' : 's'} replaced transactionally; old Storage cleanup ran afterward.`,
          metadataStrategy: plan.metadataStrategy,
        };
        summary.uploaded += plan.replacementRows.length;
        summary.replaced += 1;
        summary.rejected += rejected.length;
        rows.push(row);
        onRow(row);
        continue;
      }

      if (!dryRun && typeof createGallery === 'function') {
        if ((ingested.images || []).length) {
          try {
            const galleryResult = await createGallery({
              profile,
              images: ingested.images || [],
            });
            if (galleryResult?.created === false) {
              const cleanupFailures = await cleanupStoragePaths(
                (ingested.images || []).map((image) => image.storagePath),
                removeStorage,
              );
              diagnostics.push(...cleanupFailures.map((failure) => ({
                category: 'concurrent_import_cleanup_failure',
                detail: `A staged Storage object could not be removed: ${failure.detail}`,
              })));
              const row = {
                ...base,
                status: cleanupFailures.length ? 'failed' : 'gallery_preserved',
                category: cleanupFailures.length
                  ? 'concurrent_import_cleanup_failure'
                  : 'existing_relational_gallery_after_upload',
                sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
                filesDiscovered: Number(ingested.filesDiscovered || 0),
                supportedImages: Number(ingested.supportedImages || 0),
                uploaded: 0,
                skippedExisting: 1,
                rejected,
                diagnostics,
                imageDimensions,
                primaryStoragePath: '',
                detail: cleanupFailures.length
                  ? 'Another process created the gallery, but one or more staged Storage objects could not be cleaned up.'
                  : 'Another process created the gallery first; staged Storage objects were removed and the existing gallery was preserved.',
              };
              if (cleanupFailures.length) summary.failed += 1;
              else summary.galleriesPreserved += 1;
              summary.rejected += rejected.length;
              rows.push(row);
              onRow(row);
              continue;
            }
            created.push(...(ingested.images || []).map((image) => ({ ...image, metadata: galleryResult })));
          } catch (error) {
            const cleanupFailures = error?.preserveStagedObjects
              ? []
              : await cleanupStoragePaths(
                (ingested.images || []).map((image) => image.storagePath),
                removeStorage,
              );
            diagnostics.push(...cleanupFailures.map((failure) => ({
              category: 'metadata_gallery_cleanup_failure',
              detail: `A staged Storage object could not be removed: ${failure.detail}`,
            })));
            const row = {
              ...base,
              status: error?.preserveStagedObjects ? 'gallery_create_unconfirmed' : 'failed',
              category: error?.preserveStagedObjects
                ? 'metadata_gallery_unconfirmed'
                : 'metadata_gallery_failure',
              sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
              filesDiscovered: Number(ingested.filesDiscovered || 0),
              supportedImages: Number(ingested.supportedImages || 0),
              uploaded: 0,
              skippedExisting: 0,
              rejected,
              diagnostics,
              imageDimensions,
              primaryStoragePath: '',
              detail: error?.preserveStagedObjects
                ? `The atomic gallery creation outcome could not be confirmed; staged objects were retained to avoid deleting active images. ${error?.message || error}`
                : `Atomic gallery creation failed and staged Storage objects were cleaned up. ${error?.message || error}`,
            };
            summary.failed += 1;
            summary.rejected += rejected.length;
            rows.push(row);
            onRow(row);
            continue;
          }
        }
      } else if (!dryRun) {
        if (typeof createImage !== 'function') throw new Error('A relational image creation function is required outside dry-run mode.');
        for (const image of ingested.images || []) {
          try {
            const metadata = await createImage({
              profile,
              image,
              makePrimary: created.length === 0,
            });
            created.push({ ...image, metadata });
          } catch (error) {
            let cleanupDetail = '';
            try {
              await removeStorage(image.storagePath);
            } catch (cleanupError) {
              cleanupDetail = ` Storage cleanup also failed: ${cleanupError?.message || cleanupError}`;
            }
            rejected.push({
              driveFileId: image.resolvedDriveFileId || '',
              name: image.name || '',
              category: 'metadata_insert_failure',
              detail: `${error?.message || 'The profile_images row could not be created.'}${cleanupDetail}`,
            });
          }
        }
      }

      const successful = dryRun ? (ingested.images || []) : created;
      summary.uploaded += dryRun ? 0 : successful.length;
      summary.rejected += rejected.length;
      const noImages = successful.length === 0;
      const row = {
        ...base,
        status: noImages ? 'failed' : dryRun ? 'dry_run_validated' : rejected.length ? 'uploaded_with_rejections' : 'uploaded',
        category: noImages
          ? (rejected[0]?.category || (ingested.sourceKind === 'folder' ? 'folder_no_images' : 'drive_download_failure'))
          : '',
        sourceKind: ingested.sourceKind || (profile.driveFolderId ? 'folder' : 'file'),
        filesDiscovered: Number(ingested.filesDiscovered || 0),
        supportedImages: Number(ingested.supportedImages || 0),
        uploaded: dryRun ? 0 : successful.length,
        skippedExisting: 0,
        rejected,
        diagnostics,
        imageDimensions,
        primaryStoragePath: successful[0]?.storagePath || '',
        detail: noImages
          ? 'No valid Drive image could be migrated for this profile.'
          : `${successful.length} image${successful.length === 1 ? '' : 's'} ${dryRun ? 'validated' : 'migrated'} in deterministic order.`,
      };
      if (noImages) summary.failed += 1;
      rows.push(row);
      onRow(row);
    } catch (error) {
      const failure = failureDetail(error);
      const row = {
        ...base,
        status: 'failed',
        ...failure,
        sourceKind: profile.driveFolderId ? 'folder' : 'file',
        filesDiscovered: 0,
        supportedImages: 0,
        uploaded: 0,
        skippedExisting: 0,
        rejected: [],
        diagnostics: [],
        imageDimensions: [],
        primaryStoragePath: '',
      };
      summary.failed += 1;
      rows.push(row);
      onRow(row);
    }
  }

  return { summary, rows };
}
