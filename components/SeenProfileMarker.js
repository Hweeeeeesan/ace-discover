'use client';

import { useEffect } from 'react';
import { markProfileSeen, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';

export default function SeenProfileMarker({ profileId, datasetSlug = 'fall-2025' }) {
  useEffect(() => {
    markProfileSeen(profileId, datasetSlug);
    window.dispatchEvent(new Event(SEEN_CHANGE_EVENT));
  }, [datasetSlug, profileId]);
  return null;
}
