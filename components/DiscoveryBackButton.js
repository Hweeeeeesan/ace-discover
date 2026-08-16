'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { discoveryNavigationKey, discoveryStorageKey } from '../lib/discovery';

export default function DiscoveryBackButton({
  className = '',
  iconOnly = false,
  profileId = '',
  datasetSlug = 'fall-2025',
  children = 'Back to discovery',
}) {
  const router = useRouter();

  function goBack() {
    let canUseHistory = false;

    try {
      const stateExists = Boolean(window.sessionStorage.getItem(discoveryStorageKey(datasetSlug)));
      const navigation = JSON.parse(window.sessionStorage.getItem(discoveryNavigationKey(datasetSlug)) || 'null');
      const recent = navigation?.at && Date.now() - navigation.at < 4 * 60 * 60 * 1000;
      const sameProfile = !profileId || navigation?.profileId === profileId;
      canUseHistory = stateExists && recent && sameProfile && window.history.length > 1;
    } catch {
      canUseHistory = false;
    }

    if (canUseHistory) router.back();
    else router.push('/');
  }

  return (
    <button
      className={className}
      type="button"
      onClick={goBack}
      aria-label={iconOnly ? 'Back to discovery feed' : undefined}
    >
      {iconOnly ? <ArrowLeft size={20} /> : children}
    </button>
  );
}
