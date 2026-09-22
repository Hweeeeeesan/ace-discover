import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { createSupabaseServiceClient } from '../../../../../lib/supabase/server';
import {
  generateProfileImageAssets,
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  ProfileImageIngestionError,
} from '../../../../../lib/profile-image-ingestion';
import {
  buildDiscoveryDerivativeStoragePath,
  buildProfileImageStoragePath,
} from '../../../../../lib/profile-images';
import {
  createAdminProfileImage,
  getAdminImageContext,
} from '../../../../../lib/datasets/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'profile-images';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  const stagedPaths = [];
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
    let assets;
    try {
      assets = await generateProfileImageAssets(bytes);
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
    const storagePath = buildProfileImageStoragePath(dataset.slug, profileId, imageId, assets.canonical.contentType);
    const discoveryStoragePath = buildDiscoveryDerivativeStoragePath(dataset.slug, profileId, imageId);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, assets.canonical.bytes, {
      contentType: assets.canonical.contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (uploadError) throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
    stagedPaths.push(storagePath);
    const { error: discoveryUploadError } = await supabase.storage.from(BUCKET).upload(
      discoveryStoragePath,
      assets.discovery.bytes,
      {
        contentType: assets.discovery.contentType,
        cacheControl: '31536000',
        upsert: false,
      },
    );
    if (discoveryUploadError) throw new Error(`Supabase Storage derivative upload failed: ${discoveryUploadError.message}`);
    stagedPaths.push(discoveryStoragePath);

    const image = await createAdminProfileImage({
      datasetId,
      profileId,
      imageId,
      storagePath,
      discoveryStoragePath,
      discoveryWidth: assets.discovery.width,
      discoveryHeight: assets.discovery.height,
      discoveryMimeType: assets.discovery.contentType,
      discoveryByteLength: assets.discovery.byteLength,
      makePrimary,
    });
    revalidatePath('/');
    revalidatePath(`/profile/${dataset.slug}/${encodeURIComponent(profileId)}`);
    revalidatePath(`/admin/preview/${datasetId}/${encodeURIComponent(profileId)}`);
    return Response.json({
      ok: true,
      image,
      normalization: {
        originalBytes: assets.originalByteLength,
        finalBytes: assets.canonical.byteLength,
        originalWidth: assets.originalWidth,
        originalHeight: assets.originalHeight,
        finalWidth: assets.canonical.width,
        finalHeight: assets.canonical.height,
        finalMime: assets.canonical.contentType,
        discoveryBytes: assets.discovery.byteLength,
        discoveryWidth: assets.discovery.width,
        discoveryHeight: assets.discovery.height,
        discoveryMime: assets.discovery.contentType,
        diagnostics: assets.diagnostics,
      },
    });
  } catch (error) {
    if (stagedPaths.length && supabase) await supabase.storage.from(BUCKET).remove(stagedPaths).catch(() => {});
    return Response.json({ error: error.message || 'The image could not be added.' }, { status: 422 });
  }
}
