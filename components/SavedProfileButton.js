'use client';

import { Bookmark } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  isProfileSaved,
  readSavedIds,
  SAVED_CHANGE_EVENT,
  toggleSavedProfile,
} from '../lib/saved-profiles';

export default function SavedProfileButton({ profileId, datasetSlug = 'fall-2025', className = '' }) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const refresh = (event) => {
      if (!event?.detail?.datasetSlug || event.detail.datasetSlug === datasetSlug) {
        setSaved(isProfileSaved(profileId, datasetSlug));
      }
    };
    setSaved(isProfileSaved(profileId, datasetSlug));
    window.addEventListener(SAVED_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SAVED_CHANGE_EVENT, refresh);
  }, [datasetSlug, profileId]);

  function handleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    toggleSavedProfile(profileId, datasetSlug);
    setSaved(readSavedIds(datasetSlug).includes(profileId));
  }

  return (
    <button
      className={`saved-profile-button${saved ? ' is-saved' : ''}${className ? ` ${className}` : ''}`}
      type="button"
      onClick={handleClick}
      aria-label={saved ? 'Remove from saved' : 'Save profile'}
      aria-pressed={saved}
      title={saved ? 'Remove from saved' : 'Save profile'}
    >
      <Bookmark size={21} fill={saved ? 'currentColor' : 'none'} />
    </button>
  );
}
