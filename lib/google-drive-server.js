import { createSign } from 'node:crypto';

const GOOGLE_READ_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
].join(' ');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FOLDER_DEPTH = 2;
const MAX_CHILDREN_PER_FOLDER = 1000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

let cachedAccessToken = null;

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function cleanPrivateKey(value) {
  return value ? value.replace(/\\n/g, '\n').trim() : '';
}

export class DriveAuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveAuthConfigurationError';
  }
}

function getServiceAccountCredentials({ strict = false } = {}) {
  const encodedJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (encodedJson || rawJson) {
    try {
      const jsonText = encodedJson
        ? Buffer.from(encodedJson, 'base64').toString('utf8')
        : rawJson;
      const credentials = JSON.parse(jsonText);
      if (credentials.client_email && credentials.private_key) {
        return {
          email: credentials.client_email,
          privateKey: cleanPrivateKey(credentials.private_key),
        };
      }
    } catch (error) {
      if (strict) throw new DriveAuthConfigurationError('Google service-account JSON could not be parsed.');
      console.warn('Google service account JSON could not be parsed.');
    }
    if (strict) throw new DriveAuthConfigurationError('Google service-account JSON must include client_email and private_key.');
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = cleanPrivateKey(
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY,
  );

  if (!email && !privateKey) return null;
  if (!email || !privateKey) {
    if (strict) throw new DriveAuthConfigurationError('Google service-account email and private key must be provided together.');
    return null;
  }
  return { email, privateKey };
}

export function getGoogleServiceAccountEmail() {
  return getServiceAccountCredentials()?.email
    || 'ace-discover-drive@ace-discover.iam.gserviceaccount.com';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeToken(body) {
  const response = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      cache: 'no-store',
    },
    12000,
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  const token = await response.json();
  return {
    accessToken: token.access_token,
    expiresIn: Number(token.expires_in || 3600),
  };
}

async function getRefreshTokenAccessToken() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  return exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

async function getServiceAccountAccessToken({ strict = false } = {}) {
  const credentials = getServiceAccountCredentials({ strict });
  if (!credentials) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = {
    iss: credentials.email,
    scope: GOOGLE_READ_SCOPES,
    aud: TOKEN_URL,
    iat: issuedAt - 30,
    // Keep the assertion lifetime below Google's one-hour maximum even after
    // allowing a small amount of clock skew.
    exp: issuedAt + 3500,
  };
  if (process.env.GOOGLE_IMPERSONATED_USER) {
    claims.sub = process.env.GOOGLE_IMPERSONATED_USER;
  }
  const payload = base64Url(JSON.stringify(claims));
  const unsignedJwt = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer
    .sign(credentials.privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return exchangeToken({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsignedJwt}.${signature}`,
  });
}

export async function getDriveAuth({ strict = false, serviceAccountOnly = false } = {}) {
  const staticAccessToken = serviceAccountOnly ? '' : process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  if (staticAccessToken) {
    return { accessToken: staticAccessToken, apiKey: null, mode: 'access-token', authenticated: true };
  }

  const now = Date.now();
  if (cachedAccessToken
    && cachedAccessToken.expiresAt > now + 60_000
    && (!serviceAccountOnly || cachedAccessToken.mode === 'service-account')) {
    return {
      accessToken: cachedAccessToken.accessToken,
      apiKey: process.env.GOOGLE_DRIVE_API_KEY || null,
      mode: cachedAccessToken.mode,
      authenticated: true,
    };
  }

  let token = null;
  let mode = null;

  if (!serviceAccountOnly) {
    try {
      token = await getRefreshTokenAccessToken();
      mode = token ? 'oauth-refresh-token' : null;
    } catch {
      console.warn('Google Drive OAuth refresh-token authentication failed.');
    }
  }

  if (!token) {
    try {
      token = await getServiceAccountAccessToken({ strict });
      mode = token ? 'service-account' : null;
    } catch (error) {
      if (strict && error instanceof DriveAuthConfigurationError) throw error;
      if (strict && (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
        || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
        || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
        || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64)) {
        throw new DriveAuthConfigurationError(
          'Google service-account authentication failed. Check that the credentials are valid and authorized.',
        );
      }
      console.warn('Google Drive service-account authentication failed.');
    }
  }

  if (token) {
    cachedAccessToken = {
      accessToken: token.accessToken,
      expiresAt: now + Math.max(300, token.expiresIn - 60) * 1000,
      mode,
    };
  }

  return {
    accessToken: token?.accessToken || null,
    apiKey: process.env.GOOGLE_DRIVE_API_KEY || null,
    mode: mode || (process.env.GOOGLE_DRIVE_API_KEY ? 'api-key' : 'public-only'),
    authenticated: Boolean(token?.accessToken),
  };
}

function withApiKey(url, apiKey) {
  if (!apiKey) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('key', apiKey);
  return parsed.toString();
}

async function driveApiFetch(path, auth, options = {}) {
  const url = withApiKey(`${DRIVE_API_BASE}${path}`, auth.apiKey);
  const headers = new Headers(options.headers || {});
  if (auth.accessToken) headers.set('Authorization', `Bearer ${auth.accessToken}`);

  return fetchWithTimeout(
    url,
    {
      ...options,
      headers,
      cache: 'no-store',
    },
    15000,
  );
}

async function readJson(response, label) {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${label} failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  return response.json();
}

function scoreImage(file) {
  const name = String(file.name || '').toLowerCase();
  const preferredWords = ['profile', 'headshot', 'portrait', 'selfie', 'pfp', 'picture', 'photo'];
  let score = preferredWords.some((word) => name.includes(word)) ? 1000 : 0;

  if (/\.(jpe?g|png|webp|avif)$/i.test(name)) score += 100;
  if (file.mimeType === 'image/jpeg' || file.mimeType === 'image/png' || file.mimeType === 'image/webp') {
    score += 50;
  }

  const size = Number(file.size || 0);
  if (size > 0) score += Math.min(25, Math.log10(size) * 3);

  const modified = Date.parse(file.modifiedTime || 0);
  if (Number.isFinite(modified)) score += modified / 1e13;

  return score;
}

export function compareDriveFilesNaturally(left, right) {
  const byName = String(left?.name || '').localeCompare(String(right?.name || ''), 'en', {
    numeric: true,
    sensitivity: 'base',
  });
  return byName || String(left?.id || '').localeCompare(String(right?.id || ''), 'en');
}

async function listFolderChildren(folderId, auth) {
  if (!auth.accessToken && !auth.apiKey) {
    throw new Error('Folder links require Google Drive API credentials.');
  }

  const query = `'${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    pageSize: '100',
    orderBy: 'name_natural',
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  const files = [];
  let pageToken = '';
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const response = await driveApiFetch(`/files?${params.toString()}`, auth);
    const data = await readJson(response, 'Listing a Google Drive folder');
    files.push(...(Array.isArray(data.files) ? data.files : []));
    pageToken = String(data.nextPageToken || '');
  } while (pageToken && files.length < MAX_CHILDREN_PER_FOLDER);
  return files.slice(0, MAX_CHILDREN_PER_FOLDER);
}

/**
 * Return supported direct-child image metadata for recovery tooling. This is
 * separate from the legacy proxy resolver, which may recurse and score a
 * candidate for compatibility with existing public rendering.
 */
export async function listImageFilesInFolder(folderId, auth) {
  const children = await listFilesInFolder(folderId, auth);
  return children.filter((file) => [
    'image/avif',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
  ].includes(String(file.mimeType || '').toLowerCase()));
}

/**
 * Return deterministic direct-child metadata for folder gallery ingestion.
 * Google Drive does not expose a user-defined folder position, so filename
 * natural order is the canonical order (photo2 precedes photo10).
 */
export async function listFilesInFolder(folderId, auth) {
  return (await listFolderChildren(folderId, auth)).sort(compareDriveFilesNaturally);
}

export async function resolveImageFileFromFolder(folderId, auth, depth = 0, visited = new Set()) {
  if (depth > MAX_FOLDER_DEPTH || visited.has(folderId)) return null;
  visited.add(folderId);

  const children = await listFolderChildren(folderId, auth);
  const images = children
    .filter((file) => String(file.mimeType || '').startsWith('image/'))
    .sort((a, b) => scoreImage(b) - scoreImage(a));

  if (images.length) return images[0];

  const folders = children.filter((file) => file.mimeType === GOOGLE_FOLDER_MIME);
  for (const folder of folders.slice(0, 10)) {
    const image = await resolveImageFileFromFolder(folder.id, auth, depth + 1, visited);
    if (image) return image;
  }

  return null;
}

async function getFileMetadata(fileId, auth) {
  if (!auth.accessToken && !auth.apiKey) return null;

  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,thumbnailLink',
    supportsAllDrives: 'true',
  });
  const response = await driveApiFetch(`/files/${encodeURIComponent(fileId)}?${params.toString()}`, auth);

  if (!response.ok) return null;
  return response.json();
}

