'use client';

import Link from 'next/link';
import { ArrowUpRight, Presentation } from 'lucide-react';
import ProfileImage from './ProfileImage';
import SavedProfileButton from './SavedProfileButton';

function MatchSnippet({ snippet }) {
  if (!snippet?.parts?.length) return null;
  return (
    <span>
      {snippet.parts.map((part, index) => (
        part.highlight
          ? <mark key={`${part.text}-${index}`}>{part.text}</mark>
          : <span key={`${part.text}-${index}`}>{part.text}</span>
      ))}
    </span>
  );
}

function MatchContext({ context }) {
  if (!context) return null;
  const isSearch = context.type === 'search';
  const values = Array.isArray(context.values) ? context.values.filter(Boolean) : [];
  const accessibleLabel = isSearch
    ? `Matched in ${context.label}`
    : `Matched on ${values.join(', ')}`;

  return (
    <div className="match-context" aria-label={accessibleLabel}>
      <div className="match-context-heading">
        <span>{isSearch ? `Matched in ${context.label}` : 'Matched on'}</span>
        {!isSearch && values.length > 0 && <strong>{values.join(' · ')}</strong>}
      </div>
      {context.snippet && (
        <p>
          {!isSearch && <b>{context.label} · </b>}
          “<MatchSnippet snippet={context.snippet} />”
        </p>
      )}
      {context.alsoMatches?.length > 0 && (
        <small>Also matches {context.alsoMatches.join(' · ')}</small>
      )}
    </div>
  );
}

export default function ProfileCard({
  profile,
  index,
  total,
  active = false,
  showHint = false,
  onOpenProfile,
  datasetSlug = 'fall-2025',
  matchContext = null,
}) {
  const interests = Array.isArray(profile.interests)
    ? profile.interests.filter((interest) => !['Big', 'Little', 'Family'].includes(interest)).slice(0, 3)
    : [];

  return (
    <section
      className={`profile-card${active ? ' is-active' : ''}`}
      id={`profile-${profile.id}`}
      data-profile-id={profile.id}
      data-profile-transition-id={`${datasetSlug}-${profile.id}`}
      aria-label={`${profile.name}, ${profile.role} profile ${index + 1} of ${total}`}
    >
      <ProfileImage
        className="profile-image"
        src={profile.image}
        candidates={profile.imageCandidates}
        alt={profile.name}
        eager={active || index < 2}
        focalX={profile.focalX}
        focalY={profile.focalY}
        displayMode={profile.displayMode}
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

        {profile.tagline && <p className="profile-tagline">“{profile.tagline}”</p>}

        {interests.length > 0 && (
          <div className="tag-row">
            {interests.map((interest) => (
              <span className="tag" key={interest}>{interest}</span>
            ))}
          </div>
        )}

        <MatchContext context={matchContext} />

        <div className="card-actions">
          <Link
            className="primary-button"
            href={`/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profile.id)}`}
            prefetch={false}
            onClick={(event) => {
              onOpenProfile?.(profile.id);
              event.currentTarget.closest('.profile-card')?.classList.add('is-opening');
            }}
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
