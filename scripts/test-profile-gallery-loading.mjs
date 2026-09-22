#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extendLoadedGalleryIndexes,
  galleryLoadWindow,
  initialGalleryIndex,
} from '../lib/profile-gallery-loading.js';

const images = [
  { id: 'one', isPrimary: true },
  { id: 'two' },
  { id: 'three' },
  { id: 'four' },
];

assert.equal(initialGalleryIndex(images), 0, 'the primary slide must open immediately');
assert.deepEqual(galleryLoadWindow(0, images.length), [0, 1], 'initial open may preload only the next slide');
assert.equal(galleryLoadWindow(0, images.length).includes(2), false, 'slide 3+ must not load initially');

let loaded = extendLoadedGalleryIndexes([], 0, images.length);
loaded = extendLoadedGalleryIndexes(loaded, 1, images.length);
assert.deepEqual(loaded, [0, 1, 2], 'activating next must load it and preload next-next');
loaded = extendLoadedGalleryIndexes(loaded, 2, images.length);
assert.deepEqual(loaded, [0, 1, 2, 3], 'already-viewed slides must remain resident');
assert.deepEqual(extendLoadedGalleryIndexes(loaded, 1, images.length), loaded, 'revisiting a slide must reuse it');
assert.deepEqual(galleryLoadWindow(0, 1), [0], 'single-image profiles must remain a one-image load');
assert.equal(initialGalleryIndex([{ id: 'one' }, { id: 'two', isPrimary: true }]), 1,
  'the existing primary-state opening behavior must be preserved');

const source = await readFile(new URL('../components/ProfileGallery.js', import.meta.url), 'utf8');
assert.match(source, /className="profile-gallery-viewport"[^>]*onScroll=\{handleScroll\}/,
  'scroll/swipe navigation must stay connected');
assert.match(source, /className="profile-gallery-track"/);
assert.match(source, /className="profile-gallery-slide"/,
  'the existing scroll-snap DOM structure must stay intact');
assert.match(source, /profile-gallery-arrow-prev/);
assert.match(source, /profile-gallery-arrow-next/);
assert.match(source, /profile-gallery-counter/);
assert.match(source, /profile-gallery-dots/);
assert.match(source, /ArrowLeft.*ArrowRight/s, 'keyboard navigation must remain enabled');
assert.match(source, /loadedIndexes\.includes\(index\) \? image\.src : DEFERRED_IMAGE/,
  'deferred slides must not receive their real source URL');
assert.match(source, /loadedIndexes\.includes\(index\) \? image\.candidates : \[\]/,
  'deferred slides must not receive canonical fallback candidates');

console.log('Profile gallery controlled-loading tests passed.');
