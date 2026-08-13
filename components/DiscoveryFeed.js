'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchX, SlidersHorizontal } from 'lucide-react';
import DiscoveryToolbar from './DiscoveryToolbar';
import FilterSheet from './FilterSheet';
import ProfileCard from './ProfileCard';
import {
  countAdvancedFilters,
  createSeed,
  DEFAULT_FILTERS,
  DISCOVERY_NAV_KEY,
  DISCOVERY_STORAGE_KEY,
  filterAndOrderProfiles,
  getDiscoveryOptions,
  sanitizeFilters,
} from '../lib/discovery';

function emptyFilters() {
  return { ...DEFAULT_FILTERS, years: [] };
}

const INITIAL_STATE = {
  query: '',
  role: 'All',
  filters: emptyFilters(),
  seed: 1,
  activeProfileId: '',
  scrollTop: 0,
};

function sanitizeStoredState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const numericSeed = Number(source.seed);
  const numericScrollTop = Number(source.scrollTop);

  return {
    query: typeof source.query === 'string' ? source.query.slice(0, 160) : '',
    role: ['All', 'Little', 'Big', 'Family'].includes(source.role) ? source.role : 'All',
    filters: sanitizeFilters(source.filters),
    seed: Number.isFinite(numericSeed) && numericSeed > 0 ? numericSeed : createSeed(),
    activeProfileId: typeof source.activeProfileId === 'string' ? source.activeProfileId : '',
    scrollTop: Number.isFinite(numericScrollTop) && numericScrollTop >= 0 ? numericScrollTop : 0,
  };
}

