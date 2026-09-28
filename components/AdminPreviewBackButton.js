'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  ADMIN_PROFILE_RETURN_MARKER_KEY,
  isValidAdminProfileReturnMarker,
} from '../lib/admin/profile-navigation';

export default function AdminPreviewBackButton({
  datasetId,
  returnTo,
  className = '',
  iconOnly = false,
  children = 'Back to Admin dataset',
}) {
  const pathname = usePathname();
  const router = useRouter();

  function goBack() {
    let marker = null;
    try {
      marker = JSON.parse(window.sessionStorage.getItem(ADMIN_PROFILE_RETURN_MARKER_KEY) || 'null');
    } catch {
      marker = null;
    }
    if (window.history.length > 1 && isValidAdminProfileReturnMarker(marker, {
      datasetId,
      profilePath: pathname,
      returnTo,
    })) {
      window.sessionStorage.removeItem(ADMIN_PROFILE_RETURN_MARKER_KEY);
      router.back();
      return;
    }
    router.replace(returnTo);
  }

  return (
    <button
      className={className}
      type="button"
      onClick={goBack}
      aria-label={iconOnly ? 'Back to Admin profile list' : undefined}
    >
      {iconOnly ? <span aria-hidden="true">←</span> : children}
    </button>
  );
}
