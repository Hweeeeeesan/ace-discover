'use client';

import { useEffect } from 'react';
import { markProfileSeen, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';

export default function SeenProfileMarker({ profileId }) {
  useEffect(() => {
    markProfileSeen(profileId);
    window.dispatchEvent(new Event(SEEN_CHANGE_EVENT));
  }, [profileId]);
  return null;
}
