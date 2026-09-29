import sharp from 'sharp';
import { validatedImageFromResponse } from './profile-image-ingestion.js';

export const ADMIN_DRIVE_THUMBNAIL_LONG_EDGE = 640;

export async function renderAdminDriveThumbnail(upstream) {
  if (!upstream) throw new Error('Drive image could not be read.');
  const image = await validatedImageFromResponse(upstream);
  const bytes = await sharp(image.bytes)
    .resize({
      width: ADMIN_DRIVE_THUMBNAIL_LONG_EDGE,
      height: ADMIN_DRIVE_THUMBNAIL_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 76, effort: 3 })
    .toBuffer();
  const source = upstream.headers.get('x-drive-download-source') || 'unknown';
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Drive-Thumbnail-Source': source,
    },
  });
}
