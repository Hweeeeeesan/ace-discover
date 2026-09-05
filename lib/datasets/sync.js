const FIELD_LABELS = Object.freeze({
  name: 'Name',
  role: 'Role',
  major: 'Major',
  majorGroup: 'Major area',
  year: 'Year',
  normalizedYear: 'Normalized year',
  socialLevel: 'Social level',
  socialStyle: 'Social style',
  school: 'School',
  program: 'Program',
  family: 'Family',
  bio: 'Profile story',
  interests: 'Interests',
  vibes: 'Vibes',
  hobbies: 'Hobbies',
  hobbyDetails: 'Hobby details',
  music: 'Music',
  movies: 'Movies & shows',
  perfectDay: 'Perfect day',
  tagline: 'Tagline',
  uniqueThings: 'Unique things',
  passion: 'Passion',
  idealHangout: 'Ideal hangout',
  bucketList: 'Bucket list',
  hotTake: 'Harmless hot take',
  instagram: 'Instagram',
  slideDeckUrl: 'Slide deck',
});

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedJson(value[key])]));
  }
  return value ?? null;
}

function valuesMatch(left, right) {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right));
}

function safeProfileSummary(publicData = {}) {
  return {
    id: String(publicData.id || ''),
    name: String(publicData.name || publicData.id || 'Unnamed profile'),
    role: String(publicData.role || ''),
  };
}

export function buildDatasetImportTargetFields(target = null) {
  if (target === null || target === undefined) {
    return {
      target_dataset_id: null,
      target_imported_at: null,
    };
  }

  const datasetId = target.datasetId ?? null;
  const importedAt = target.importedAt ?? null;
  if (!datasetId || !importedAt) {
    throw new Error('Dataset update previews require both the target dataset and its imported-at version.');
  }

  return {
    target_dataset_id: datasetId,
    target_imported_at: importedAt,
  };
}

export function buildDatasetSyncDiff(currentRows = [], incomingProfiles = []) {
  const currentById = new Map(currentRows.map((row) => [String(row.profile_id), row]));
  const incomingById = new Map(incomingProfiles.map((item) => [String(item?.public?.id || ''), item]));
  const added = [];
  const updated = [];
  const removed = [];

  for (const item of incomingProfiles) {
    const publicData = item?.public || {};
    const existing = currentById.get(String(publicData.id || ''));
    if (!existing) {
      added.push(safeProfileSummary(publicData));
      continue;
    }
    const fields = Object.entries(FIELD_LABELS)
      .filter(([key]) => !valuesMatch(existing.public_data?.[key], publicData[key]))
      .map(([, label]) => label);
    const driveSourceChanged = !valuesMatch(existing.drive_file_id || '', item.driveFileId || '')
      || !valuesMatch(existing.drive_folder_id || '', item.driveFolderId || '')
      || !valuesMatch(existing.image_kind || '', item.imageKind || '');
    if (driveSourceChanged) fields.push('Drive photo source (gallery preserved)');
    if (fields.length) updated.push({ ...safeProfileSummary(publicData), fields, driveSourceChanged });
  }

  for (const row of currentRows) {
    if (!incomingById.has(String(row.profile_id))) removed.push(safeProfileSummary(row.public_data));
  }

  return {
    counts: { added: added.length, updated: updated.length, removed: removed.length },
    added,
    updated,
    removed,
    hasChanges: Boolean(added.length || updated.length || removed.length),
  };
}

function increment(record, key, amount = 1) {
  record[key] = Number(record[key] || 0) + amount;
}

export function preserveMissingSourceProfiles(payload, currentRows, diff, currentSafeIssues = {}) {
  if (!diff.removed.length) return payload;
  const merged = structuredClone(payload);
  const removedIds = new Set(diff.removed.map((profile) => profile.id));
  const rows = currentRows.filter((row) => removedIds.has(String(row.profile_id)));
  const sourceTotalProfiles = Number(merged.health.totalProfiles || merged.profiles.length);

  for (const row of rows) {
    const publicData = row.public_data || {};
    merged.profiles.push({
      public: publicData,
      driveFileId: row.drive_file_id || '',
      driveFolderId: row.drive_folder_id || '',
      imageKind: row.image_kind || '',
      imageIssue: row.image_issue || '',
    });
    increment(merged.health.roleCounts, publicData.role || 'Unknown');
    if (publicData.instagram) merged.health.instagramCount += 1;
    if (publicData.slideDeckUrl) merged.health.slideDeckCount += 1;
    const imageKind = row.image_kind || 'missing';
    increment(merged.health.imageStatus.byKind, imageKind);
    if (row.storage_image_path || ['drive-file', 'drive-folder', 'direct-image-url'].includes(imageKind)) {
      merged.health.imageStatus.usable += 1;
    } else {
      merged.health.imageStatus.missingOrInvalid += 1;
    }
    for (const vibe of publicData.vibes || []) increment(merged.health.vibeDistribution, vibe);
    increment(merged.health.majorGroupDistribution, publicData.majorGroup || 'Other / Undeclared');
    increment(merged.health.socialLevelDistribution, [1, 2, 3, 4, 5].includes(publicData.socialLevel) ? String(publicData.socialLevel) : 'Missing / invalid');
    increment(merged.health.socialStyleDistribution, ['Introvert', 'Ambivert', 'Extrovert'].includes(publicData.socialStyle) ? publicData.socialStyle : 'Missing / unknown');
  }

  for (const [issue, profiles] of Object.entries(currentSafeIssues || {})) {
    if (!Array.isArray(merged.safeIssues[issue])) merged.safeIssues[issue] = [];
    if (merged.health.issues && !Array.isArray(merged.health.issues[issue])) merged.health.issues[issue] = [];
    const known = new Set(merged.safeIssues[issue].map((profile) => profile.id));
    for (const profile of profiles || []) {
      if (removedIds.has(String(profile.id)) && !known.has(String(profile.id))) {
        merged.safeIssues[issue].push(safeProfileSummary(profile));
        if (merged.health.issues && !merged.health.issues[issue].includes(String(profile.id))) {
          merged.health.issues[issue].push(String(profile.id));
        }
      }
    }
    if (merged.health.missingFieldCounts && issue in merged.health.missingFieldCounts) {
      merged.health.missingFieldCounts[issue] = merged.safeIssues[issue].length;
    }
  }

  merged.health.sourceTotalProfiles = sourceTotalProfiles;
  merged.health.preservedMissingSourceCount = rows.length;
  merged.health.totalProfiles = merged.profiles.length;
  return merged;
}

export function validateSyncApplyAcknowledgement(diff, acknowledged) {
  if (Number(diff?.counts?.removed || 0) > 0 && acknowledged !== true) {
    throw new Error('Acknowledge the profiles missing from the source before applying this update. They will be preserved.');
  }
}

export const PUBLIC_SYNC_FIELD_LABELS = FIELD_LABELS;
