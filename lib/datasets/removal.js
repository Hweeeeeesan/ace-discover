const DATASET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATASET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STORAGE_PAGE_SIZE = 100;
const STORAGE_REMOVE_BATCH_SIZE = 100;
const MAX_STORAGE_ENTRIES = 20_000;

export class DatasetRemovalError extends Error {
  constructor(message, { status = 422, category = 'dataset_removal_failed' } = {}) {
    super(message);
    this.name = 'DatasetRemovalError';
    this.status = status;
    this.category = category;
  }
}

export function isValidDatasetId(value) {
  return DATASET_ID.test(String(value || ''));
}

export function isDatasetStoragePath(path, datasetSlug) {
  const slug = String(datasetSlug || '');
  if (!DATASET_SLUG.test(slug) || typeof path !== 'string') return false;
  const segments = path.split('/');
  return segments.length >= 2
    && segments[0] === slug
    && segments.slice(1).every((segment) => segment && segment !== '.' && segment !== '..' && !segment.includes('\\'));
}

function removalError(error, fallback, options) {
  if (error instanceof DatasetRemovalError) return error;
  return new DatasetRemovalError(error?.message || fallback, options);
}

function rpcError(error) {
  const message = String(error?.message || 'Dataset removal could not be prepared.');
  if (/not found/i.test(message)) {
    return new DatasetRemovalError('Dataset not found or already removed.', {
      status: 404,
      category: 'dataset_not_found',
    });
  }
  if (/active|live dataset/i.test(message)) {
    return new DatasetRemovalError('You cannot remove the active semester. Activate another semester first.', {
      status: 409,
      category: 'active_dataset',
    });
  }
  return new DatasetRemovalError(message, { category: 'database_prepare_failed' });
}

function storageEntryPath(directory, entry) {
  const name = String(entry?.name || '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new DatasetRemovalError('Storage returned an unsafe object name; no database rows were deleted.', {
      status: 502,
      category: 'unsafe_storage_listing',
    });
  }
  return `${directory}/${name}`;
}

function isStorageDirectory(entry) {
  return entry?.id == null && entry?.metadata == null;
}

export async function listDatasetStoragePaths(storage, datasetSlug) {
  const slug = String(datasetSlug || '');
  if (!DATASET_SLUG.test(slug)) {
    throw new DatasetRemovalError('The stored dataset slug is invalid; Storage cleanup was refused.', {
      category: 'invalid_dataset_slug',
    });
  }

  const directories = [slug];
  const visited = new Set();
  const paths = [];
  let entryCount = 0;

  while (directories.length) {
    const directory = directories.shift();
    if (visited.has(directory)) continue;
    visited.add(directory);

    for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
      const { data, error } = await storage.list(directory, {
        limit: STORAGE_PAGE_SIZE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) {
        throw new DatasetRemovalError(`Unable to enumerate Storage objects for ${slug}: ${error.message}`, {
          status: 502,
          category: 'storage_list_failed',
        });
      }

      const entries = Array.isArray(data) ? data : [];
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_STORAGE_ENTRIES) {
          throw new DatasetRemovalError(`Storage cleanup stopped after ${MAX_STORAGE_ENTRIES} entries; no database rows were deleted.`, {
            status: 422,
            category: 'storage_listing_too_large',
          });
        }
        const path = storageEntryPath(directory, entry);
        if (!isDatasetStoragePath(path, slug)) {
          throw new DatasetRemovalError('Storage returned an object outside the dataset prefix; cleanup was refused.', {
            status: 502,
            category: 'unsafe_storage_path',
          });
        }
        if (isStorageDirectory(entry)) directories.push(path);
        else paths.push(path);
      }

      if (entries.length < STORAGE_PAGE_SIZE) break;
    }
  }

  return paths;
}

async function cancelDeletionLease(supabase, datasetId) {
  const { error } = await supabase.rpc('cancel_dataset_deletion', {
    requested_dataset_id: datasetId,
  });
  return error?.message || '';
}

export async function removeDatasetWithStorage({
  supabase,
  datasetId,
  bucket = 'profile-images',
}) {
  if (!isValidDatasetId(datasetId)) {
    throw new DatasetRemovalError('Invalid dataset ID.', {
      status: 400,
      category: 'invalid_dataset_id',
    });
  }
  if (!supabase?.rpc || !supabase?.storage?.from) {
    throw new DatasetRemovalError('Dataset administration is not configured.', { status: 503 });
  }
  const normalizedDatasetId = String(datasetId).toLowerCase();

  const prepared = await supabase.rpc('prepare_dataset_deletion', {
    requested_dataset_id: normalizedDatasetId,
  });
  if (prepared.error) throw rpcError(prepared.error);

  const dataset = prepared.data;
  if (!dataset || String(dataset.id || '').toLowerCase() !== normalizedDatasetId || !DATASET_SLUG.test(String(dataset.slug || ''))) {
    throw new DatasetRemovalError('The deletion preparation response was invalid.', {
      status: 502,
      category: 'invalid_prepare_response',
    });
  }

  const storage = supabase.storage.from(bucket);
  let storagePaths;
  try {
    storagePaths = await listDatasetStoragePaths(storage, dataset.slug);
  } catch (error) {
    const cancelError = await cancelDeletionLease(supabase, normalizedDatasetId).catch((cancelFailure) => cancelFailure.message);
    const failure = removalError(error, 'Storage cleanup failed.', { status: 502, category: 'storage_cleanup_failed' });
    if (cancelError) failure.message += ` The deletion lock could not be released: ${cancelError}`;
    throw failure;
  }

  for (let index = 0; index < storagePaths.length; index += STORAGE_REMOVE_BATCH_SIZE) {
    const batch = storagePaths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE);
    if (batch.some((path) => !isDatasetStoragePath(path, dataset.slug))) {
      throw new DatasetRemovalError('An unsafe Storage removal batch was refused. The semester remains locked; retry removal after investigating the listing.', {
        category: 'unsafe_storage_path',
      });
    }
    const { data, error } = await storage.remove(batch);
    if (error || !Array.isArray(data) || data.length !== batch.length) {
      const sample = batch.slice(0, 3).join(', ');
      const detail = error?.message || `Storage confirmed only ${Array.isArray(data) ? data.length : 0} of ${batch.length} removals`;
      throw new DatasetRemovalError(`Storage cleanup failed for a batch containing ${sample}: ${detail}. The semester remains locked; retry Remove Semester to finish cleanup.`, {
        status: 502,
        category: 'storage_remove_failed',
      });
    }
  }

  const deleted = await supabase.rpc('delete_prepared_dataset', {
    requested_dataset_id: normalizedDatasetId,
  });
  if (deleted.error) {
    throw new DatasetRemovalError(
      `Storage cleanup completed, but database deletion failed: ${deleted.error.message}. Retry Remove Semester to finish cleanup.`,
      { status: 502, category: 'database_delete_failed' },
    );
  }

  return {
    ...deleted.data,
    storageObjectsDeleted: storagePaths.length,
  };
}
