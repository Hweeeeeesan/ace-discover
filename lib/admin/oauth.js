const CALLBACK_PATH = '/auth/callback?next=/admin';

/**
 * Build the browser-origin callback used by the Admin Google OAuth flow.
 * The origin is supplied by window.location.origin, never ACE_APP_ORIGIN or
 * Supabase's Site URL, so local and deployed logins return to where they began.
 */
export function adminOAuthRedirect(origin) {
  const candidate = String(origin || '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('A valid browser origin is required for Admin OAuth.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== candidate) {
    throw new Error('A valid browser origin is required for Admin OAuth.');
  }
  return `${parsed.origin}${CALLBACK_PATH}`;
}
