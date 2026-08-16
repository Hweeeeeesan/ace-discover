import { createClient } from '@supabase/supabase-js';
import { getSupabasePublicConfig } from './config.js';

export function createSupabasePublicClient() {
  const { url, publishableKey, configured } = getSupabasePublicConfig();
  if (!configured) return null;
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
