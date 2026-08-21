import { randomUUID } from 'node:crypto';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { createSupabaseServiceClient } from '../../../../../lib/supabase/server';
import {
  MAX_PROFILE_IMAGE_BYTES,
  detectImageContentType,
  normalizeImageOrientation,
} from '../../../../../lib/profile-image-ingestion';
import { buildProfileImageStoragePath } from '../../../../../lib/profile-images';
import {
  createAdminProfileImage,
  getAdminImageContext,
} from '../../../../../lib/datasets/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'profile-images';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  let storagePath = '';
  const supabase = createSupabaseServiceClient();
  try {
    if (!supabase) throw new Error('Supabase database administration is not configured.');
    const form = await request.formData();
    const datasetId = String(form.get('datasetId') || '');
    const profileId = String(form.get('profileId') || '');
    const file = form.get('file');
    const makePrimary = String(form.get('makePrimary') || '') === 'true';
    if (!UUID.test(datasetId) || !profileId || !file || typeof file.arrayBuffer !== 'function') {
      return Response.json({ error: 'A dataset, profile, and image file are required.' }, { status: 400 });
    }
    if (Number(file.size) > MAX_PROFILE_IMAGE_BYTES) {
      return Response.json({ error: 'The image exceeds the 15 MiB size limit.' }, { status: 413 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_PROFILE_IMAGE_BYTES) {
      return Response.json({ error: 'The image exceeds the 15 MiB size limit.' }, { status: 413 });
    }
    const sourceType = detectImageContentType(bytes);
    if (!sourceType) return Response.json({ error: 'The uploaded file is not a supported image.' }, { status: 400 });
    let normalized;
    try {
      normalized = await normalizeImageOrientation(bytes, sourceType);
    } catch {
      return Response.json({ error: 'The uploaded image is corrupt or could not be decoded safely.' }, { status: 400 });
    }
    if (normalized.bytes.length > MAX_PROFILE_IMAGE_BYTES) {
      return Response.json({ error: 'The normalized image exceeds the 15 MiB size limit.' }, { status: 413 });
    }

    const { dataset } = await getAdminImageContext(datasetId, profileId);
    const imageId = randomUUID();
    storagePath = buildProfileImageStoragePath(dataset.slug, profileId, imageId, normalized.contentType);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, normalized.bytes, {
      contentType: normalized.contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (uploadError) throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);

    const image = await createAdminProfileImage({
      datasetId,
      profileId,
      imageId,
      storagePath,
      makePrimary,
    });
    return Response.json({ ok: true, image });
  } catch (error) {
    if (storagePath && supabase) await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    return Response.json({ error: error.message || 'The image could not be added.' }, { status: 422 });
  }
}
