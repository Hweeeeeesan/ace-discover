import 'server-only';

import { getSupabasePublicConfig } from './supabase/config.js';
import {
  DEFAULT_PROFILE_IMAGE_BUCKET,
  withResolvedProfileImage,
} from './profile-images.js';

export function resolveProfileImage(profile) {
  const { url } = getSupabasePublicConfig();
  return withResolvedProfileImage(profile, {
    supabaseUrl: url,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET,
  });
}

export function resolveProfileImages(profiles = []) {
  return profiles.map(resolveProfileImage);
}
