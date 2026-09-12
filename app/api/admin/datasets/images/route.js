import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { createSupabaseServiceClient } from '../../../../../lib/supabase/server';
import {
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  ProfileImageIngestionError,
  normalizeProfileImage,
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
    if (Number(file.size) > MAX_PROFILE_IMAGE_INPUT_BYTES) {
      return Response.json({
        error: 'The image exceeds the 50 MiB safe normalization input limit.',
        category: 'image_input_too_large',
      }, { status: 413 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.length) return Response.json({ error: 'The uploaded image is empty.' }, { status: 400 });
    let normalized;
    try {
      normalized = await normalizeProfileImage(bytes);
    } catch (error) {
      if (error instanceof ProfileImageIngestionError) {
        const status = ['image_input_too_large', 'image_too_large_after_normalization'].includes(error.code)
          ? 413
          : 400;
        return Response.json({ error: error.message, category: error.code }, { status });
      }
      return Response.json({ error: 'The uploaded image is corrupt or could not be decoded safely.' }, { status: 400 });
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
    revalidatePath('/');
    revalidatePath(`/profile/${dataset.slug}/${encodeURIComponent(profileId)}`);
    revalidatePath(`/admin/preview/${datasetId}/${encodeURIComponent(profileId)}`);
    return Response.json({
      ok: true,
      image,
      normalization: {
        originalBytes: normalized.originalByteLength,
        finalBytes: normalized.bytes.length,
        originalWidth: normalized.originalWidth,
        originalHeight: normalized.originalHeight,
        finalWidth: normalized.width,
        finalHeight: normalized.height,
        finalMime: normalized.contentType,
        diagnostics: normalized.diagnostics,
      },
    });
  } catch (error) {
    if (storagePath && supabase) await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    return Response.json({ error: error.message || 'The image could not be added.' }, { status: 422 });
  }
}
