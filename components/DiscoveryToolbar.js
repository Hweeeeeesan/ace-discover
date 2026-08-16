'use client';

import { useEffect, useRef } from 'react';
import {
  ChevronLeft,
  Bookmark,
  Search,
  Shuffle,
  SlidersHorizontal,
  X,
} from 'lucide-react';

const ROLE_FILTERS = [
  { value: 'All', label: 'All' },
  { value: 'Little', label: 'Little' },
  { value: 'Big', label: 'Big' },
  { value: 'Family', label: 'Family' },
];

export default function DiscoveryToolbar({
  query,
  onQueryChange,
  searchOpen,
  onSearchOpen,
  onSearchClose,
  role,
  onRoleChange,
  unseen,
  onUnseenChange,
  onShuffle,
  onOpenFilters,
  activeFilterCount,
  resultCount,
  availableRoles = [],
  saved = false,
  onSavedChange,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        onSearchOpen();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSearchOpen]);

  return (
    <header className="discovery-toolbar" aria-label="Discovery controls">
      <div className="toolbar-surface">
        {searchOpen ? (
          <div className="search-row">
            <button
              className="toolbar-icon-button"
              type="button"
              onClick={onSearchClose}
              aria-label="Close search"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="search-box">
              <Search size={17} aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Name, major, or interest"
                aria-label="Search profiles"
                autoComplete="off"
                enterKeyHint="search"
              />
              {query && (
                <button
                  className="search-clear"
                  type="button"
                  onClick={() => onQueryChange('')}
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <span className="search-result-count" aria-live="polite">{resultCount}</span>
          </div>
        ) : (
          <div className="toolbar-row">
            <div className="discover-heading">
              <strong>ACE Discover</strong>
              <span aria-live="polite">{resultCount} {resultCount === 1 ? 'profile' : 'profiles'}</span>
            </div>
            <div className="toolbar-actions">
              <button
                className={`toolbar-icon-button${query ? ' is-active' : ''}`}
                type="button"
                onClick={onSearchOpen}
                aria-label={query ? `Edit search for ${query}` : 'Search profiles'}
                title="Search profiles"
              >
                <Search size={19} />
                {query && <span className="control-dot" aria-hidden="true" />}
              </button>
              <button
                className="toolbar-icon-button"
                type="button"
                onClick={onShuffle}
                aria-label="Shuffle profiles"
                title="Shuffle profiles"
                disabled={resultCount < 2}
              >
                <Shuffle size={19} />
              </button>
              <button
                className={`toolbar-icon-button${saved ? ' is-active' : ''}`}
                type="button"
                onClick={() => onSavedChange?.(!saved)}
                aria-pressed={saved}
                aria-label="Show saved profiles only"
                title="Saved profiles"
              >
                <Bookmark size={19} fill={saved ? 'currentColor' : 'none'} />
              </button>
              <button
                className={`toolbar-icon-button${activeFilterCount ? ' has-filters' : ''}`}
                type="button"
                onClick={onOpenFilters}
                aria-label={`Open filters${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}
                title="More filters"
              >
                <SlidersHorizontal size={19} />
                {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
              </button>
            </div>
          </div>
        )}

        <nav className="filter-strip role-control-strip" aria-label="Profile role and seen filters">
          <div className="role-chip-scroll">
            {ROLE_FILTERS.filter((filter) => filter.value === 'All' || availableRoles.includes(filter.value)).map((filter) => {
              const selected = role === filter.value;
              return (
                <button
                  className={`filter-chip${selected ? ' is-selected' : ''}`}
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
          <label className="unseen-toggle">
            <span>Unseen</span>
            <input
              type="checkbox"
              checked={unseen}
              onChange={(event) => onUnseenChange(event.target.checked)}
              aria-label="Show unseen profiles only"
            />
            <span className="toggle-track" aria-hidden="true"><span /></span>
          </label>
        </nav>
      </div>
    </header>
  );
}
