'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import FocalPointEditor from './FocalPointEditor';

async function postAction(body) {
  const response = await fetch('/api/admin/datasets/images/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The image action failed.');
  return payload;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return 'Unknown size';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'Unknown date';
}

export default function AdminImageManager({
  datasetId,
  datasetSlug,
  profileId,
  images = [],
  imageClearedByAdmin = false,
  driveFolderId = '',
  driveFileId = '',
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [makePrimary, setMakePrimary] = useState(false);
  const [error, setError] = useState('');
  const [sourceHealth, setSourceHealth] = useState(null);
  const [healthError, setHealthError] = useState('');
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [reconciliation, setReconciliation] = useState(null);
  const [selectedDriveIds, setSelectedDriveIds] = useState([]);
  const [legacySelections, setLegacySelections] = useState({});
  const [reconciling, setReconciling] = useState(false);
  const [restorationPreview, setRestorationPreview] = useState(null);
  const [selectedRestorationIds, setSelectedRestorationIds] = useState([]);
  const [restoring, setRestoring] = useState(false);
  const imagesById = new Map(images.map((image) => [image.id, image]));

  function reconciliationHealth(payload) {
    return {
      state: payload.state === 'new_images' || payload.state === 'legacy_review' ? 'needs_import' : payload.state,
      label: payload.label,
      summary: payload.summary,
      detail: payload.missingFromDriveCount
        ? `${payload.missingFromDriveCount} tracked gallery image${payload.missingFromDriveCount === 1 ? ' is' : 's are'} no longer present in Drive and will be preserved.`
        : 'Drive reconciliation never removes or reorders existing gallery images.',
      displayedFrom: { label: images.length ? 'Supabase relational gallery' : 'No relational gallery' },
      storageGallery: { label: `${payload.existingCount} relational image${payload.existingCount === 1 ? '' : 's'}` },
      driveSource: { label: driveFolderId ? `Folder · ${payload.supportedCount} supported` : driveFileId ? 'File' : 'None' },
      focalMessage: 'Existing presentation metadata remains unchanged.',
    };
  }

  async function checkSourceHealth() {
    setCheckingHealth(true);
    setHealthError('');
    try {
      if (images.length > 0 && (driveFolderId || driveFileId)) {
        const response = await fetch('/api/admin/datasets/images/reconcile/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ datasetId, profileId }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Drive reconciliation could not be checked.');
        setReconciliation(payload);
        setSelectedDriveIds(payload.newCandidates?.map((file) => file.id) || []);
        setSourceHealth(reconciliationHealth(payload));
        return;
      }
      const response = await fetch('/api/admin/datasets/images/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, profileId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Image source health could not be checked.');
      setSourceHealth(payload.profile?.health || null);
    } catch (healthCheckError) {
      setHealthError(healthCheckError.message);
    } finally {
      setCheckingHealth(false);
    }
  }

  useEffect(() => {
    checkSourceHealth();
    // A refreshed gallery receives a new image count and should be classified again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, profileId, images.length]);

  async function reviewLegacy(imageId, preserveAsLegacy = false) {
    const driveFileIdForImage = legacySelections[imageId] || '';
    if (!preserveAsLegacy && !driveFileIdForImage) {
      setHealthError('Choose the matching Drive file first.');
      return;
    }
    const message = preserveAsLegacy
      ? 'Confirm this existing image is not represented by a current Drive file? The image and all presentation settings will remain unchanged.'
      : 'Attach this Drive identity to the existing gallery image? Only provenance metadata will change.';
    if (!window.confirm(message)) return;
    setReconciling(true);
    setHealthError('');
    try {
      const response = await fetch('/api/admin/datasets/images/reconcile/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          profileId,
          imageId,
          driveFileId: driveFileIdForImage,
          preserveAsLegacy,
          confirm: true,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Drive identity review failed.');
      await checkSourceHealth();
      router.refresh();
    } catch (reviewError) {
      setHealthError(reviewError.message);
    } finally {
      setReconciling(false);
    }
  }

  async function appendSelectedDriveImages() {
    if (!selectedDriveIds.length) return;
    if (!window.confirm(`Append ${selectedDriveIds.length} new Drive image${selectedDriveIds.length === 1 ? '' : 's'}? Existing gallery images and presentation settings will be preserved.`)) return;
    setReconciling(true);
    setHealthError('');
    try {
      const response = await fetch('/api/admin/datasets/images/reconcile/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, profileId, driveFileIds: selectedDriveIds, confirm: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Drive images could not be appended.');
      setReconciliation(null);
      setSelectedDriveIds([]);
      router.refresh();
    } catch (applyError) {
      setHealthError(applyError.message);
    } finally {
      setReconciling(false);
    }
  }

  async function previewSourceRestoration() {
    setRestoring(true);
    setHealthError('');
    try {
      const response = await fetch('/api/admin/datasets/images/restore/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, profileId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The source image could not be previewed.');
      setRestorationPreview(payload);
      setSelectedRestorationIds(payload.candidates?.map((candidate) => candidate.driveFileId) || []);
    } catch (previewError) {
      setHealthError(previewError.message);
    } finally {
      setRestoring(false);
    }
  }

  async function applySourceRestoration() {
    if (!selectedRestorationIds.length) return;
    if (!window.confirm(`Restore ${selectedRestorationIds.length} selected source image${selectedRestorationIds.length === 1 ? '' : 's'}? This will create a new gallery and clear the intentional-clear state only after the image transaction succeeds.`)) return;
    setRestoring(true);
    setHealthError('');
    try {
      const response = await fetch('/api/admin/datasets/images/restore/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          profileId,
          driveFileIds: selectedRestorationIds,
          confirm: true,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The selected source image could not be restored.');
      setRestorationPreview(null);
      setSelectedRestorationIds([]);
      router.refresh();
    } catch (restoreError) {
      setHealthError(restoreError.message);
    } finally {
      setRestoring(false);
    }
  }

  async function refreshAfter(task) {
    setError('');
    try {
      await task();
      router.refresh();
    } catch (actionError) {
      setError(actionError.message);
    }
  }

  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.set('datasetId', datasetId);
      form.set('profileId', profileId);
      form.set('makePrimary', String(makePrimary));
      form.set('file', file);
      const response = await fetch('/api/admin/datasets/images', { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The image could not be added.');
      router.refresh();
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  }

  function setPrimary(imageId) {
    return refreshAfter(() => postAction({ datasetId, datasetSlug, profileId, action: 'set-primary', imageId }));
  }

  function remove(imageId, intentionallyClear = false) {
    const message = images.length === 1
      ? intentionallyClear
        ? 'Intentionally clear this profile? Automatic imports will remain blocked until an Admin explicitly restores an image.'
        : 'Remove the last image for replacement? The gallery will be empty, but future Admin/source imports will remain allowed.'
      : 'Remove this profile image?';
    if (!window.confirm(message)) return Promise.resolve();
    return refreshAfter(() => postAction({
      datasetId,
      datasetSlug,
      profileId,
      action: 'delete',
      imageId,
      intentionallyClear,
    }));
  }

  function move(imageIndex, direction) {
    const nextIndex = imageIndex + direction;
    if (nextIndex < 0 || nextIndex >= images.length) return;
    const imageIds = images.map((image) => image.id);
    [imageIds[imageIndex], imageIds[nextIndex]] = [imageIds[nextIndex], imageIds[imageIndex]];
    return refreshAfter(() => postAction({ datasetId, datasetSlug, profileId, action: 'reorder', imageIds }));
  }

  function rotate(imageId, direction) {
    return refreshAfter(() => postAction({ datasetId, datasetSlug, profileId, action: direction === 'left' ? 'rotate-left' : 'rotate-right', imageId }));
  }

  return (
    <section className="admin-image-manager" aria-labelledby="admin-image-manager-title">
      <div className="admin-image-manager-heading">
        <div>
          <p className="eyebrow dark">Admin image management</p>
          <h2 id="admin-image-manager-title">Profile images</h2>
          <p>Add, order, and tune the images used by this profile. Discovery continues to use only the primary image.</p>
        </div>
        <label className="admin-image-upload-button">
          <span>{uploading ? 'Adding…' : '+ Add image'}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" onChange={upload} disabled={uploading} />
        </label>
      </div>
      <label className="admin-image-primary-upload"><input type="checkbox" checked={makePrimary} onChange={(event) => setMakePrimary(event.target.checked)} /> Make the next upload primary</label>
      <section className={`admin-image-source-health state-${sourceHealth?.state || 'checking'}`} aria-label="Image source health">
        <div className="admin-image-source-health-heading">
          <div>
            <span>Image source status</span>
            <strong>{sourceHealth?.label || (checkingHealth ? 'Checking…' : 'Unavailable')}</strong>
          </div>
          <button type="button" onClick={checkSourceHealth} disabled={checkingHealth}>
            {checkingHealth ? 'Checking…' : 'Re-check source'}
          </button>
        </div>
        {sourceHealth && (
          <>
            <p><strong>{sourceHealth.summary}</strong> {sourceHealth.detail}</p>
            <dl>
              <div><dt>Displayed from</dt><dd>{sourceHealth.displayedFrom.label}</dd></div>
              <div><dt>Storage gallery</dt><dd>{sourceHealth.storageGallery.label}</dd></div>
              <div><dt>Drive source</dt><dd>{sourceHealth.driveSource.label}</dd></div>
            </dl>
            <div className="admin-image-source-health-actions">
              {images.length > 0
                ? <a href="#admin-image-manager-grid">Manage existing gallery</a>
                : sourceHealth.canPreviewImport
                  ? <Link href={`/admin?dataset=${encodeURIComponent(datasetId)}#dataset-image-source-health`}>Preview image import</Link>
                  : null}
            </div>
          </>
        )}
        {healthError && <p className="admin-image-source-health-error" role="alert">{healthError}</p>}
      </section>
      {images.length > 0 && driveFolderId && (
        <section className="admin-drive-reconciliation" aria-labelledby="admin-drive-reconciliation-title">
          <div className="admin-drive-reconciliation-heading">
            <div>
              <h3 id="admin-drive-reconciliation-title">Drive gallery reconciliation</h3>
              <p>Check the current folder and append only images with new, reviewed Drive identities.</p>
            </div>
            <button type="button" onClick={checkSourceHealth} disabled={checkingHealth || reconciling}>
              {checkingHealth ? 'Checking…' : 'Check Drive for new images'}
            </button>
          </div>
          {reconciliation?.state === 'legacy_review' && (
            <div className="admin-drive-legacy-review">
              <strong>Existing gallery predates Drive source tracking.</strong>
              <p>Match each legacy image to its Drive file, or mark it as a preserved non-Drive image. Nothing about the image presentation changes.</p>
              {reconciliation.legacyImages.map((legacyImage) => (
                <div className="admin-drive-legacy-row" key={legacyImage.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagesById.get(legacyImage.id)?.src} alt="" />
                  <span>Existing image {legacyImage.position + 1}{legacyImage.isPrimary ? ' · Primary' : ''}</span>
                  <select
                    aria-label={`Drive match for image ${legacyImage.position + 1}`}
                    value={legacySelections[legacyImage.id] || ''}
                    onChange={(event) => setLegacySelections((current) => ({ ...current, [legacyImage.id]: event.target.value }))}
                  >
                    <option value="">Choose matching Drive file</option>
                    {reconciliation.reviewDriveFiles.map((file) => (
                      <option value={file.id} key={file.id}>{file.name} · {formatBytes(file.size)}</option>
                    ))}
                  </select>
                  <button type="button" disabled={reconciling} onClick={() => reviewLegacy(legacyImage.id)}>Confirm match</button>
                  <button type="button" disabled={reconciling} onClick={() => reviewLegacy(legacyImage.id, true)}>Not in current Drive folder</button>
                </div>
              ))}
              <div className="admin-drive-file-grid">
                {reconciliation.reviewDriveFiles.map((file) => (
                  <figure key={file.id}>
                    {/* This URL is Admin-authorized and verifies direct folder ownership server-side. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file.thumbnailUrl} alt="" loading="lazy" />
                    <figcaption><strong>{file.name}</strong><span>{formatBytes(file.size)} · {formatDate(file.modifiedTime)}</span></figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
          {reconciliation?.state === 'new_images' && (
            <div className="admin-drive-new-images">
              <strong>{reconciliation.newCount} new Drive image{reconciliation.newCount === 1 ? '' : 's'} found</strong>
              <p>{reconciliation.existingCount} existing gallery images will remain unchanged. Selected images will be appended after the current last position.</p>
              <div className="admin-drive-file-grid">
                {reconciliation.newCandidates.map((file) => (
                  <label key={file.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file.thumbnailUrl} alt="" loading="lazy" />
                    <span><input
                      type="checkbox"
                      checked={selectedDriveIds.includes(file.id)}
                      onChange={(event) => setSelectedDriveIds((current) => event.target.checked
                        ? [...new Set([...current, file.id])]
                        : current.filter((id) => id !== file.id))}
                    /> <strong>{file.name}</strong></span>
                    <small>{formatBytes(file.size)} · {formatDate(file.modifiedTime)}</small>
                  </label>
                ))}
              </div>
              <button type="button" onClick={appendSelectedDriveImages} disabled={reconciling || !selectedDriveIds.length}>
                {reconciling ? 'Appending…' : `Append ${selectedDriveIds.length} selected image${selectedDriveIds.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          {reconciliation && reconciliation.unsupportedCount > 0 && (
            <p>{reconciliation.unsupportedCount} unsupported Drive file{reconciliation.unsupportedCount === 1 ? ' was' : 's were'} ignored.</p>
          )}
          {reconciliation && reconciliation.missingFromDriveCount > 0 && (
            <p>{reconciliation.missingFromDriveCount} tracked gallery image{reconciliation.missingFromDriveCount === 1 ? ' is' : 's are'} no longer in Drive and will be preserved.</p>
          )}
        </section>
      )}
      {error && <p className="admin-image-manager-error" role="alert">{error}</p>}
      {!images.length && (
        <div className={`admin-image-manager-empty${imageClearedByAdmin ? ' is-intentionally-cleared' : ''}`}>
          <strong>{imageClearedByAdmin ? 'No profile image' : 'No editable Storage image yet.'}</strong>
          <span>{imageClearedByAdmin
            ? 'Image intentionally removed by Admin. Upload a new image to restore the public gallery.'
            : sourceHealth?.focalMessage || 'Checking the current source before focal-point editing can be enabled.'}</span>
        </div>
      )}
      {!images.length && imageClearedByAdmin && (driveFolderId || driveFileId) && (
        <section className="admin-drive-reconciliation admin-image-restoration" aria-labelledby="admin-image-restoration-title">
          <div className="admin-drive-reconciliation-heading">
            <div>
              <h3 id="admin-image-restoration-title">Restore an explicitly selected source image</h3>
              <p>Automatic imports remain blocked. Previewing is read-only; the cleared state changes only after a confirmed image transaction succeeds.</p>
            </div>
            <button type="button" onClick={previewSourceRestoration} disabled={restoring}>
              {restoring && !restorationPreview ? 'Checking…' : 'Preview source restoration'}
            </button>
          </div>
          {restorationPreview && (
            <div className="admin-drive-new-images">
              <strong>{restorationPreview.candidates.length} validated source image{restorationPreview.candidates.length === 1 ? '' : 's'} available</strong>
              <p>Select the image or images that should become the new gallery. The first restored image becomes primary.</p>
              <div className="admin-drive-file-grid">
                {restorationPreview.candidates.map((candidate) => (
                  <label key={candidate.driveFileId}>
                    {/* The Admin-only thumbnail route validates this exact profile source. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={candidate.thumbnailUrl} alt="" loading="lazy" />
                    <span><input
                      type="checkbox"
                      checked={selectedRestorationIds.includes(candidate.driveFileId)}
                      onChange={(event) => setSelectedRestorationIds((current) => event.target.checked
                        ? [...new Set([...current, candidate.driveFileId])]
                        : current.filter((id) => id !== candidate.driveFileId))}
                    /> <strong>{candidate.name}</strong></span>
                    <small>{candidate.width}×{candidate.height} · {formatBytes(candidate.byteLength)}</small>
                  </label>
                ))}
              </div>
              <button type="button" onClick={applySourceRestoration} disabled={restoring || !selectedRestorationIds.length}>
                {restoring ? 'Restoring…' : `Restore ${selectedRestorationIds.length} selected image${selectedRestorationIds.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </section>
      )}
      <div className="admin-image-manager-grid" id="admin-image-manager-grid">
        {images.map((image, index) => (
          <article className="admin-image-manager-card" key={image.id}>
            <div className="admin-image-manager-card-header">
              <strong>Image {index + 1}</strong>
              {image.isPrimary && <span className="admin-image-primary-badge">Primary</span>}
            </div>
            <div className="admin-image-manager-preview">
              <FocalPointEditor
                datasetId={datasetId}
                datasetSlug={datasetSlug}
                profileId={profileId}
                imageId={image.id}
                src={image.src}
                candidates={image.candidates}
                focalX={image.focalX}
                focalY={image.focalY}
                displayMode={image.displayMode}
                displayModeInputName={`display-mode-${image.id}`}
                controlsOutside
                eager={index === 0}
              />
            </div>
            <div className="admin-image-manager-actions">
              {!image.isPrimary && <button type="button" onClick={() => setPrimary(image.id)}>Set primary</button>}
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>Move up</button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === images.length - 1}>Move down</button>
              <button type="button" onClick={() => rotate(image.id, 'left')}>Rotate left 90°</button>
              <button type="button" onClick={() => rotate(image.id, 'right')}>Rotate right 90°</button>
              {images.length === 1 ? (
                <>
                  <button type="button" className="admin-image-remove" onClick={() => remove(image.id, false)}>Remove for replacement</button>
                  <button type="button" className="admin-image-remove" onClick={() => remove(image.id, true)}>Clear profile images</button>
                </>
              ) : <button type="button" className="admin-image-remove" onClick={() => remove(image.id, false)}>Remove</button>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
