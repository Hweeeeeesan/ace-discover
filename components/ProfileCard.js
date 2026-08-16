'use client';

import Link from 'next/link';
import { ArrowUpRight, Presentation } from 'lucide-react';
import ProfileImage from './ProfileImage';
import SavedProfileButton from './SavedProfileButton';

export default function ProfileCard({
  profile,
  index,
  total,
  active = false,
  showHint = false,
  onOpenProfile,
  datasetSlug = 'fall-2025',
}) {
  const interests = Array.isArray(profile.interests) ? profile.interests.slice(0, 3) : [];

  return (
    <section
      className={`profile-card${active ? ' is-active' : ''}`}
      id={`profile-${profile.id}`}
      data-profile-id={profile.id}
      aria-label={`${profile.name}, ${profile.role} profile ${index + 1} of ${total}`}
    >
      <ProfileImage
        className="profile-image"
        src={profile.image}
        candidates={profile.imageCandidates}
        alt={profile.name}
        eager={active || index < 2}
      />
      <div className="image-overlay" />

      <div className="card-status-bar">
        <div className="brand-pill">{profile.role.toUpperCase()}</div>
        <div className="counter">
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </div>
      </div>

      <div className="profile-copy">
        <div className="eyebrow">{profile.major} · {profile.year}</div>
        <div className="profile-name-clamp">
          <h2>{profile.name}</h2>
        </div>

        {interests.length > 0 && (
          <div className="tag-row">
            {interests.map((interest) => (
              <span className="tag" key={interest}>{interest}</span>
            ))}
          </div>
        )}

        <div className="card-actions">
          <Link
            className="primary-button"
            href={`/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profile.id)}`}
            prefetch={false}
            onClick={() => onOpenProfile?.(profile.id)}
          >
            View profile <ArrowUpRight size={18} />
          </Link>
          {profile.slideDeckUrl && (
            <a
              className="icon-button"
              href={profile.slideDeckUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${profile.name}'s slide deck`}
              title="Open slide deck"
            >
              <Presentation size={20} />
            </a>
          )}
          <SavedProfileButton profileId={profile.id} datasetSlug={datasetSlug} />
        </div>
      </div>

      {showHint && <div className="scroll-hint">Swipe up to discover</div>}
    </section>
  );
}
