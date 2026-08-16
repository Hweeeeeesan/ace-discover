import Link from 'next/link';
import { ExternalLink, Instagram, Presentation } from 'lucide-react';
import DiscoveryBackButton from './DiscoveryBackButton';
import ProfileImage from './ProfileImage';
import SeenProfileMarker from './SeenProfileMarker';

function InfoSection({ title, children }) {
  if (!children) return null;
  return <section className="info-section"><h2>{title}</h2><p>{children}</p></section>;
}

export default function ProfileDetail({ profile, datasetSlug, adminPreview = null }) {
  const adminBackHref = adminPreview?.backHref || '';
  return (
    <main className="detail-shell">
      {!adminPreview && <SeenProfileMarker profileId={profile.id} datasetSlug={datasetSlug} />}
      {adminPreview && (
        <div className="admin-preview-banner" role="status">
          <strong>Admin-only preview · {adminPreview.datasetName}</strong>
          <span>{adminPreview.status === 'ready' ? 'This dataset is saved but not public.' : `Dataset status: ${adminPreview.status}`}</span>
        </div>
      )}
      <div className="detail-card">
        <div className="detail-photo-wrap">
          <ProfileImage className="detail-photo" src={profile.image} candidates={profile.imageCandidates} alt={profile.name} eager />
          {adminPreview
            ? <Link className="back-button" href={adminBackHref} aria-label="Back to Admin dataset"><span aria-hidden="true">←</span></Link>
            : <DiscoveryBackButton className="back-button" iconOnly profileId={profile.id} datasetSlug={datasetSlug} />}
          <span className="detail-role-pill">{profile.role}</span>
        </div>
        <div className="detail-content">
          <div className="eyebrow dark">{profile.major} · {profile.year}</div>
          <h1>{profile.name}</h1>
          <p className="detail-bio">{profile.bio}</p>
          <div className="tag-row detail-tags">
            {profile.interests.map((interest) => <span className="tag light" key={interest}>{interest}</span>)}
          </div>
          <div className="profile-meta">
            {profile.school && <span>{profile.school}</span>}
            {profile.family && <span>{profile.family}</span>}
            {profile.program && <span>{profile.program}</span>}
          </div>
          {profile.instagram && (
            <a className="instagram-button" href={profile.instagram} target="_blank" rel="noopener noreferrer">
              <span className="instagram-icon"><Instagram size={20} /></span>
              <span><strong>View Instagram</strong><small>Opens this profile on Instagram</small></span>
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
              <span><strong>View slide deck</strong><small>Opens the submitted deck in a new tab</small></span>
              <ExternalLink size={18} />
            </a>
          ) : (
            <div className="deck-button deck-unavailable" aria-disabled="true">
              <span className="deck-icon"><Presentation size={21} /></span>
              <span><strong>No slide deck submitted</strong><small>This profile did not include a deck link.</small></span>
            </div>
          )}
          {adminPreview
            ? <Link className="secondary-link" href={adminBackHref}>Back to Admin dataset</Link>
            : <DiscoveryBackButton className="secondary-link" profileId={profile.id} datasetSlug={datasetSlug}>Back to discovery</DiscoveryBackButton>}
        </div>
      </div>
    </main>
  );
}
