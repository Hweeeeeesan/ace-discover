import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import { createSupabaseServiceClient } from '../../../../../../lib/supabase/server';
import {
  buildDiscoveryDerivativeStoragePath,
  buildProfileImageStoragePath,
  isValidProfileImageId,
} from '../../../../../../lib/profile-images';
import {
  detectImageContentType,
  generateProfileImageAssets,
  MAX_PROFILE_IMAGE_BYTES,
  rotateImage,
} from '../../../../../../lib/profile-image-ingestion';
import {
  deleteAdminProfileImage,
  getAdminImageContext,
  getAdminProfileImage,
  replaceAdminProfileImageStoragePath,
  reorderAdminProfileImages,
  setAdminProfileImagePrimary,
} from '../../../../../../lib/datasets/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'profile-images';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '');
    const action = String(body?.action || '');
    if (!UUID.test(datasetId) || !profileId) {
      return Response.json({ error: 'Invalid profile image request.' }, { status: 400 });
    }

    let result;
    if (action === 'set-primary' || action === 'delete' || action === 'rotate-left' || action === 'rotate-right') {
      const imageId = String(body?.imageId || '');
      if (!isValidProfileImageId(imageId)) return Response.json({ error: 'Invalid profile image request.' }, { status: 400 });
      if (action === 'rotate-left' || action === 'rotate-right') {
        const supabase = createSupabaseServiceClient();
        if (!supabase) throw new Error('Supabase database administration is not configured.');
        const image = await getAdminProfileImage({ datasetId, profileId, imageId });
        const { dataset } = await getAdminImageContext(datasetId, profileId);
        const { data: stored, error: downloadError } = await supabase.storage.from(BUCKET).download(image.storagePath);
        if (downloadError || !stored) throw new Error('The profile image could not be read from Storage.');
        const bytes = Buffer.from(await stored.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_PROFILE_IMAGE_BYTES) throw new Error('The stored image exceeds the 15 MiB size limit.');
        const contentType = detectImageContentType(bytes);
        if (!contentType) throw new Error('The stored object is not a supported image.');
        const rotated = await rotateImage(bytes, contentType, action === 'rotate-left' ? 270 : 90);
        const assets = await generateProfileImageAssets(rotated.bytes);
        const replacementId = randomUUID();
        const rotatedPath = buildProfileImageStoragePath(dataset.slug, profileId, replacementId, assets.canonical.contentType);
        const discoveryPath = buildDiscoveryDerivativeStoragePath(dataset.slug, profileId, replacementId);
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(rotatedPath, assets.canonical.bytes, {
          contentType: assets.canonical.contentType,
          cacheControl: '31536000',
          upsert: false,
        });
        if (uploadError) throw new Error(`The rotated image could not be saved: ${uploadError.message}`);
        const { error: discoveryUploadError } = await supabase.storage.from(BUCKET).upload(discoveryPath, assets.discovery.bytes, {
          contentType: assets.discovery.contentType,
          cacheControl: '31536000',
          upsert: false,
        });
        if (discoveryUploadError) {
          await supabase.storage.from(BUCKET).remove([rotatedPath]).catch(() => {});
          throw new Error(`The rotated Discovery derivative could not be saved: ${discoveryUploadError.message}`);
        }
        try {
          result = await replaceAdminProfileImageStoragePath({
            datasetId,
            profileId,
            imageId,
            storagePath: rotatedPath,
            discoveryStoragePath: discoveryPath,
            discoveryWidth: assets.discovery.width,
            discoveryHeight: assets.discovery.height,
            discoveryMimeType: assets.discovery.contentType,
            discoveryByteLength: assets.discovery.byteLength,
          });
        } catch (error) {
          await supabase.storage.from(BUCKET).remove([rotatedPath, discoveryPath]).catch(() => {});
          throw error;
        }
        await supabase.storage.from(BUCKET).remove(
          [image.storagePath, image.discoveryStoragePath].filter(Boolean),
        ).catch(() => {});
        result = {
          ...result,
          rotated: true,
          previousStoragePath: image.storagePath,
          previousDiscoveryStoragePath: image.discoveryStoragePath,
        };
      } else if (action === 'set-primary') {
        result = await setAdminProfileImagePrimary({ datasetId, profileId, imageId });
      } else {
        // The delete RPC owns the atomic row/profile-state change. Capture the
        // immutable derivative first so both objects can be removed afterward.
        const image = await getAdminProfileImage({ datasetId, profileId, imageId });
        result = {
          ...await deleteAdminProfileImage({ datasetId, profileId, imageId }),
          discoveryStoragePath: image.discoveryStoragePath,
        };
      }
      if (action === 'delete' && result?.storagePath) {
        const supabase = createSupabaseServiceClient();
        if (supabase) await supabase.storage.from(BUCKET).remove(
          [result.storagePath, result.discoveryStoragePath].filter(Boolean),
        );
      }
    } else if (action === 'reorder') {
      const imageIds = Array.isArray(body?.imageIds) ? body.imageIds.map(String) : [];
      if (!imageIds.length || imageIds.some((imageId) => !isValidProfileImageId(imageId))) {
        return Response.json({ error: 'A complete ordered image list is required.' }, { status: 400 });
      }
      result = await reorderAdminProfileImages({ datasetId, profileId, imageIds });
    } else {
      return Response.json({ error: 'Unsupported profile image action.' }, { status: 400 });
    }

    const datasetSlug = String(body?.datasetSlug || '');
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(datasetSlug)) {
      revalidatePath(`/profile/${datasetSlug}/${encodeURIComponent(profileId)}`);
    }
    revalidatePath('/');
    revalidatePath(`/admin/preview/${datasetId}/${encodeURIComponent(profileId)}`);
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json({ error: error.message || 'The profile image action failed.' }, { status: 422 });
  }
}
