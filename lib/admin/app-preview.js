export const ADMIN_PREVIEW_DEVICES = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, label: '1440 × 900' }),
  mobile: Object.freeze({ width: 390, height: 844, label: '390 × 844' }),
});

export const DEFAULT_ADMIN_PREVIEW_DEVICE = 'desktop';
export const DEFAULT_ADMIN_PREVIEW_PATH = '/';

export function safePublicPreviewPath(value, currentOrigin) {
  try {
    const origin = new URL(currentOrigin).origin;
    const candidate = new URL(String(value || DEFAULT_ADMIN_PREVIEW_PATH), origin);
    const isPublicRoute = candidate.pathname === '/'
      || candidate.pathname.startsWith('/profile/');
    if (candidate.origin !== origin || !isPublicRoute) return DEFAULT_ADMIN_PREVIEW_PATH;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return DEFAULT_ADMIN_PREVIEW_PATH;
  }
}
