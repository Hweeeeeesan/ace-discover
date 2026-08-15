'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import {
  countAdvancedFilters,
  DEFAULT_FILTERS,
  sanitizeFilters,
  SOCIAL_STYLE_OPTIONS,
  VIBE_OPTIONS,
} from '../lib/discovery';

function emptyFilters() {
  return { ...DEFAULT_FILTERS, vibes: [], years: [], majorGroups: [], socialStyles: [] };
}

export default function FilterSheet({
  open,
  options,
  values,
  onClose,
  onApply,
}) {
  const [draft, setDraft] = useState(() => sanitizeFilters(values));
  const wasOpenRef = useRef(false);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraft(sanitizeFilters(values));
      const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
      wasOpenRef.current = open;
      return () => window.cancelAnimationFrame(frame);
    }

    wasOpenRef.current = open;
    return undefined;
  }, [open, values]);

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.documentElement.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const draftCount = useMemo(
    () => countAdvancedFilters(draft),
    [draft],
  );

  if (!open) return null;

  function toggleYear(value) {
    setDraft((current) => ({
      ...current,
      years: current.years.includes(value)
        ? current.years.filter((year) => year !== value)
        : [...current.years, value],
    }));
  }

  function toggleArrayValue(key, value) {
    setDraft((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  }

  function setSocialMinimum(value) {
    const minimum = Number(value);
    setDraft((current) => ({
      ...current,
      socialLevelMin: minimum,
      socialLevelMax: Math.max(minimum, current.socialLevelMax),
    }));
  }

  function setSocialMaximum(value) {
    const maximum = Number(value);
    setDraft((current) => ({
      ...current,
      socialLevelMin: Math.min(maximum, current.socialLevelMin),
      socialLevelMax: maximum,
    }));
  }

  return (
    <div className="filter-layer">
      <button
        type="button"
        className="filter-backdrop"
        onClick={onClose}
        aria-label="Close filters"
      />

      <section
        className="filter-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-sheet-title"
      >
        <div className="sheet-handle" aria-hidden="true" />

        <div className="sheet-header">
          <div>
            <span>Refine discovery</span>
            <h2 id="filter-sheet-title">More filters</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="sheet-close-button"
            type="button"
            onClick={onClose}
            aria-label="Close filters"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-scroll">
          <fieldset className="filter-fieldset">
            <legend>Vibes</legend>
            <div className="vibe-grid filter-vibe-grid">
              {VIBE_OPTIONS.map((vibe) => {
                const selected = draft.vibes.includes(vibe);
                return (
                  <button
                    className={`vibe-option${selected ? ' is-selected' : ''}`}
                    type="button"
                    key={vibe}
                    aria-pressed={selected}
                    onClick={() => toggleArrayValue('vibes', vibe)}
                  >
                    {vibe}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="filter-fieldset">
            <legend>Year</legend>
            <div className="year-options">
              {options.years.map((option) => {
                const selected = draft.years.includes(option.value);
                return (
                  <button
                    className={`year-chip${selected ? ' is-selected' : ''}`}
                    type="button"
                    key={option.value}
                    onClick={() => toggleYear(option.value)}
                    aria-pressed={selected}
                  >
                    <span>{option.label}</span>
                    <small>{option.count}</small>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="filter-fieldset">
            <legend>Major Area</legend>
            <div className="major-group-options">
              {options.majorGroups.map((option) => {
                const selected = draft.majorGroups.includes(option.value);
                return (
                  <button
                    className={`year-chip${selected ? ' is-selected' : ''}`}
                    type="button"
                    key={option.value}
                    onClick={() => toggleArrayValue('majorGroups', option.value)}
                    aria-pressed={selected}
                  >
                    <span>{option.label}</span>
                    <small>{option.count}</small>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="filter-fieldset social-level-fieldset">
            <legend>Social Level</legend>
            <div className="social-range-summary">
              <span>Low-key</span>
              <strong>{draft.socialLevelMin}–{draft.socialLevelMax}</strong>
              <span>Very social</span>
            </div>
            <div className="social-range-scale" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((level) => <span key={level}>{level}</span>)}
            </div>
            <div
              className="dual-range-control"
              style={{
                '--range-start': `${((draft.socialLevelMin - 1) / 4) * 100}%`,
                '--range-end': `${((draft.socialLevelMax - 1) / 4) * 100}%`,
              }}
            >
              <input
                className={draft.socialLevelMin === 5 ? 'is-on-top' : ''}
                type="range"
                min="1"
                max="5"
                step="1"
                value={draft.socialLevelMin}
                onChange={(event) => setSocialMinimum(event.target.value)}
                aria-label="Minimum social level"
              />
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={draft.socialLevelMax}
                onChange={(event) => setSocialMaximum(event.target.value)}
                aria-label="Maximum social level"
              />
            </div>
            <p className="filter-help">Profiles without a rating remain included at 1–5 and are excluded when you narrow the range.</p>
          </fieldset>

          <fieldset className="filter-fieldset">
            <legend>Social Style</legend>
            <div className="social-style-options">
              {SOCIAL_STYLE_OPTIONS.map((style) => {
                const selected = draft.socialStyles.includes(style);
                return (
                  <button
                    className={`year-chip${selected ? ' is-selected' : ''}`}
                    type="button"
                    key={style}
                    onClick={() => toggleArrayValue('socialStyles', style)}
                    aria-pressed={selected}
                  >
                    <span>{style}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="sheet-footer">
          <button
            className="reset-filters-button"
            type="button"
            onClick={() => setDraft(emptyFilters())}
            disabled={draftCount === 0}
          >
            <RotateCcw size={16} /> Reset filters
          </button>
          <button
            className="apply-filters-button"
            type="button"
            onClick={() => onApply(sanitizeFilters(draft))}
          >
            Apply{draftCount ? ` (${draftCount})` : ''}
          </button>
        </div>
      </section>
    </div>
  );
}
