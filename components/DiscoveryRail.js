'use client';

import { useEffect, useRef } from 'react';
import { Bookmark, ChevronRight, RotateCcw, Search, Shuffle, X } from 'lucide-react';

const ROLE_FILTERS = [
  { value: 'All', label: 'All' },
  { value: 'Little', label: 'Little' },
  { value: 'Big', label: 'Big' },
  { value: 'Family', label: 'Family' },
];

function filterSummary(values, key, fallback) {
  const count = Array.isArray(values?.[key]) ? values[key].length : 0;
  return count ? `${count} selected` : fallback;
}

export default function DiscoveryRail({
  query,
  onQueryChange,
  searchOpen,
  role,
  onRoleChange,
  unseen,
  onUnseenChange,
  saved,
  onSavedChange,
  onShuffle,
  resultCount = 0,
  filters,
  activeFilterCount,
  onOpenFilters,
  onClearFilters,
  availableRoles = [],
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!searchOpen) return;
    inputRef.current?.focus();
  }, [searchOpen]);

  const filterSections = [
    ['Vibes', filterSummary(filters, 'vibes', 'All vibes')],
    ['Year', filterSummary(filters, 'years', 'All years')],
    ['Major Area', filterSummary(filters, 'majorGroups', 'All areas')],
    ['Social Level', filters?.socialLevelMin !== 1 || filters?.socialLevelMax !== 5
      ? `${filters.socialLevelMin}–${filters.socialLevelMax}`
      : 'Any level'],
    ['Social Style', filterSummary(filters, 'socialStyles', 'All styles')],
  ];

  return (
    <aside className="discovery-rail" aria-label="Discovery filters">
      <div className="rail-heading">
        <strong>ACE Discover</strong>
        <span>{resultCount} {resultCount === 1 ? 'profile' : 'profiles'}</span>
      </div>

      <button className="rail-shuffle-button" type="button" onClick={onShuffle} disabled={resultCount < 2}>
        <Shuffle size={16} /> Shuffle profiles
      </button>

      <div className="rail-section">
        <span className="rail-label">Role</span>
        <div className="rail-role-list">
          {ROLE_FILTERS.filter((filter) => filter.value === 'All' || availableRoles.includes(filter.value)).map((filter) => {
            const selected = role === filter.value;
            return (
              <button
                className={`rail-role-button${selected ? ' is-selected' : ''}`}
                type="button"
                key={filter.value}
                aria-pressed={selected}
                onClick={() => onRoleChange(filter.value)}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rail-toggle-group">
        <label className="rail-toggle-row">
          <span>Unseen profiles</span>
          <input
            type="checkbox"
            checked={unseen}
            onChange={(event) => onUnseenChange(event.target.checked)}
            aria-label="Show unseen profiles only"
          />
          <span className="toggle-track" aria-hidden="true"><span /></span>
        </label>
        <button
          className={`rail-saved-button${saved ? ' is-active' : ''}`}
          type="button"
          aria-pressed={saved}
          aria-label="Show saved profiles only"
          onClick={() => onSavedChange(!saved)}
        >
          <Bookmark size={17} fill={saved ? 'currentColor' : 'none'} />
          <span>Saved profiles</span>
        </button>
      </div>

      <div className="rail-section rail-search-section">
        <label className="rail-label" htmlFor="desktop-discovery-search">Search</label>
        <div className="rail-search-box">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            id="desktop-discovery-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Name, major, or interest"
            aria-label="Search profiles"
            autoComplete="off"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => onQueryChange('')}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="rail-section rail-filters-section">
        <div className="rail-section-heading">
          <span className="rail-label">Filters</span>
          <div className="rail-filter-heading-actions">
            {activeFilterCount > 0 && <span className="rail-count">{activeFilterCount}</span>}
            <button
              className="rail-open-filters"
              type="button"
              onClick={onOpenFilters}
              aria-label={`Open filters${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}
            >
              Edit
            </button>
          </div>
        </div>
        <div className="rail-filter-list">
          {filterSections.map(([label, summary]) => (
            <button key={label} type="button" onClick={onOpenFilters} aria-label={`Edit ${label} filters`}>
              <span><strong>{label}</strong><small>{summary}</small></span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
        {activeFilterCount > 0 && (
          <button className="rail-reset-button" type="button" onClick={onClearFilters}>
            <RotateCcw size={14} /> Reset filters
          </button>
        )}
      </div>
    </aside>
  );
}
