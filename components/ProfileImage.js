'use client';

import { useEffect, useMemo, useState } from 'react';

const FALLBACK_IMAGE = '/profile-placeholder.svg';

export default function ProfileImage({
  src,
  candidates = [],
  alt,
  className,
  eager = false,
  focalX = 50,
  focalY = 35,
  displayMode = 'cover',
}) {
  const sources = useMemo(
    () => Array.from(new Set([src, ...candidates, FALLBACK_IMAGE].filter(Boolean))),
    [src, candidates],
  );
  const sourceKey = sources.join('|');
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);

  const imageSrc = sources[sourceIndex] || FALLBACK_IMAGE;
  const usingFallback = imageSrc === FALLBACK_IMAGE;

  function handleError() {
    setSourceIndex((current) => Math.min(current + 1, sources.length - 1));
  }

  return (
    <img
      className={className}
      style={{ objectFit: displayMode === 'portrait' ? 'contain' : 'cover', objectPosition: `${focalX}% ${focalY}%` }}
      src={imageSrc}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      decoding="async"
      referrerPolicy="no-referrer"
      data-fallback={usingFallback ? 'true' : 'false'}
      onError={handleError}
    />
  );
}
