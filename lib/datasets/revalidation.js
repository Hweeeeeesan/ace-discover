import 'server-only';

import { revalidatePath } from 'next/cache';
import { PUBLIC_DISCOVERY_SEARCH_PATH } from '../discovery-search.js';

export const PUBLIC_DISCOVERY_PATH = '/';

/**
 * Mark the shared public Discovery page stale after a successful mutation.
 * App Router regenerates it on the next request and reuses that result until
 * the next invalidation or the route's bounded ISR interval expires.
 */
export function revalidatePublicDiscovery() {
  revalidatePath(PUBLIC_DISCOVERY_PATH);
  revalidatePath(PUBLIC_DISCOVERY_SEARCH_PATH);
}
