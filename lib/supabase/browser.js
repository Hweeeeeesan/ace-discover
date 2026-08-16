'use client';

import { createBrowserClient } from '@supabase/ssr';
import { getSupabasePublicConfig } from './config.js';

let browserClient;

export function createSupabaseBrowserClient() {
  const { url, publishableKey, configured } = getSupabasePublicConfig();
  if (!configured) return null;
  if (!browserClient) browserClient = createBrowserClient(url, publishableKey);
  return browserClient;
}
