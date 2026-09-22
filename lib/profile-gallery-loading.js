export function initialGalleryIndex(images = []) {
  const primaryIndex = images.findIndex((image) => image?.isPrimary === true);
  return primaryIndex >= 0 ? primaryIndex : 0;
}

export function galleryLoadWindow(activeIndex, imageCount) {
  if (!Number.isInteger(imageCount) || imageCount < 1) return [];
  const current = Math.max(0, Math.min(Number(activeIndex) || 0, imageCount - 1));
  return current + 1 < imageCount ? [current, current + 1] : [current];
}

export function extendLoadedGalleryIndexes(loadedIndexes, activeIndex, imageCount) {
  return Array.from(new Set([
    ...(loadedIndexes || []),
    ...galleryLoadWindow(activeIndex, imageCount),
  ])).sort((left, right) => left - right);
}
