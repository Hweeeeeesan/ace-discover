#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { importHealth } from '../lib/import-health.js';
import { profiles } from '../lib/profiles.js';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve('.env'));
loadEnvFile(resolve('.env.local'));

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

const sourceProfiles = JSON.parse(readFileSync(resolve('data/profiles.json'), 'utf8'));
if (sourceProfiles.length !== 210 || profiles.length !== 210) throw new Error('Fall 2025 must contain exactly 210 profiles before seeding.');
const sourceById = new Map(sourceProfiles.map((profile) => [profile.id, profile]));
const publicById = new Map(profiles.map((profile) => [profile.id, profile]));
if (sourceById.size !== publicById.size || profiles.some((profile) => !sourceById.has(profile.id))) throw new Error('Generated public and migration profile data do not match.');

const safeIssues = Object.fromEntries(Object.entries(importHealth.issues).map(([key, ids]) => [
  key,
  ids.map((id) => {
    const profile = publicById.get(id);
    return { id, name: profile.name, role: profile.role };
  }),
]));

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const seedProfiles = profiles.map((profile) => ({
  public: profile,
  driveFileId: sourceById.get(profile.id).driveFileId || '',
  driveFolderId: sourceById.get(profile.id).driveFolderId || '',
  imageKind: sourceById.get(profile.id).imageKind || '',
  imageIssue: sourceById.get(profile.id).imageIssue || '',
}));

const { data: seeded, error: seedError } = await supabase.rpc('seed_fall_2025_dataset', {
  seed_profiles: seedProfiles,
  seed_health: importHealth,
  seed_safe_issues: safeIssues,
});
if (seedError) throw new Error(`Fall 2025 transactional seed failed: ${seedError.message}`);
if (seeded?.status !== 'active' || seeded?.profileCount !== 210 || seeded?.storedProfileCount !== 210) {
  throw new Error('Fall 2025 seed RPC did not return the required active 210-profile integrity result.');
}

const { data: storedRows, error: verificationError } = await supabase
  .from('dataset_profiles')
  .select('profile_id,public_data')
  .eq('dataset_id', seeded.id)
  .order('ordinal', { ascending: true })
  .limit(1000);
if (verificationError) throw new Error(`Fall 2025 post-seed verification failed: ${verificationError.message}`);
const storedIds = new Set((storedRows || []).map((row) => row.profile_id));
const expectedIds = new Set(profiles.map((profile) => profile.id));
const invalidStoredRow = (storedRows || []).some((row) => row.public_data?.id !== row.profile_id);
if (
  storedRows?.length !== 210
  || storedIds.size !== 210
  || expectedIds.size !== 210
  || [...expectedIds].some((id) => !storedIds.has(id))
  || invalidStoredRow
) {
  throw new Error('Fall 2025 post-seed ID integrity verification failed. Do not publish this dataset.');
}

console.log('Fall 2025 was transactionally replaced, integrity-verified, and activated with 210 profiles.');
