import 'server-only';

import { createSupabaseServerClient } from '../supabase/server';
import { roleForEmail } from './roles';
import { evaluateAdminWriteAccess } from './guard';

export { readAdminAuthorization, roleForEmail } from './roles';

export async function getAdminIdentity() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { state: 'unconfigured', user: null, role: null };

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { state: 'unauthenticated', user: null, role: null };

  const role = roleForEmail(data.user.email);
  return {
    state: role ? 'authorized' : 'denied',
    user: { id: data.user.id, email: data.user.email || '' },
    role,
  };
}

export async function authorizeAdminRequest(request, identityProvider = getAdminIdentity) {
  const identity = await identityProvider();
  const access = evaluateAdminWriteAccess(identity, request.url, request.headers.get('origin') || '');
  if (!access.ok) return { ok: false, response: Response.json({ error: access.error }, { status: access.status }) };
  return { ok: true, identity };
}
