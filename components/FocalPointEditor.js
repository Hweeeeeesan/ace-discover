'use client';

import { useCallback, useRef, useState } from 'react';
import ProfileImage from './ProfileImage';

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function rounded(value) {
  return Math.round(clamp(value) * 100) / 100;
}

export default function FocalPointEditor({
  datasetId,
  datasetSlug,
  profileId,
  imageId,
  src,
  candidates = [],
  focalX = 50,
  focalY = 35,
  displayMode = 'cover',
  displayModeInputName = 'display-mode',
  onSaved,
  controlsOutside = false,
}) {
  const targetRef = useRef(null);
  const [point, setPoint] = useState({ x: focalX, y: focalY });
  const [mode, setMode] = useState(displayMode === 'portrait' ? 'portrait' : 'cover');
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const updateFromPointer = useCallback((event) => {
    const bounds = targetRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width || !bounds.height) return;
    setPoint({
      x: rounded(((event.clientX - bounds.left) / bounds.width) * 100),
      y: rounded(((event.clientY - bounds.top) / bounds.height) * 100),
    });
  }, []);

  function handlePointerDown(event) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    updateFromPointer(event);
  }

  function handlePointerMove(event) {
    if (dragging) updateFromPointer(event);
  }

  function handlePointerUp(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  }

  function handleKeyDown(event) {
    const step = event.shiftKey ? 5 : 1;
    const deltas = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    setPoint((current) => ({ x: rounded(current.x + delta[0]), y: rounded(current.y + delta[1]) }));
  }

  async function save() {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const response = await fetch('/api/admin/datasets/focal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, datasetSlug, profileId, imageId, focalX: point.x, focalY: point.y, displayMode: mode }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Focal point could not be saved.');
      setMessage('Focal point saved.');
      onSaved?.(payload.image);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`focal-editor${controlsOutside ? ' focal-editor-controls-outside' : ''}`} aria-label="Profile image focal point editor">
      <div className="focal-editor-canvas">
        <ProfileImage
          className={`profile-image focal-editor-image${controlsOutside ? ' focal-editor-editing-image' : ''}`}
          src={src}
          candidates={candidates}
          alt=""
          eager
          focalX={point.x}
          focalY={point.y}
          displayMode={mode}
        />
        <div
          ref={targetRef}
          className="focal-editor-target"
          role="slider"
          tabIndex="0"
          aria-label="Image focal point"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={point.y}
          aria-valuetext={`${point.x}% horizontal, ${point.y}% vertical`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          <span className="focal-editor-marker" style={{ left: `${point.x}%`, top: `${point.y}%` }} aria-hidden="true" />
        </div>
      </div>
      <div className="focal-editor-controls">
        <fieldset className="focal-editor-modes">
          <legend>Display</legend>
          <label><input type="radio" name={displayModeInputName} value="cover" checked={mode === 'cover'} onChange={() => setMode('cover')} /> Cover</label>
          <label><input type="radio" name={displayModeInputName} value="portrait" checked={mode === 'portrait'} onChange={() => setMode('portrait')} /> Portrait</label>
        </fieldset>
        <span>Focal point {point.x}% · {point.y}%</span>
        <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save focal point'}</button>
        {message && <small role="status">{message}</small>}
        {error && <small className="focal-editor-error" role="alert">{error}</small>}
      </div>
    </div>
  );
}
