function configuredOrigin(value, protocol = '') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const url = new URL(protocol && !candidate.includes('://') ? `${protocol}://${candidate}` : candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== url.href.replace(/\/$/, '')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function trustedAppOrigins(requestUrl, env = process.env) {
  const origins = new Set();
  const explicit = configuredOrigin(env.ACE_APP_ORIGIN);
  const production = configuredOrigin(env.VERCEL_PROJECT_PRODUCTION_URL, 'https');
  const deployment = configuredOrigin(env.VERCEL_URL, 'https');
  if (explicit) origins.add(explicit);
  if (production) origins.add(production);
  if (deployment) origins.add(deployment);

  if (!origins.size && env.NODE_ENV !== 'production') {
    try { origins.add(new URL(requestUrl).origin); } catch {}
  }
  return origins;
}

export function evaluateAdminWriteAccess(identity, requestUrl, origin = '', env = process.env) {
  if (identity.state === 'unconfigured') return { ok: false, status: 503, error: 'Admin authentication is not configured.' };
  if (identity.state === 'unauthenticated') return { ok: false, status: 401, error: 'Authentication required.' };
  if (identity.state !== 'authorized') return { ok: false, status: 403, error: 'Access denied.' };

  let normalizedOrigin = '';
  try {
    const parsed = new URL(origin);
    if (parsed.origin === origin && ['http:', 'https:'].includes(parsed.protocol)) normalizedOrigin = parsed.origin;
  } catch {}
  if (!normalizedOrigin || !trustedAppOrigins(requestUrl, env).has(normalizedOrigin)) {
    return { ok: false, status: 403, error: 'Invalid request origin.' };
  }
  return { ok: true, status: 200, identity };
}

export function evaluateAdminReadAccess(identity, requestUrl, headers = new Headers(), env = process.env) {
  if (identity.state === 'unconfigured') return { ok: false, status: 503, error: 'Admin authentication is not configured.' };
  if (identity.state === 'unauthenticated') return { ok: false, status: 401, error: 'Authentication required.' };
  if (identity.state !== 'authorized') return { ok: false, status: 403, error: 'Access denied.' };

  const trustedOrigins = trustedAppOrigins(requestUrl, env);
  let requestOrigin = '';
  try { requestOrigin = new URL(requestUrl).origin; } catch {}
  if (!requestOrigin || !trustedOrigins.has(requestOrigin)) {
    return { ok: false, status: 403, error: 'Invalid request origin.' };
  }

  const fetchSite = String(headers.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, error: 'Cross-site Admin reads are not allowed.' };
  }

  for (const value of [headers.get('origin'), headers.get('referer')]) {
    if (!value) continue;
    let sourceOrigin = '';
    try { sourceOrigin = new URL(value).origin; } catch {}
    if (!sourceOrigin || !trustedOrigins.has(sourceOrigin)) {
      return { ok: false, status: 403, error: 'Invalid request origin.' };
    }
  }

  return { ok: true, status: 200, identity };
}
