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
  DISCOVERY_STORAGE_KEY,
  discoveryNavigationKey,
  discoveryStorageKey,
  filterAndOrderProfiles,
  getDiscoveryOptions,
  migrateDiscoveryState,
  sanitizeFilters,
} from '../lib/discovery';
import { readSeenIds, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';

function emptyFilters() {
  return { ...DEFAULT_FILTERS, vibes: [], years: [], majorGroups: [], socialStyles: [] };
}

const INITIAL_STATE = {
  query: '',
  role: 'All',
  unseen: false,
  filters: emptyFilters(),
  seed: 1,
  activeProfileId: '',
  scrollTop: 0,
};

export default function DiscoveryFeed({ profiles, datasetSlug = 'fall-2025' }) {
  const feedRef = useRef(null);
  const stateRef = useRef(INITIAL_STATE);
  const scrollTopRef = useRef(0);
  const toastTimerRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [discovery, setDiscovery] = useState(INITIAL_STATE);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [seenIds, setSeenIds] = useState([]);
  const [toast, setToast] = useState('');

  stateRef.current = discovery;

  const options = useMemo(() => getDiscoveryOptions(profiles), [profiles]);
  const visibleProfiles = useMemo(
    () => filterAndOrderProfiles(profiles, {
      query: discovery.query,
      role: discovery.role,
      unseen: discovery.unseen,
      seenIds,
      ...discovery.filters,
      seed: discovery.seed,
    }),
    [profiles, discovery.query, discovery.role, discovery.unseen, discovery.filters, discovery.seed, seenIds],
  );
  const visibleKey = useMemo(
    () => visibleProfiles.map((profile) => profile.id).join('|'),
    [visibleProfiles],
  );

  const advancedFilterCount = countAdvancedFilters(discovery.filters);
  const sheetFilterCount = advancedFilterCount;
  const totalActiveControls = advancedFilterCount
    + Number(discovery.unseen)
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
      window.sessionStorage.setItem(discoveryStorageKey(datasetSlug), JSON.stringify(snapshot));
    } catch {
      // The gallery remains usable when storage is blocked.
    }
  }, [datasetSlug]);

  useEffect(() => {
    let initial = {
      ...INITIAL_STATE,
      filters: emptyFilters(),
      seed: createSeed(),
    };

    try {
      const datasetKey = discoveryStorageKey(datasetSlug);
      let stored = window.sessionStorage.getItem(datasetKey);
      if (!stored && datasetSlug === 'fall-2025') {
        stored = window.sessionStorage.getItem(DISCOVERY_STORAGE_KEY);
        if (stored) window.sessionStorage.setItem(datasetKey, stored);
      }
      if (stored) initial = migrateDiscoveryState(JSON.parse(stored));
    } catch {
      try {
        window.sessionStorage.removeItem(discoveryStorageKey(datasetSlug));
      } catch {
        // Ignore unavailable storage.
      }
    }

    stateRef.current = initial;
    scrollTopRef.current = initial.scrollTop;
    setDiscovery(initial);
    setSearchOpen(Boolean(initial.query));
    setReady(true);
  }, [datasetSlug]);

  useEffect(() => {
    function refreshSeen() { setSeenIds(readSeenIds(datasetSlug)); }
    refreshSeen();
    window.addEventListener('pageshow', refreshSeen);
    window.addEventListener('focus', refreshSeen);
    window.addEventListener(SEEN_CHANGE_EVENT, refreshSeen);
    return () => {
      window.removeEventListener('pageshow', refreshSeen);
      window.removeEventListener('focus', refreshSeen);
      window.removeEventListener(SEEN_CHANGE_EVENT, refreshSeen);
    };
  }, [datasetSlug]);

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

  function handleUnseenChange(unseen) {
    updateControls((current) => ({ ...current, unseen }));
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
      filters: emptyFilters(),
    }));
  }

  function handleOpenProfile(profileId) {
    saveSnapshot({
      activeProfileId: profileId,
      scrollTop: feedRef.current?.scrollTop ?? scrollTopRef.current,
    });

    try {
      window.sessionStorage.setItem(discoveryNavigationKey(datasetSlug), JSON.stringify({
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
        <strong>Preparing ACE Discover…</strong>
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
        unseen={discovery.unseen}
        onUnseenChange={handleUnseenChange}
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
              datasetSlug={datasetSlug}
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
