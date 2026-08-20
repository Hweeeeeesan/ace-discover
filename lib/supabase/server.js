import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabasePublicConfig } from './config.js';
export { createSupabasePublicClient } from './public.js';

export async function createSupabaseServerClient() {
  const { url, publishableKey, configured } = getSupabasePublicConfig();
  if (!configured) return null;
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies. proxy.js refreshes them.
        }
      },
    },
  });
}

export function createSupabaseServiceClient() {
  if (!getSupabasePublicConfig().configured || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { url } = getSupabasePublicConfig();
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
