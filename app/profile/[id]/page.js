import { notFound } from 'next/navigation';
import { ExternalLink, Instagram, Presentation } from 'lucide-react';
import { getProfile, profiles } from '../../../lib/profiles';
import DiscoveryBackButton from '../../../components/DiscoveryBackButton';
import ProfileImage from '../../../components/ProfileImage';

export function generateStaticParams() {
  return profiles.map((profile) => ({ id: profile.id }));
}

function InfoSection({ title, children }) {
  if (!children) return null;
  return (
    <section className="info-section">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

export default async function ProfilePage({ params }) {
  const { id } = await params;
  const profile = getProfile(id);
  if (!profile) notFound();

  return (
    <main className="detail-shell">
      <div className="detail-card">
        <div className="detail-photo-wrap">
          <ProfileImage
            className="detail-photo"
            src={profile.image}
            candidates={profile.imageCandidates}
            alt={profile.name}
            eager
          />
          <DiscoveryBackButton className="back-button" iconOnly profileId={profile.id} />
          <span className="detail-role-pill">{profile.role}</span>
        </div>

        <div className="detail-content">
          <div className="eyebrow dark">{profile.major} · {profile.year}</div>
          <h1>{profile.name}</h1>
          <p className="detail-bio">{profile.bio}</p>

          <div className="tag-row detail-tags">
            {profile.interests.map((interest) => (
              <span className="tag light" key={interest}>{interest}</span>
            ))}
          </div>

          <div className="profile-meta">
            {profile.school && <span>{profile.school}</span>}
            {profile.family && <span>{profile.family}</span>}
            {profile.program && <span>{profile.program}</span>}
          </div>

          {profile.instagram && (
            <a
              className="instagram-button"
              href={profile.instagram}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="instagram-icon"><Instagram size={20} /></span>
              <span>
                <strong>View Instagram</strong>
                <small>Opens this profile on Instagram</small>
              </span>
              <ExternalLink size={18} />
            </a>
          )}

          <InfoSection title="Hobbies & interests">{profile.hobbies}</InfoSection>
          <InfoSection title="Music">{profile.music}</InfoSection>
          <InfoSection title="Movies & shows">{profile.movies}</InfoSection>
          <InfoSection title="Perfect day">{profile.perfectDay}</InfoSection>

          {profile.slideDeckUrl ? (
            <a className="deck-button" href={profile.slideDeckUrl} target="_blank" rel="noreferrer">
              <span className="deck-icon"><Presentation size={21} /></span>
              <span>
                <strong>View slide deck</strong>
                <small>Opens the submitted deck in a new tab</small>
              </span>
              <ExternalLink size={18} />
            </a>
          ) : (
            <div className="deck-button deck-unavailable" aria-disabled="true">
              <span className="deck-icon"><Presentation size={21} /></span>
              <span>
                <strong>No slide deck submitted</strong>
                <small>This profile did not include a deck link.</small>
              </span>
            </div>
          )}

          <DiscoveryBackButton className="secondary-link" profileId={profile.id}>
            Back to discovery
          </DiscoveryBackButton>
        </div>
      </div>
    </main>
  );
}
