'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Presentation, RotateCcw, X } from 'lucide-react';
import { countAdvancedFilters, DEFAULT_FILTERS, sanitizeFilters } from '../lib/discovery';

function emptyFilters() {
  return { ...DEFAULT_FILTERS, years: [] };
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
    () => countAdvancedFilters(draft) + Number(draft.hasDeck),
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

          <div className="select-grid">
            <label className="select-field">
              <span>Major</span>
              <select
                value={draft.major}
                onChange={(event) => setDraft((current) => ({ ...current, major: event.target.value }))}
              >
                <option value="">Any major</option>
                {options.majors.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
            </label>

            <label className="select-field">
              <span>School</span>
              <select
                value={draft.school}
                onChange={(event) => setDraft((current) => ({ ...current, school: event.target.value }))}
              >
                <option value="">Any school</option>
                {options.schools.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
            </label>

            <label className="select-field select-field-wide">
              <span>Program</span>
              <select
                value={draft.program}
                onChange={(event) => setDraft((current) => ({ ...current, program: event.target.value }))}
              >
                <option value="">Any program</option>
                {options.programs.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button
            className={`deck-toggle-row${draft.hasDeck ? ' is-selected' : ''}`}
            type="button"
            onClick={() => setDraft((current) => ({ ...current, hasDeck: !current.hasDeck }))}
            aria-pressed={draft.hasDeck}
          >
            <span className="deck-toggle-icon"><Presentation size={19} /></span>
            <span className="deck-toggle-copy">
              <strong>Slide deck available</strong>
              <small>Only show profiles with a submitted deck.</small>
            </span>
            <span className="toggle-switch" aria-hidden="true"><span /></span>
          </button>
        </div>

        <div className="sheet-footer">
          <button
            className="reset-filters-button"
            type="button"
            onClick={() => setDraft(emptyFilters())}
            disabled={draftCount === 0}
          >
            <RotateCcw size={16} /> Reset
          </button>
          <button
            className="apply-filters-button"
            type="button"
            onClick={() => onApply(sanitizeFilters(draft))}
          >
            Apply filters{draftCount ? ` (${draftCount})` : ''}
          </button>
        </div>
      </section>
    </div>
  );
}