function isUsableImageResponse(response) {
  if (!response.ok || !response.body) return false;

  const contentType = String(response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!SAFE_IMAGE_TYPES.has(contentType)) return false;

  const contentLength = Number(response.headers.get('content-length') || 0);
  return !contentLength || contentLength <= MAX_IMAGE_BYTES;
}

async function tryImageUrl(url, options = {}, sourceLabel = 'unknown') {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        cache: 'no-store',
        ...options,
      },
      15000,
    );

    if (isUsableImageResponse(response)) return response;
    await response.body?.cancel().catch(() => {});
  } catch {
    console.warn(`Google Drive image source failed (${sourceLabel}).`);
  }
  return null;
}

function withDownloadSource(response, source) {
  if (!response) return null;
  const headers = new Headers(response.headers);
  headers.set('X-Drive-Download-Source', source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function tryOriginalDriveMedia(fileId, auth) {
  if (!auth.accessToken && !auth.apiKey) return null;

  try {
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    const response = await driveApiFetch(`/files/${encodeURIComponent(fileId)}?${params.toString()}`, auth);
    if (isUsableImageResponse(response)) return withDownloadSource(response, 'original_media');
    await response.body?.cancel().catch(() => {});
  } catch {
    console.warn('Google Drive original media download failed; trying safe fallbacks.');
  }
  return null;
}

async function tryPublicFullFile(fileId) {
  const encoded = encodeURIComponent(fileId);
  const candidates = [
    `https://drive.usercontent.google.com/download?id=${encoded}&export=view&authuser=0`,
    `https://drive.google.com/uc?export=view&id=${encoded}`,
  ];

  for (const candidate of candidates) {
    const response = await tryImageUrl(candidate, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'ProfileGalleryImageProxy/1.0',
      },
    }, 'public_full_file');
    if (response) return withDownloadSource(response, 'public_full_file');
  }

  return null;
}

