const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function safeAdminRedirect(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || CONTROL_CHARACTERS.test(value)) {
    return '/admin';
  }

  try {
    const base = new URL('https://ace-discover.invalid');
    const destination = new URL(value, base);
    const isAdminPath = destination.pathname === '/admin' || destination.pathname.startsWith('/admin/');
    if (destination.origin !== base.origin || !isAdminPath || !value.startsWith('/')) return '/admin';
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return '/admin';
  }
}
