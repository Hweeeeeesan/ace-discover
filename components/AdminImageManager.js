'use client';

import { useState } from 'react';
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

export default function AdminImageManager({ datasetId, datasetSlug, profileId, images = [] }) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [makePrimary, setMakePrimary] = useState(false);
  const [error, setError] = useState('');

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

  function remove(imageId) {
    if (!window.confirm('Remove this profile image?')) return Promise.resolve();
    return refreshAfter(() => postAction({ datasetId, datasetSlug, profileId, action: 'delete', imageId }));
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
      {error && <p className="admin-image-manager-error" role="alert">{error}</p>}
      {!images.length && <p className="admin-image-manager-empty">No Storage images yet. Add the first image to make it primary automatically.</p>}
      <div className="admin-image-manager-grid">
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
              />
            </div>
            <div className="admin-image-manager-actions">
              {!image.isPrimary && <button type="button" onClick={() => setPrimary(image.id)}>Set primary</button>}
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>Move up</button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === images.length - 1}>Move down</button>
              <button type="button" onClick={() => rotate(image.id, 'left')}>Rotate left 90°</button>
              <button type="button" onClick={() => rotate(image.id, 'right')}>Rotate right 90°</button>
              <button type="button" className="admin-image-remove" onClick={() => remove(image.id)}>Remove</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
