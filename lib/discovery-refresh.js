export function discoveryNavigationMarkerId(marker) {
  if (!marker || typeof marker !== 'object') return '';
  if (typeof marker.nonce === 'string' && marker.nonce) return marker.nonce;
  if (typeof marker.profileId === 'string' && marker.profileId && Number.isFinite(Number(marker.at))) {
    return `${marker.profileId}:${Number(marker.at)}`;
  }
  return '';
}

/**
 * Coordinates freshness refreshes which can be emitted by several browser
 * lifecycle events for one logical resume. The coordinator is framework-agnostic
 * so the event policy can be tested without a browser.
 */
export function createDiscoveryRefreshCoordinator({
  refresh,
  consumeReturnMarker = () => {},
  queueTask = (callback) => queueMicrotask(callback),
  onError = () => {},
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('A refresh function is required.');

  const state = {
    disposed: false,
    inactive: false,
    queued: false,
    inFlight: false,
    cycleRefreshScheduled: false,
    pendingReturnMarker: null,
    lastConsumedReturnMarker: '',
  };

  function schedule(reason, returnMarker = null) {
    if (state.disposed) return false;

    const markerId = discoveryNavigationMarkerId(returnMarker);
    if (markerId && markerId === state.lastConsumedReturnMarker) return false;

    if (state.queued || state.inFlight || state.cycleRefreshScheduled) {
      if (markerId && !state.pendingReturnMarker) {
        state.pendingReturnMarker = { markerId, marker: returnMarker };
      }
      return false;
    }

    state.cycleRefreshScheduled = true;
    state.queued = true;
    state.pendingReturnMarker = markerId
      ? { markerId, marker: returnMarker }
      : null;

    queueTask(() => {
      state.queued = false;
      if (state.disposed || state.inFlight) return;

      state.inFlight = true;
      const pendingMarker = state.pendingReturnMarker;
      state.pendingReturnMarker = null;

      try {
        refresh(reason);
        if (pendingMarker) {
          consumeReturnMarker(pendingMarker.marker);
          state.lastConsumedReturnMarker = pendingMarker.markerId;
        }
      } catch (error) {
        state.inFlight = false;
        state.cycleRefreshScheduled = false;
        state.pendingReturnMarker = pendingMarker;
        onError(error);
      }
    });

    return true;
  }

  return {
    requestReturnRefresh(marker) {
      return schedule('profile-return', marker);
    },

    markInactive() {
      if (state.disposed) return;
      state.inactive = true;
      if (!state.queued && !state.inFlight) state.cycleRefreshScheduled = false;
    },

    requestResumeRefresh(reason = 'resume', { persisted = false } = {}) {
      if (state.disposed) return false;
      if (!state.inactive && !persisted) return false;
      state.inactive = false;
      return schedule(reason);
    },

    settle() {
      state.inFlight = false;
      if (state.inactive) state.cycleRefreshScheduled = false;
    },

    dispose() {
      state.disposed = true;
      state.pendingReturnMarker = null;
    },

    snapshot() {
      return { ...state };
    },
  };
}