async function tryThumbnailFallback(fileId, auth, metadata) {
  if (metadata?.thumbnailLink) {
    const headers = auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};
    const thumbnail = await tryImageUrl(metadata.thumbnailLink, { headers }, 'metadata_thumbnail');
    if (thumbnail) return withDownloadSource(thumbnail, 'thumbnail_fallback');
  }

  const encoded = encodeURIComponent(fileId);
  const candidates = [
    `https://drive.google.com/thumbnail?id=${encoded}&sz=w2000`,
    `https://lh3.googleusercontent.com/d/${encoded}=w2000`,
  ];
  for (const candidate of candidates) {
    const response = await tryImageUrl(candidate, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'ProfileGalleryImageProxy/1.0',
      },
    }, 'public_thumbnail');
    if (response) return withDownloadSource(response, 'thumbnail_fallback');
  }
  return null;
}

export async function fetchDriveImage(fileId, auth) {
  const metadata = await getFileMetadata(fileId, auth).catch(() => {
    console.warn('Unable to read Google Drive image metadata.');
    return null;
  });

  if (metadata?.mimeType && !String(metadata.mimeType).startsWith('image/')) {
    throw new Error(`Google Drive item ${fileId} is not an image (${metadata.mimeType}).`);
  }

  const original = await tryOriginalDriveMedia(fileId, auth);
  if (original) return original;

  const publicFullFile = await tryPublicFullFile(fileId);
  if (publicFullFile) return publicFullFile;

  return tryThumbnailFallback(fileId, auth, metadata);
}

export function proxyImageResponse(upstream, sourceLabel) {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
  headers.set('CDN-Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  headers.set('Vercel-CDN-Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Disposition', 'inline');
  headers.set('X-Profile-Image-Source', sourceLabel);

  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('Content-Length', contentLength);

  const declaredLength = Number(contentLength || 0);
  const body = !upstream.body || declaredLength > 0
    ? upstream.body
    : limitStreamBytes(upstream.body, MAX_IMAGE_BYTES);

  return new Response(body, { status: 200, headers });
}

function limitStreamBytes(body, maximumBytes) {
  const reader = body.getReader();
  let receivedBytes = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        receivedBytes += value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel('Google Drive image exceeded the proxy size limit.');
          controller.error(new Error('Google Drive image exceeded the proxy size limit.'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
