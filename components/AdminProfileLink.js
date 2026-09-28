'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  ADMIN_PROFILE_RETURN_MARKER_KEY,
  adminProfileListPath,
  adminProfileListScrollKey,
  adminProfilePreviewPath,
  createAdminProfileReturnMarker,
  safeAdminProfileListReturn,
} from '../lib/admin/profile-navigation';

function currentListReturn(pathname, searchParams, datasetId) {
  const query = searchParams.toString();
  return safeAdminProfileListReturn(`${pathname}${query ? `?${query}` : ''}`, datasetId);
}

export function AdminProfileListScrollRestoration({ datasetId }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = currentListReturn(pathname, searchParams, datasetId);

  useEffect(() => {
    const stored = Number(window.sessionStorage.getItem(adminProfileListScrollKey(returnTo, datasetId)));
    if (!Number.isFinite(stored) || stored < 0) return undefined;
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: stored, behavior: 'auto' }));
    return () => window.cancelAnimationFrame(frame);
  }, [datasetId, returnTo]);

  return null;
}

export default function AdminProfileLink({ datasetId, profileId, hash = '', children, ...props }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = currentListReturn(pathname, searchParams, datasetId);
  const href = adminProfilePreviewPath({ datasetId, profileId, returnTo, hash });

  function rememberReturn(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey || props.target === '_blank') return;
    const profilePath = `${adminProfileListPath(datasetId)}/${encodeURIComponent(profileId)}`;
    window.sessionStorage.setItem(
      adminProfileListScrollKey(returnTo, datasetId),
      String(Math.max(0, window.scrollY)),
    );
    window.sessionStorage.setItem(
      ADMIN_PROFILE_RETURN_MARKER_KEY,
      JSON.stringify(createAdminProfileReturnMarker({ datasetId, profilePath, returnTo })),
    );
  }

  return <Link {...props} href={href} onClick={rememberReturn}>{children}</Link>;
}
