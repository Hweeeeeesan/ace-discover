import { NextResponse } from 'next/server';
import { safeAdminRedirect } from '../../../lib/admin/redirects';
import { createSupabaseServerClient } from '../../../lib/supabase/server';

export async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeAdminRedirect(url.searchParams.get('next'));
  const supabase = await createSupabaseServerClient();

  if (code && supabase) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }

  return NextResponse.redirect(new URL('/admin?authError=1', url.origin));
}
