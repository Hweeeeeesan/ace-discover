'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  extendLoadedGalleryIndexes,
  initialGalleryIndex,
} from '../lib/profile-gallery-loading';
import ProfileImage from './ProfileImage';

const DEFERRED_IMAGE = '/profile-placeholder.svg';

export default function ProfileGallery({
  profileName = 'Profile',
  images = [],
  fallbackSrc,
  fallbackCandidates = [],
  fallbackFocalX = 50,
  fallbackFocalY = 35,
  fallbackDisplayMode = 'cover',
}) {
  const relationalImages = useMemo(
    () => (Array.isArray(images) ? images.filter((image) => image?.src || image?.storageImagePath) : []),
    [images],
  );
  const [activeIndex, setActiveIndex] = useState(() => initialGalleryIndex(relationalImages));
  const [loadedIndexes, setLoadedIndexes] = useState(() => (
    extendLoadedGalleryIndexes([], initialGalleryIndex(relationalImages), relationalImages.length)
  ));
  const viewportRef = useRef(null);
  const slideRefs = useRef([]);
  const scrollFrameRef = useRef(null);

  useEffect(() => {
    const nextIndex = initialGalleryIndex(relationalImages);
    setActiveIndex(nextIndex);
    setLoadedIndexes(extendLoadedGalleryIndexes([], nextIndex, relationalImages.length));
  }, [relationalImages]);

  useEffect(() => {
    setLoadedIndexes((current) => (
      extendLoadedGalleryIndexes(current, activeIndex, relationalImages.length)
    ));
  }, [activeIndex, relationalImages.length]);

  useEffect(() => () => {
    if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    const targetIndex = initialGalleryIndex(relationalImages);
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const slide = slideRefs.current[targetIndex];
      if (!viewport || !slide) return;
      viewport.scrollTo({ left: slide.offsetLeft, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [relationalImages]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!relationalImages.length || (event.target instanceof HTMLElement && (
        event.target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      ))) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      goTo(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, relationalImages.length]);

  function handleScroll(event) {
    const viewport = event.currentTarget;
    if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const width = viewport.clientWidth;
      if (!width) return;
      const nextIndex = Math.round(viewport.scrollLeft / width);
      setActiveIndex(Math.max(0, Math.min(nextIndex, relationalImages.length - 1)));
    });
  }

  function goTo(index) {
    if (!relationalImages.length) return;
    const targetIndex = Math.max(0, Math.min(index, relationalImages.length - 1));
    const viewport = viewportRef.current;
    const slide = slideRefs.current[targetIndex];
    setActiveIndex(targetIndex);
    if (!viewport || !slide) return;
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({
      left: slide.offsetLeft,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }

  if (!relationalImages.length) {
    return (
      <ProfileImage
        className="detail-photo"
        src={fallbackSrc}
        candidates={fallbackCandidates}
        alt={profileName}
        eager
        focalX={fallbackFocalX}
        focalY={fallbackFocalY}
        displayMode={fallbackDisplayMode}
      />
    );
  }

  const hasControls = relationalImages.length > 1;
  return (
    <div className="profile-gallery" aria-label={`${profileName} photo gallery`}>
      <div className="profile-gallery-viewport" ref={viewportRef} onScroll={handleScroll}>
        <div className="profile-gallery-track">
          {relationalImages.map((image, index) => (
            <div
              className="profile-gallery-slide"
              key={image.id || image.storageImagePath || index}
              ref={(slide) => { slideRefs.current[index] = slide; }}
              data-gallery-loaded={loadedIndexes.includes(index) ? 'true' : 'false'}
            >
              <ProfileImage
                className="detail-photo"
                src={loadedIndexes.includes(index) ? image.src : DEFERRED_IMAGE}
                candidates={loadedIndexes.includes(index) ? image.candidates : []}
                alt={`${profileName} image ${index + 1}`}
                eager={index === activeIndex}
                focalX={image.focalX}
                focalY={image.focalY}
                displayMode={image.displayMode}
              />
            </div>
          ))}
        </div>
      </div>
      {hasControls && (
        <>
          <button
            type="button"
            className="profile-gallery-arrow profile-gallery-arrow-prev"
            onClick={() => goTo(activeIndex - 1)}
            disabled={activeIndex === 0}
            aria-label="Previous image"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            className="profile-gallery-arrow profile-gallery-arrow-next"
            onClick={() => goTo(activeIndex + 1)}
            disabled={activeIndex === relationalImages.length - 1}
            aria-label="Next image"
          >
            <span aria-hidden="true">›</span>
          </button>
          <div className="profile-gallery-counter" aria-live="polite">
            {activeIndex + 1} / {relationalImages.length}
          </div>
          <div className="profile-gallery-dots" aria-label="Choose an image">
            {relationalImages.map((image, index) => (
              <button
                type="button"
                key={image.id || image.storageImagePath || index}
                className={index === activeIndex ? 'is-active' : ''}
                onClick={() => goTo(index)}
                aria-label={`View image ${index + 1} of ${relationalImages.length}`}
                aria-current={index === activeIndex ? 'true' : undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
