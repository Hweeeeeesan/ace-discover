'use client';

import { X } from 'lucide-react';
import { VIBE_OPTIONS } from '../lib/discovery';

export default function VibeSheet({ open, selected, onToggle, onClear, onClose }) {
  if (!open) return null;
  return (
    <div className="filter-layer">
      <button type="button" className="filter-backdrop" onClick={onClose} aria-label="Close vibes" />
      <section className="filter-sheet vibe-sheet" role="dialog" aria-modal="true" aria-labelledby="vibe-title">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div><span>Discover by vibe</span><h2 id="vibe-title">Choose one or more</h2></div>
          <button className="sheet-close-button" type="button" onClick={onClose} aria-label="Close vibes"><X size={20} /></button>
        </div>
        <div className="vibe-grid">
          {VIBE_OPTIONS.map((vibe) => (
            <button className={`vibe-option${selected.includes(vibe) ? ' is-selected' : ''}`} type="button" key={vibe} aria-pressed={selected.includes(vibe)} onClick={() => onToggle(vibe)}>{vibe}</button>
          ))}
        </div>
        <div className="sheet-footer">
          <button className="reset-filters-button" type="button" onClick={onClear} disabled={!selected.length}>Clear all</button>
          <button className="apply-filters-button" type="button" onClick={onClose}>Show profiles{selected.length ? ` (${selected.length} vibes)` : ''}</button>
        </div>
      </section>
    </div>
  );
}
