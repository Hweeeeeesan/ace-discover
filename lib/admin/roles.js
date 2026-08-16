function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function readAdminAuthorization(env = process.env) {
  const ownerEmail = normalizeEmail(env.ACE_OWNER_EMAIL);
  const adminEmails = new Set(
    String(env.ACE_ADMIN_EMAILS || '')
      .split(',')
      .map(normalizeEmail)
      .filter(Boolean),
  );
  return { ownerEmail, adminEmails };
}

export function roleForEmail(email, env = process.env) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const { ownerEmail, adminEmails } = readAdminAuthorization(env);
  if (ownerEmail && normalized === ownerEmail) return 'owner';
  if (adminEmails.has(normalized)) return 'admin';
  return null;
}