export default function DiscoveryFeed({ profiles }) {
  const feedRef = useRef(null);
  const stateRef = useRef(INITIAL_STATE);
  const scrollTopRef = useRef(0);
  const toastTimerRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [discovery, setDiscovery] = useState(INITIAL_STATE);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toast, setToast] = useState('');

  stateRef.current = discovery;

  const options = useMemo(() => getDiscoveryOptions(profiles), [profiles]);
  const visibleProfiles = useMemo(
    () => filterAndOrderProfiles(profiles, {
      query: discovery.query,
      role: discovery.role,
      ...discovery.filters,
      seed: discovery.seed,
    }),
    [profiles, discovery.query, discovery.role, discovery.filters, discovery.seed],
  );
  const visibleKey = useMemo(
    () => visibleProfiles.map((profile) => profile.id).join('|'),
    [visibleProfiles],
  );

  const advancedFilterCount = countAdvancedFilters(discovery.filters);
  const sheetFilterCount = advancedFilterCount + Number(discovery.filters.hasDeck);
  const totalActiveControls = advancedFilterCount
    + Number(discovery.filters.hasDeck)
    + Number(discovery.role !== 'All')
    + Number(Boolean(discovery.query));
  const activeProfileId = visibleProfiles.some((profile) => profile.id === discovery.activeProfileId)
    ? discovery.activeProfileId
    : visibleProfiles[0]?.id || '';

  const saveSnapshot = useCallback((overrides = {}) => {
    if (typeof window === 'undefined') return;

    const current = stateRef.current;
    const snapshot = {
      ...current,
      ...overrides,
      filters: overrides.filters
        ? sanitizeFilters({ ...current.filters, ...overrides.filters })
        : current.filters,
      scrollTop: overrides.scrollTop ?? feedRef.current?.scrollTop ?? scrollTopRef.current,
    };

    scrollTopRef.current = snapshot.scrollTop;

    try {
      window.sessionStorage.setItem(DISCOVERY_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // The gallery remains usable when storage is blocked.
    }
  }, []);

  useEffect(() => {
    let initial = {
      ...INITIAL_STATE,
      filters: emptyFilters(),
      seed: createSeed(),
    };

    try {
      const stored = window.sessionStorage.getItem(DISCOVERY_STORAGE_KEY);
      if (stored) initial = sanitizeStoredState(JSON.parse(stored));
    } catch {
      try {
        window.sessionStorage.removeItem(DISCOVERY_STORAGE_KEY);
      } catch {
        // Ignore unavailable storage.
      }
    }

    stateRef.current = initial;
    scrollTopRef.current = initial.scrollTop;
    setDiscovery(initial);
    setSearchOpen(Boolean(initial.query));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || restored) return undefined;

    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const feed = feedRef.current;
        if (!feed) return;

        const target = discovery.activeProfileId
          ? document.getElementById(`profile-${discovery.activeProfileId}`)
          : null;

        if (target && feed.contains(target)) feed.scrollTop = target.offsetTop;
        else feed.scrollTop = Math.max(0, discovery.scrollTop || 0);

        scrollTopRef.current = feed.scrollTop;
        setRestored(true);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [ready, restored, discovery.activeProfileId, discovery.scrollTop, visibleKey]);

  useEffect(() => {
    if (!ready || !restored) return;
    saveSnapshot({ scrollTop: scrollTopRef.current });
  }, [ready, restored, discovery, saveSnapshot]);

  useEffect(() => {
    if (!ready || !restored) return undefined;

    function saveWhenLeaving() {
      saveSnapshot({ scrollTop: feedRef.current?.scrollTop ?? scrollTopRef.current });
    }

    function saveWhenHidden() {
      if (document.visibilityState === 'hidden') saveWhenLeaving();
    }

    window.addEventListener('pagehide', saveWhenLeaving);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      window.removeEventListener('pagehide', saveWhenLeaving);
      document.removeEventListener('visibilitychange', saveWhenHidden);
    };
  }, [ready, restored, saveSnapshot]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!ready || !restored || !feed || visibleProfiles.length === 0) return undefined;

    const ratios = new Map();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const profileId = entry.target.getAttribute('data-profile-id');
        if (profileId) ratios.set(profileId, entry.isIntersecting ? entry.intersectionRatio : 0);
      });

      let bestProfileId = '';
      let bestRatio = 0;
      ratios.forEach((ratio, profileId) => {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestProfileId = profileId;
        }
      });

      if (bestProfileId && bestRatio >= 0.45) {
        setDiscovery((current) => {
          if (current.activeProfileId === bestProfileId) return current;
          return {
            ...current,
            activeProfileId: bestProfileId,
            scrollTop: scrollTopRef.current,
          };
        });
      }
    }, {
      root: feed,
      threshold: [0.25, 0.45, 0.6, 0.8],
    });

    const cards = feed.querySelectorAll('[data-profile-id]');
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [ready, restored, visibleKey, visibleProfiles.length]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key !== 'Escape') return;
      if (filtersOpen) setFiltersOpen(false);
      else if (searchOpen) setSearchOpen(false);
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [filtersOpen, searchOpen]);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const scrollToStart = useCallback((behavior = 'auto') => {
    scrollTopRef.current = 0;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        feedRef.current?.scrollTo({ top: 0, behavior });
      });
    });
  }, []);

  const updateControls = useCallback((updater, behavior = 'auto') => {
    setDiscovery((current) => {
      const updated = typeof updater === 'function'
        ? updater(current)
        : { ...current, ...updater };
      return { ...updated, activeProfileId: '', scrollTop: 0 };
    });
    scrollToStart(behavior);
  }, [scrollToStart]);

  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 1800);
  }, []);

  const handleSearchOpen = useCallback(() => {
    setFiltersOpen(false);
    setSearchOpen(true);
  }, []);

  function handleQueryChange(query) {
    updateControls((current) => ({ ...current, query: query.slice(0, 160) }));
  }

  function handleRoleChange(role) {
    updateControls((current) => ({ ...current, role }));
  }

  function handleDeckChange(hasDeck) {
    updateControls((current) => ({
      ...current,
      filters: { ...current.filters, hasDeck },
    }));
  }

  function handleApplyFilters(filters) {
    updateControls((current) => ({ ...current, filters: sanitizeFilters(filters) }));
    setFiltersOpen(false);
  }

  function handleShuffle() {
    updateControls((current) => ({ ...current, seed: createSeed(current.seed) }), 'smooth');
    showToast('Profiles reshuffled');
  }

  function clearEverything() {
    updateControls((current) => ({
      ...current,
      query: '',
      role: 'All',
      filters: emptyFilters(),
    }));
    setSearchOpen(false);
  }

  function handleOpenProfile(profileId) {
    saveSnapshot({
      activeProfileId: profileId,
      scrollTop: feedRef.current?.scrollTop ?? scrollTopRef.current,
    });

    try {
      window.sessionStorage.setItem(DISCOVERY_NAV_KEY, JSON.stringify({
        profileId,
        at: Date.now(),
      }));
    } catch {
      // Navigation still works without storage.
    }
  }

  if (!ready) {
    return (
      <main className="discovery-shell discovery-loading" aria-busy="true">
        <div className="loading-orb" aria-hidden="true" />
        <strong>Preparing discovery</strong>
        <span>Loading your randomized profile order</span>
      </main>
    );
  }

  return (
    <main className={`discovery-shell${restored ? ' is-ready' : ''}`}>
      <DiscoveryToolbar
        query={discovery.query}
        onQueryChange={handleQueryChange}
        searchOpen={searchOpen}
        onSearchOpen={handleSearchOpen}
        onSearchClose={() => setSearchOpen(false)}
        role={discovery.role}
        onRoleChange={handleRoleChange}
        hasDeck={discovery.filters.hasDeck}
        onHasDeckChange={handleDeckChange}
        onShuffle={handleShuffle}
        onOpenFilters={() => {
          setSearchOpen(false);
          setFiltersOpen(true);
        }}
        activeFilterCount={sheetFilterCount}
        resultCount={visibleProfiles.length}
      />

      <div className="result-announcer" aria-live="polite" aria-atomic="true">
        {visibleProfiles.length} profiles available
      </div>

      <div
        className={`feed ${filtersOpen ? 'is-locked' : ''}`}
        ref={feedRef}
        aria-label="Profile discovery feed"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {visibleProfiles.length ? (
          visibleProfiles.map((profile, index) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              index={index}
              total={visibleProfiles.length}
              active={profile.id === activeProfileId}
              showHint={index === 0 && totalActiveControls === 0}
              onOpenProfile={handleOpenProfile}
            />
          ))
        ) : (
          <section className="empty-results" role="status">
            <div className="empty-icon"><SearchX size={28} /></div>
            <p>No profiles found</p>
            <h1>Try a different search or broaden your filters.</h1>
            <div className="empty-actions">
              {discovery.query && (
                <button type="button" onClick={() => handleQueryChange('')}>Clear search</button>
              )}
              <button type="button" onClick={clearEverything}>
                <SlidersHorizontal size={16} /> Reset filters
              </button>
            </div>
          </section>
        )}
      </div>

      <FilterSheet
        open={filtersOpen}
        options={options}
        values={discovery.filters}
        onClose={() => setFiltersOpen(false)}
        onApply={handleApplyFilters}
      />

      {!restored && (
        <div className="restore-curtain" aria-hidden="true">
          <div className="loading-orb" />
        </div>
      )}

      {toast && <div className="discovery-toast" role="status">{toast}</div>}
    </main>
  );
}
