#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { canResumeCandidate, optimizeCanonical, proposedPaths, sha256 } from '../lib/profile-image-compression.js';
import { DEFAULT_PROFILE_IMAGE_BUCKET } from '../lib/profile-images.js';

const options = { limit: 24, dataset: '', output: 'reports/image-compression-dry-run',
  jpegQuality: 86, webpQuality: 90, minSavingsPercent: 10, approveFile: '', pathsFile: '',
  baselineBytes: 0, jpegBytes: 0, pngBytes: 0 };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const key = { '--limit': 'limit', '--dataset': 'dataset', '--output': 'output',
    '--jpeg-quality': 'jpegQuality', '--webp-quality': 'webpQuality',
    '--min-savings-percent': 'minSavingsPercent', '--approve-file': 'approveFile',
    '--paths-file': 'pathsFile', '--baseline-bytes': 'baselineBytes',
    '--jpeg-bytes': 'jpegBytes', '--png-bytes': 'pngBytes' }[arg];
  if (arg === '--help') {
    console.log('Read-only Supabase canonical compression audit. Options: --limit N (0=all), --dataset SLUG, --paths-file JSON, --output DIR, --jpeg-quality N, --webp-quality N, --min-savings-percent N, --approve-file FILE, --baseline-bytes N, --jpeg-bytes N, --png-bytes N');
    process.exit(0);
  }
  if (!key || !process.argv[i + 1]) throw new Error(`Invalid option ${arg}`);
  options[key] = process.argv[++i];
}
for (const k of ['limit', 'jpegQuality', 'webpQuality', 'minSavingsPercent', 'baselineBytes', 'jpegBytes', 'pngBytes']) options[k] = Number(options[k]);
if (!Number.isInteger(options.limit) || options.limit < 0 || !Number.isFinite(options.minSavingsPercent)
  || options.minSavingsPercent < 0 || options.minSavingsPercent > 100) throw new Error('Invalid selection or savings threshold.');
if (options.dataset && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.dataset)) throw new Error('Invalid dataset slug.');
if (['baselineBytes', 'jpegBytes', 'pngBytes'].some((key) => !Number.isSafeInteger(options[key]) || options[key] < 0)) throw new Error('Invalid inventory size.');
const output = path.resolve(options.output);
fs.mkdirSync(output, { recursive: true });
const manifestPath = path.join(output, 'manifest.json');
const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const config = { jpegQuality: options.jpegQuality, webpQuality: options.webpQuality,
  minSavingsPercent: options.minSavingsPercent, dataset: options.dataset };
if (existing && JSON.stringify(existing.config) !== JSON.stringify(config)) {
  throw new Error('Existing manifest uses different settings; choose a new --output directory.');
}
const approvals = options.approveFile
  ? new Map(JSON.parse(fs.readFileSync(options.approveFile, 'utf8')).map((item) => [item.imageId, item.sha256]))
  : new Map();
