import Link from 'next/link';
import { ExternalLink, Instagram, Presentation } from 'lucide-react';
import DiscoveryBackButton from './DiscoveryBackButton';
import AdminImageManager from './AdminImageManager';
import AdminProfileEditor from './AdminProfileEditor';
import ProfileGallery from './ProfileGallery';
import SeenProfileMarker from './SeenProfileMarker';
import SavedProfileButton from './SavedProfileButton';
import { normalizeProfileIntro, normalizeProfileStory } from '../lib/profile-story';

function InfoSection({ title, children }) {
  if (!children) return null;
  return <section className="info-section"><h2>{title}</h2><p>{children}</p></section>;
}

function StorySection({ title, children, className = '', when = true }) {
  if (!when || !children) return null;
  return <section className={`story-section ${className}`}><h2>{title}</h2>{children}</section>;
}

function StoryText({ children }) {
  return <p className="story-text">{children}</p>;
}

function EditorialStory({ story }) {
  const hobbyContent = story.hobbyItems.length
    ? <div className="hobby-list">{story.hobbyItems.map((item, index) => (
      <article key={`${item.name}-${index}`}><h3>{item.name}</h3>{item.detail && <p>{item.detail}</p>}</article>
    ))}</div>
    : <><StoryText>{story.hobbies}</StoryText>{story.hobbyDetails && <StoryText>{story.hobbyDetails}</StoryText>}</>;
  return <div className="editorial-story">
    <StorySection title="THINGS THAT MAKE ME, ME" className="story-feature" when={story.uniqueThingsText}>
      {story.uniqueThings.length ? <ol className="unique-things">{story.uniqueThings.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol> : <StoryText>{story.uniqueThingsText}</StoryText>}
    </StorySection>
    <StorySection title="I COULD TALK ABOUT THIS FOR HOURS" when={story.passion}><StoryText>{story.passion}</StoryText></StorySection>
    <StorySection title="MY PERFECT DAY" className="story-prose" when={story.perfectDay}><StoryText>{story.perfectDay}</StoryText></StorySection>
    <StorySection title="HOBBIES & ACTIVITIES" when={story.hobbies || story.hobbyDetails}><div className="story-hobbies">{hobbyContent}</div></StorySection>
    <StorySection title="CURRENT SOUNDTRACK" className="story-compact" when={story.music}><StoryText>{story.music}</StoryText></StorySection>
    <StorySection title="MOVIES & SHOWS" className="story-compact" when={story.moviesTv}><StoryText>{story.moviesTv}</StoryText></StorySection>
    <StorySection title="IDEAL HANGOUT" className="story-compact" when={story.idealHangout}><StoryText>{story.idealHangout}</StoryText></StorySection>
    <StorySection title="ON MY BUCKET LIST" className="story-bucket" when={story.bucketList}><StoryText>{story.bucketList}</StoryText></StorySection>
    <StorySection title="MY HARMLESS HOT TAKE" className="hot-take" when={story.hotTake}><StoryText>{story.hotTake}</StoryText></StorySection>
  </div>;
}

export default function ProfileDetail({ profile, datasetSlug, adminPreview = null }) {
  const story = normalizeProfileStory(profile);
  const intro = normalizeProfileIntro(profile, story);
  const interests = Array.isArray(profile.interests)
    ? profile.interests.filter((interest) => !['Big', 'Little', 'Family'].includes(interest))
    : [];
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
      <div className="detail-card" data-profile-transition-id={`${datasetSlug}-${profile.id}`}>
        <div className="detail-photo-wrap">
          <ProfileGallery
            profileName={profile.name}
            images={profile.profileImages}
            fallbackSrc={profile.image}
            fallbackCandidates={profile.imageCandidates}
            fallbackFocalX={profile.focalX}
            fallbackFocalY={profile.focalY}
            fallbackDisplayMode={profile.displayMode}
          />
          {adminPreview
            ? <Link className="back-button" href={adminBackHref} aria-label="Back to Admin dataset"><span aria-hidden="true">←</span></Link>
            : <DiscoveryBackButton className="back-button" iconOnly profileId={profile.id} datasetSlug={datasetSlug} />}
          <span className="detail-role-pill">{profile.role}</span>
        </div>
        <div className="detail-content">
          <div className="detail-name-row">
            <h1>{profile.name}</h1>
            {!adminPreview && <SavedProfileButton profileId={profile.id} datasetSlug={datasetSlug} className="detail-save-button" />}
          </div>
          <div className="detail-role-label">{profile.role}</div>
          <div className="eyebrow dark">{profile.major} · {profile.year}</div>
          {intro.tagline
            ? <p className="detail-tagline">“{intro.tagline}”</p>
            : intro.bio ? <p className="detail-bio">{intro.bio}</p> : null}
          {interests.length > 0 && (
            <div className="tag-row detail-tags">
              {interests.map((interest) => <span className="tag light" key={interest}>{interest}</span>)}
            </div>
          )}
          <div className="profile-meta">
            {profile.school && <span>{profile.school}</span>}
            {profile.family && <span>{profile.family}</span>}
            {profile.program && <span>{profile.program}</span>}
          </div>
          {adminPreview && <AdminProfileEditor
            datasetId={adminPreview.datasetId}
            datasetSlug={datasetSlug}
            profileId={profile.id}
            profile={profile}
            importedPublicData={adminPreview.importedPublicData}
            publicOverrides={adminPreview.publicOverrides}
            publicOverridesUpdatedAt={adminPreview.publicOverridesUpdatedAt}
            vibeReasoning={adminPreview.vibeReasoning}
            vibeThreshold={adminPreview.vibeThreshold}
          />}
          {profile.instagram && (
            <a className="instagram-button" href={profile.instagram} target="_blank" rel="noopener noreferrer">
              <span className="instagram-icon"><Instagram size={20} /></span>
              <span><strong>View Instagram</strong><small>Opens this profile on Instagram</small></span>
              <ExternalLink size={18} />
            </a>
          )}
          {story.isEditorial
            ? <EditorialStory story={story} />
            : <>
              <InfoSection title="Hobbies & interests">{profile.hobbies}</InfoSection>
              <InfoSection title="Music">{profile.music}</InfoSection>
              <InfoSection title="Movies & shows">{profile.movies}</InfoSection>
              <InfoSection title="Perfect day">{profile.perfectDay}</InfoSection>
            </>}
          {profile.slideDeckUrl && (
            <a className="deck-button" href={profile.slideDeckUrl} target="_blank" rel="noreferrer">
              <span className="deck-icon"><Presentation size={21} /></span>
              <span><strong>View slide deck</strong><small>Opens the submitted deck in a new tab</small></span>
              <ExternalLink size={18} />
            </a>
          )}
          {adminPreview
            ? <Link className="secondary-link" href={adminBackHref}>Back to Admin dataset</Link>
            : <DiscoveryBackButton className="secondary-link detail-discovery-link" profileId={profile.id} datasetSlug={datasetSlug}>Back to discovery</DiscoveryBackButton>}
        </div>
      </div>
      {adminPreview && (
        <AdminImageManager
          datasetId={adminPreview.datasetId}
          datasetSlug={datasetSlug}
          profileId={profile.id}
          images={profile.profileImages || []}
        />
      )}
    </main>
  );
}
