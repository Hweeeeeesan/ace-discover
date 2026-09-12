'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchX, SlidersHorizontal } from 'lucide-react';
import DiscoveryToolbar from './DiscoveryToolbar';
import DiscoveryRail from './DiscoveryRail';
import FilterSheet from './FilterSheet';
import ProfileCard from './ProfileCard';
import {
  countAdvancedFilters,
  buildDiscoveryResults,
  createSeed,
  DEFAULT_FILTERS,
  DISCOVERY_STORAGE_KEY,
  discoveryNavigationKey,
  discoveryStorageKey,
  getDiscoveryOptions,
  getAvailableRoles,
  migrateDiscoveryState,
  sanitizeFilters,
} from '../lib/discovery';
import { readSeenIds, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';
import { readSavedIds, SAVED_CHANGE_EVENT } from '../lib/saved-profiles';
import {
  markProfileEncountered,
  readEncounteredIds,
  sanitizeEncounteredIds,
} from '../lib/encountered-profiles';

function emptyFilters() {
  return { ...DEFAULT_FILTERS, vibes: [], years: [], majorGroups: [], socialStyles: [] };
}

const INITIAL_STATE = {
  query: '',
  role: 'All',
  saved: false,
  unseen: false,
  filters: emptyFilters(),
  seed: 1,
  activeProfileId: '',
  scrollTop: 0,
  encounteredOrderIds: [],
  seenOrderIds: [],
};

export default function DiscoveryFeed({ profiles, datasetSlug = 'fall-2025' }) {
  const router = useRouter();
  const feedRef = useRef(null);
  const stateRef = useRef(INITIAL_STATE);
  const scrollTopRef = useRef(0);
  const toastTimerRef = useRef(null);
  const lastDataRefreshAtRef = useRef(0);
  const checkedReturnRefreshRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [discovery, setDiscovery] = useState(INITIAL_STATE);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterSheetSection, setFilterSheetSection] = useState(null);
  const [seenIds, setSeenIds] = useState([]);
  const [savedIds, setSavedIds] = useState([]);
  const [encounteredIds, setEncounteredIds] = useState([]);
  const encounteredIdsRef = useRef([]);
  const [toast, setToast] = useState('');

  stateRef.current = discovery;
  encounteredIdsRef.current = encounteredIds;

  const refreshDiscoveryData = useCallback(() => {
    const now = Date.now();
    if (now - lastDataRefreshAtRef.current < 1000) return;
    lastDataRefreshAtRef.current = now;
    router.refresh();
  }, [router]);

  const options = useMemo(() => getDiscoveryOptions(profiles), [profiles]);
  const availableRoles = useMemo(() => getAvailableRoles(profiles), [profiles]);
  const effectiveRole = discovery.role === 'All' || availableRoles.includes(discovery.role)
    ? discovery.role
    : 'All';
  const visibleResults = useMemo(
    () => buildDiscoveryResults(profiles, {
      query: discovery.query,
      role: effectiveRole,
      saved: discovery.saved,
      unseen: discovery.unseen,
      seenIds,
      savedIds,
      ...discovery.filters,
      seed: discovery.seed,
      encounteredIds: discovery.encounteredOrderIds,
      orderingSeenIds: discovery.seenOrderIds,
    }),
    [profiles, discovery.query, effectiveRole, discovery.saved, discovery.unseen, discovery.filters, discovery.seed, discovery.encounteredOrderIds, discovery.seenOrderIds, seenIds, savedIds],
  );
  const visibleProfiles = useMemo(
    () => visibleResults.map(({ profile }) => profile),
    [visibleResults],
  );
  const visibleKey = useMemo(
    () => visibleProfiles.map((profile) => profile.id).join('|'),
    [visibleProfiles],
  );

  const advancedFilterCount = countAdvancedFilters(discovery.filters);
  const sheetFilterCount = advancedFilterCount;
  const totalActiveControls = advancedFilterCount
    + Number(discovery.unseen)
    + Number(discovery.saved)
    + Number(effectiveRole !== 'All')
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

    const initialSeenIds = readSeenIds(datasetSlug);
    const initialSavedIds = readSavedIds(datasetSlug);
    const initialEncounteredIds = readEncounteredIds(datasetSlug);
    initial.encounteredOrderIds = sanitizeEncounteredIds(initial.encounteredOrderIds || initialEncounteredIds);
    initial.seenOrderIds = Array.isArray(initial.seenOrderIds)
      ? initial.seenOrderIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)
      : initialSeenIds;
    stateRef.current = initial;
    encounteredIdsRef.current = initialEncounteredIds;
    scrollTopRef.current = initial.scrollTop;
    setDiscovery(initial);
    setSeenIds(initialSeenIds);
    setSavedIds(initialSavedIds);
    setEncounteredIds(initialEncounteredIds);
    setSearchOpen(Boolean(initial.query));
    setReady(true);
  }, [datasetSlug]);

  useEffect(() => {
    let wasInactive = document.visibilityState === 'hidden' || !document.hasFocus();

    // A client-side return from ProfileDetail can restore an old Router Cache
    // entry for `/`. The server route is already invalidated by focal saves;
    // refresh once so this mounted feed receives the current bulk RPC payload.
    if (!checkedReturnRefreshRef.current) {
      checkedReturnRefreshRef.current = true;
      try {
        const navigation = JSON.parse(window.sessionStorage.getItem(discoveryNavigationKey(datasetSlug)) || 'null');
        if (navigation?.at && Date.now() - navigation.at < 4 * 60 * 60 * 1000) refreshDiscoveryData();
      } catch {
        // Fresh data still loads normally when browser storage is unavailable.
      }
    }

    function handleBlur() {
      wasInactive = true;
    }

    function handleFocus() {
      if (!wasInactive) return;
      wasInactive = false;
      refreshDiscoveryData();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        wasInactive = true;
      } else if (wasInactive) {
        wasInactive = false;
        refreshDiscoveryData();
      }
    }

    function handlePageShow(event) {
      if (event.persisted) refreshDiscoveryData();
    }

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [datasetSlug, refreshDiscoveryData]);

  useEffect(() => {
    if (!ready || discovery.role === 'All' || availableRoles.includes(discovery.role)) return;
    setDiscovery((current) => ({ ...current, role: 'All', activeProfileId: '', scrollTop: 0 }));
  }, [availableRoles, discovery.role, ready]);

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
    function refreshSaved(event) {
      if (!event?.detail?.datasetSlug || event.detail.datasetSlug === datasetSlug) {
        setSavedIds(readSavedIds(datasetSlug));
      }
    }
    refreshSaved();
    window.addEventListener(SAVED_CHANGE_EVENT, refreshSaved);
    window.addEventListener('storage', refreshSaved);
    return () => {
      window.removeEventListener(SAVED_CHANGE_EVENT, refreshSaved);
      window.removeEventListener('storage', refreshSaved);
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
        if (!encounteredIdsRef.current.includes(bestProfileId)) {
          const updatedEncounteredIds = markProfileEncountered(bestProfileId, datasetSlug);
          encounteredIdsRef.current = updatedEncounteredIds;
          setEncounteredIds(updatedEncounteredIds);
        }
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
      if (filtersOpen) {
        setFiltersOpen(false);
        setFilterSheetSection(null);
      }
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
    setFilterSheetSection(null);
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

  function handleSavedChange(saved) {
    updateControls((current) => ({ ...current, saved }));
  }

  function handleApplyFilters(filters) {
    updateControls((current) => ({ ...current, filters: sanitizeFilters(filters) }));
    setFiltersOpen(false);
    setFilterSheetSection(null);
  }

  function openFilters(section = null) {
    setSearchOpen(false);
    setFilterSheetSection(section);
    setFiltersOpen(true);
  }

  function closeFilters() {
    setFiltersOpen(false);
    setFilterSheetSection(null);
  }

  function handleShuffle() {
    updateControls((current) => ({
      ...current,
      seed: createSeed(current.seed),
      encounteredOrderIds: [...encounteredIdsRef.current],
      seenOrderIds: [...seenIds],
    }), 'smooth');
    showToast('Profiles reshuffled');
  }

  function clearEverything() {
    updateControls((current) => ({
      ...current,
      filters: emptyFilters(),
    }));
  }

  function handleOpenProfile(profileId) {
    if (!encounteredIdsRef.current.includes(profileId)) {
      const updatedEncounteredIds = markProfileEncountered(profileId, datasetSlug);
      encounteredIdsRef.current = updatedEncounteredIds;
      setEncounteredIds(updatedEncounteredIds);
    }
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
      <DiscoveryRail
        query={discovery.query}
        onQueryChange={handleQueryChange}
        searchOpen={searchOpen}
        role={effectiveRole}
        onRoleChange={handleRoleChange}
        unseen={discovery.unseen}
        onUnseenChange={handleUnseenChange}
        saved={discovery.saved}
        onSavedChange={handleSavedChange}
        onShuffle={handleShuffle}
        resultCount={visibleProfiles.length}
        filters={discovery.filters}
        activeFilterCount={advancedFilterCount}
        onOpenFilters={openFilters}
        onClearFilters={clearEverything}
        availableRoles={availableRoles}
      />
      <DiscoveryToolbar
        query={discovery.query}
        onQueryChange={handleQueryChange}
        searchOpen={searchOpen}
        onSearchOpen={handleSearchOpen}
        onSearchClose={() => setSearchOpen(false)}
        role={effectiveRole}
        onRoleChange={handleRoleChange}
        unseen={discovery.unseen}
        onUnseenChange={handleUnseenChange}
        saved={discovery.saved}
        onSavedChange={handleSavedChange}
        onShuffle={handleShuffle}
        onOpenFilters={openFilters}
        activeFilterCount={sheetFilterCount}
        resultCount={visibleProfiles.length}
        availableRoles={availableRoles}
        desktopRail
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
          visibleResults.map(({ profile, matchContext }, index) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              index={index}
              total={visibleProfiles.length}
              active={profile.id === activeProfileId}
              showHint={index === 0 && totalActiveControls === 0}
              onOpenProfile={handleOpenProfile}
              datasetSlug={datasetSlug}
              matchContext={matchContext}
            />
          ))
        ) : (
          <section className="empty-results" role="status">
            <div className="empty-icon"><SearchX size={28} /></div>
            <p>{discovery.saved ? (savedIds.length ? 'No saved profiles match these filters.' : 'No saved profiles yet. Bookmark profiles you want to revisit.') : 'No profiles found'}</p>
            <h1>{discovery.saved ? 'Save profiles with the bookmark icon to build your personal list.' : 'Try a different search or broaden your filters.'}</h1>
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
        onClose={closeFilters}
        onApply={handleApplyFilters}
        initialSection={filterSheetSection}
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