function save(value, filename = manifestPath) {
  const tmp = `${filename}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filename);
}
async function allRows(client, table, columns) {
  const result = [];
  for (let start = 0; ; start += 1000) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await client.from(table).select(columns).range(start, start + 999);
      if (!response.error || !/fetch failed/i.test(response.error.message)) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    const { data, error } = response;
    if (error) throw new Error(`${table}: ${error.message}`);
    result.push(...data);
    if (data.length < 1000) return result;
  }
}
async function download(storage, storagePath) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await storage.download(storagePath);
    if (!response.error || !/fetch failed/i.test(response.error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return response;
}
async function list(storage, folder) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await storage.list(folder, { limit: 1000 });
    if (!response.error || !/fetch failed/i.test(response.error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return response;
}
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function selectRepresentative(rows, limit) {
  if (!limit || limit >= rows.length) return rows;
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.dataset_slug}:${row.source_type || 'legacy'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const chosen = [];
  const queues = [...groups.values()].map((group) => group.sort((a, b) => a.profile_id.localeCompare(b.profile_id)));
  while (chosen.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) if (queue.length && chosen.length < limit) chosen.push(queue.shift());
  }
  return chosen;
}
async function reviewImage(storage, entry, original, optimized) {
  const reviewDir = path.join(output, 'review', entry.imageId);
  fs.mkdirSync(reviewDir, { recursive: true });
  const presentation = { focalX: entry.oldSnapshot.focal_x, focalY: entry.oldSnapshot.focal_y,
    displayMode: entry.oldSnapshot.display_mode };
  fs.writeFileSync(path.join(reviewDir, `original-full.${entry.originalFormat === 'jpeg' ? 'jpg' : entry.originalFormat}`), original);
  fs.writeFileSync(path.join(reviewDir, `optimized-full.${entry.proposedFormat === 'jpeg' ? 'jpg' : entry.proposedFormat}`), optimized);
  // Exact CSS object-position crop, with contain for portrait display mode.
  async function crop(bytes, targetWidth, targetHeight) {
    const meta = await sharp(bytes).metadata();
    const w = meta.autoOrient?.width || meta.width, h = meta.autoOrient?.height || meta.height;
    if (presentation.displayMode === 'portrait') return sharp(bytes).autoOrient().resize(targetWidth, targetHeight, { fit: 'contain', background: '#f1f1f1' }).jpeg({ quality: 88 }).toBuffer();
    const aspect = targetWidth / targetHeight;
    const cropWidth = Math.min(w, Math.round(h * aspect));
    const cropHeight = Math.min(h, Math.round(w / aspect));
    const left = Math.round((w - cropWidth) * Number(presentation.focalX ?? 50) / 100);
    const top = Math.round((h - cropHeight) * Number(presentation.focalY ?? 35) / 100);
    return sharp(bytes).autoOrient().extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(targetWidth, targetHeight).jpeg({ quality: 88 }).toBuffer();
  }
  fs.writeFileSync(path.join(reviewDir, 'original.jpg'), await sharp(original).autoOrient()
    .resize(420, 420, { fit: 'contain', background: '#f1f1f1' }).jpeg({ quality: 88 }).toBuffer());
  fs.writeFileSync(path.join(reviewDir, 'optimized.jpg'), await sharp(optimized).autoOrient()
    .resize(420, 420, { fit: 'contain', background: '#f1f1f1' }).jpeg({ quality: 88 }).toBuffer());
  fs.writeFileSync(path.join(reviewDir, 'optimized-profile-crop.jpg'), await crop(optimized, 420, 300));
  fs.writeFileSync(path.join(reviewDir, 'optimized-discovery-crop.jpg'), await crop(optimized, 300, 420));
  for (const [name, storagePath] of [['profile-detail', entry.oldSnapshot.profile_storage_path], ['discovery', entry.oldSnapshot.discovery_storage_path]]) {
    if (!storagePath) continue;
    const { data, error } = await download(storage, storagePath);
    if (error || !data) { entry.reviewWarnings.push(`${name}: ${error?.message || 'missing'}`); continue; }
    fs.writeFileSync(path.join(reviewDir, `${name}.jpg`), await crop(Buffer.from(await data.arrayBuffer()),
      name === 'profile-detail' ? 420 : 300, name === 'profile-detail' ? 300 : 420));
  }
  entry.reviewDirectory = path.relative(output, reviewDir);
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Run with node --env-file=.env.local.');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const bucketName = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;
if (bucketName !== DEFAULT_PROFILE_IMAGE_BUCKET) throw new Error('Unexpected bucket.');
const storage = client.storage.from(bucketName);
const datasets = await allRows(client, 'datasets', 'id,slug,status,profile_count');
const images = await allRows(client, 'profile_images', 'id,dataset_id,profile_id,storage_path,profile_storage_path,discovery_storage_path,profile_width,profile_height,profile_mime_type,profile_byte_length,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,updated_at,position,is_primary,focal_x,focal_y,display_mode,source_type,source_drive_file_id,source_drive_folder_id,source_filename,source_modified_time,source_size');
const profiles = await allRows(client, 'dataset_profiles', 'dataset_id,profile_id,storage_image_path,public_data,public_overrides,image_cleared_by_admin');
const buckets = await client.storage.listBuckets();
if (buckets.error || !buckets.data?.some((bucket) => bucket.name === bucketName)) throw new Error('Storage bucket could not be read.');
const datasetById = new Map(datasets.map((dataset) => [dataset.id, dataset]));
const rows = images.map((image) => ({ ...image, dataset_slug: datasetById.get(image.dataset_id)?.slug,
  dataset_status: datasetById.get(image.dataset_id)?.status }));
if (rows.some((row) => !row.dataset_slug)) throw new Error('Image references an unknown dataset.');
const requestedPaths = options.pathsFile ? new Set(JSON.parse(fs.readFileSync(options.pathsFile, 'utf8'))) : null;
if (requestedPaths && [...requestedPaths].some((item) => typeof item !== 'string')) throw new Error('Paths file must be a JSON array of strings.');
const eligible = rows.filter((row) => (!options.dataset || row.dataset_slug === options.dataset)
  && (!requestedPaths || requestedPaths.has(row.storage_path)));
if (requestedPaths && eligible.length !== requestedPaths.size) throw new Error('Some requested paths are not current relational canonicals.');
const selected = requestedPaths ? eligible : selectRepresentative(eligible, options.limit);
const manifest = existing || { version: 1, createdAt: new Date().toISOString(), config, inventory: {}, entries: {} };
manifest.inventory = { datasetCount: datasets.length, imageRows: images.length, profileRows: profiles.length,
  selected: selected.length, uploadCapability: 'unverified: this dry run performs no upload' };
for (const row of selected) {
  const previous = manifest.entries[row.id];
  if (canResumeCandidate(previous, row)) {
    if (previous.proposedSha256 && !previous.originalSha256 && previous.reviewDirectory) {
      const originalPath = path.join(output, previous.reviewDirectory,
        `original-full.${previous.originalFormat === 'jpeg' ? 'jpg' : previous.originalFormat}`);
      if (fs.existsSync(originalPath)) previous.originalSha256 = sha256(fs.readFileSync(originalPath));
    }
    if (previous.status === 'validated' && approvals.get(row.id) === previous.proposedSha256) previous.status = 'ready_for_migration';
    if (previous.reviewDirectory && !fs.existsSync(path.join(output, previous.reviewDirectory, 'optimized-profile-crop.jpg'))) {
      const directory = path.join(output, previous.reviewDirectory);
      const originalPath = path.join(directory, `original-full.${previous.originalFormat === 'jpeg' ? 'jpg' : previous.originalFormat}`);
      const optimizedPath = path.join(directory, `optimized-full.${previous.proposedFormat === 'jpeg' ? 'jpg' : previous.proposedFormat}`);
      if (fs.existsSync(originalPath) && fs.existsSync(optimizedPath)) {
        await reviewImage(storage, previous, fs.readFileSync(originalPath), fs.readFileSync(optimizedPath));
      }
    }
    continue;
  }
  const entry = { imageId: row.id, datasetId: row.dataset_id, datasetSlug: row.dataset_slug,
    datasetStatus: row.dataset_status, profileId: row.profile_id, oldSnapshot: row,
    oldPaths: { canonical: row.storage_path, profile: row.profile_storage_path, discovery: row.discovery_storage_path },
    status: 'pending', reviewWarnings: [] };
  manifest.entries[row.id] = entry;
  save(manifest);
  try {
    if (!row.storage_path || !row.storage_path.startsWith(`${row.dataset_slug}/${row.profile_id}/`)) throw new Error('Canonical path does not match owner.');
    if (Boolean(row.profile_storage_path) !== Boolean(row.discovery_storage_path)) throw new Error('Incomplete derivative pair.');
    const { data, error } = await download(storage, row.storage_path);
    if (error || !data) throw new Error(`Canonical download failed: ${error?.message || 'missing'}`);
    const original = Buffer.from(await data.arrayBuffer());
    const proposal = await optimizeCanonical(original, config);
    entry.originalSize = original.length;
    entry.originalFormat = proposal.original?.format;
    entry.dimensions = { width: proposal.original?.width, height: proposal.original?.height };
    entry.originalOrientation = proposal.original?.orientation;
    entry.hasAlpha = proposal.original?.hasAlpha;
    entry.status = proposal.status;
    if (proposal.status === 'skipped') entry.reason = proposal.reason;
    else {
      entry.proposedSize = proposal.optimized.bytes;
      entry.proposedFormat = proposal.optimized.format;
      entry.compressionPercent = Math.round(proposal.savingPercent * 100) / 100;
      entry.savingsBytes = proposal.saving;
      entry.proposedSha256 = proposal.sha256;
      entry.originalSha256 = proposal.original.sha256;
      entry.validation = 'dimensions, alpha, and upright orientation passed; visual review required';
      entry.newPaths = proposedPaths({ datasetSlug: row.dataset_slug, row, contentType: proposal.contentType });
      entry.rollback = { oldPaths: entry.oldPaths, newPaths: entry.newPaths,
        originalRowId: row.id, retainOldObjects: true };
      await reviewImage(storage, entry, original, proposal.bytes);
      if (approvals.get(row.id) === proposal.sha256) entry.status = 'ready_for_migration';
    }
  } catch (error) { entry.status = 'failed'; entry.reason = String(error); }
  save(manifest);
  console.log(`${entry.status}: ${row.dataset_slug}/${row.profile_id} ${entry.savingsBytes || 0} bytes saved`);
}
save(manifest);
const values = Object.values(manifest.entries);
const measured = values.filter((entry) => ['validated', 'ready_for_migration'].includes(entry.status));
const savings = measured.reduce((total, entry) => total + entry.savingsBytes, 0);
const ratios = measured.map((entry) => entry.compressionPercent).sort((a, b) => a - b);
const report = { createdAt: new Date().toISOString(), readOnly: true, inventory: manifest.inventory,
  statuses: Object.fromEntries(['pending', 'validated', 'skipped', 'failed', 'ready_for_migration']
    .map((status) => [status, values.filter((entry) => entry.status === status).length])),
  measured: { evaluated: values.length, optimized: measured.length, savedBytes: savings,
    jpegSavingsBytes: measured.filter((e) => e.originalFormat === 'jpeg').reduce((n, e) => n + e.savingsBytes, 0),
    pngSavingsBytes: measured.filter((e) => e.originalFormat === 'png').reduce((n, e) => n + e.savingsBytes, 0),
    medianSavingsPercent: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null },
  manualReview: measured.map((e) => ({ imageId: e.imageId, path: e.oldPaths.canonical,
    sha256: e.proposedSha256, reviewDirectory: e.reviewDirectory, warnings: e.reviewWarnings })),
  uploadCapability: 'Cannot be established without an upload; no upload attempted.',
  estimatedPeakExtraBytesOneSet: measured.length ? Math.max(...measured.map((e) => e.proposedSize
    + Number(e.oldSnapshot.profile_byte_length || 0) + Number(e.oldSnapshot.discovery_byte_length || 0))) : 0,
};
if (options.baselineBytes) {
  const byFormat = (format) => measured.filter((entry) => entry.originalFormat === format);
  const ratio = (format) => {
    const group = values.filter((entry) => entry.originalFormat === format && Number.isFinite(entry.originalSize));
    return group.length ? byFormat(format).reduce((n, e) => n + e.savingsBytes, 0)
      / group.reduce((n, e) => n + e.originalSize, 0) : null;
  };
  const jpegRate = ratio('jpeg'), pngRate = ratio('png');
  const extrapolatedSavings = (jpegRate === null ? 0 : options.jpegBytes * jpegRate)
    + (pngRate === null ? 0 : options.pngBytes * pngRate);
  report.projection = { baselineBytes: options.baselineBytes,
    measuredOnlyFinalBytes: options.baselineBytes - savings,
    sampleJpegSavingsRate: jpegRate, samplePngSavingsRate: pngRate,
    extrapolatedSavingsBytes: Math.round(extrapolatedSavings),
    extrapolatedFinalBytes: Math.round(options.baselineBytes - extrapolatedSavings),
    warning: 'Extrapolation is a sample scenario, not a quality-approved or guaranteed outcome.' };
}
save(report, path.join(output, 'report.json'));
const cards = report.manualReview.map((item) => {
  const entry = manifest.entries[item.imageId];
  const originalFull = `${item.reviewDirectory}/original-full.${entry.originalFormat === 'jpeg' ? 'jpg' : entry.originalFormat}`;
  const optimizedFull = `${item.reviewDirectory}/optimized-full.${entry.proposedFormat === 'jpeg' ? 'jpg' : entry.proposedFormat}`;
  const fullLinks = fs.existsSync(path.join(output, originalFull)) && fs.existsSync(path.join(output, optimizedFull))
    ? `<p><a href="${originalFull}">Original at full resolution</a> · <a href="${optimizedFull}">Optimized at full resolution</a></p>` : '';
  return `<article><h2>${item.path}</h2><p>${item.imageId} · SHA-256 ${item.sha256}</p>${fullLinks}<div>${['original', 'optimized', 'optimized-profile-crop', 'profile-detail', 'optimized-discovery-crop', 'discovery'].map((name) => `<figure><img src="${item.reviewDirectory}/${name}.jpg" alt="${name}"><figcaption>${name}</figcaption></figure>`).join('')}</div></article>`;
}).join('\n');
fs.writeFileSync(path.join(output, 'review.html'), `<!doctype html><meta charset="utf-8"><title>ACE image compression review</title><style>body{font:15px system-ui;margin:24px;background:#f8f8f8;color:#222}article{border-top:1px solid #bbb;padding:24px 0}article div{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;width:220px}img{width:220px;height:220px;object-fit:contain;background:#eee}figcaption{font-weight:600}p{overflow-wrap:anywhere}</style><h1>Visual review · no production changes</h1><p>Inspect faces, hair, skin, fine details, text, transparency, color, and artifacts. Missing derivative panels correspond to archived galleries.</p>${cards}`);

// Cleanup and archived fallback checks are separate reports, never applied here.
const referenced = new Set(images.flatMap((image) => [image.storage_path, image.profile_storage_path, image.discovery_storage_path]).filter(Boolean));
for (const profile of profiles) {
  if (profile.storage_image_path) referenced.add(profile.storage_image_path);
  for (const value of [...strings(profile.public_data), ...strings(profile.public_overrides)]) {
    for (const match of value.matchAll(/(?:fall-2025|spring-2026|fall-2026)\/[a-z0-9-]+\/(?:derived\/)?[a-z0-9.-]+/g)) referenced.add(match[0]);
  }
}
const cindy = [];
for (const folder of ['fall-2026/cindy-lei', 'fall-2026/cindy-lei/derived']) {
  const { data, error } = await list(storage, folder);
  if (error) throw new Error(`Cindy cleanup inventory: ${error.message}`);
  for (const object of data) if (object.id) cindy.push({ path: `${folder}/${object.name}`,
    size: Number(object.metadata?.size || 0), referenced: referenced.has(`${folder}/${object.name}`) });
}
save({ readOnly: true, candidates: cindy.filter((object) => !object.referenced),
  note: 'Candidates require a fresh database and public fallback check before separately authorized deletion.' },
path.join(output, 'orphan-candidates.json'));
const fall2025 = datasets.find((dataset) => dataset.slug === 'fall-2025');
const fallback = profiles.filter((profile) => profile.dataset_id === fall2025?.id && profile.storage_image_path)
  .map((profile) => ({ profileId: profile.profile_id, oldPath: profile.storage_image_path,
    primary: images.find((image) => image.dataset_id === profile.dataset_id && image.profile_id === profile.profile_id && image.is_primary)?.storage_path }))
  .filter((item) => item.primary && item.primary !== item.oldPath);
save({ readOnly: true, guardedRepairCandidates: fallback,
  note: 'Verify old object absence and primary object presence, then compare oldPath and primary before a separate update.' },
path.join(output, 'archived-fallback-candidates.json'));
console.log(JSON.stringify({ output, report, orphanCandidates: cindy.filter((object) => !object.referenced).length,
  fallbackCandidates: fallback.length }, null, 2));
