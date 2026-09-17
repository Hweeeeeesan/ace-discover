const MAX_PUBLIC_URL_LENGTH = 2048;
const URL_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/u;
const SENSITIVE_URL_PARAMETER = /(?:^|[?&#;])(?:access_token|refresh_token|id_token|client_secret|api_key|apikey|service_role_key|private_key)=/i;

export function normalizePublicHttpUrl(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (
    !candidate
    || candidate.length > MAX_PUBLIC_URL_LENGTH
    || URL_WHITESPACE_OR_CONTROL.test(candidate)
    || SENSITIVE_URL_PARAMETER.test(candidate)
  ) return '';

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    if (parsed.username || parsed.password) return '';
    return candidate;
  } catch {
    return '';
  }
}
