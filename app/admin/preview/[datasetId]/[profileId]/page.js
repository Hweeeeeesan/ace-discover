import { notFound, redirect } from 'next/navigation';
import ProfileDetail from '../../../../../components/ProfileDetail';
import { getAdminIdentity } from '../../../../../lib/admin/authorization';
import { getAdminDatasetProfile } from '../../../../../lib/datasets/admin';
import { VIBE_SCORE_THRESHOLD } from '../../../../../lib/import/profile-normalization';

export const metadata = { title: 'Dataset preview · ACE Discover', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminDatasetProfilePreview({ params }) {
  const identity = await getAdminIdentity();
  if (identity.state === 'unconfigured' || identity.state === 'unauthenticated') redirect('/admin');
  if (identity.state !== 'authorized') notFound();

  const { datasetId, profileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(String(datasetId || '')) || !profileId) notFound();
  const result = await getAdminDatasetProfile(datasetId, profileId);
  if (!result) notFound();

  const backHref = `/admin?dataset=${encodeURIComponent(result.dataset.id)}`;
  const editableImage = result.profile.profileImages?.find((image) => image.isPrimary)
    || result.profile.profileImages?.[0];
  return (
    <ProfileDetail
      profile={result.profile}
      datasetSlug={result.dataset.slug}
      adminPreview={{
        backHref,
        datasetId: result.dataset.id,
        datasetName: result.dataset.name,
        status: result.dataset.status,
        imageId: editableImage?.id || '',
        importedPublicData: result.importedPublicData,
        publicOverrides: result.publicOverrides,
        publicOverridesUpdatedAt: result.publicOverridesUpdatedAt,
        vibeReasoning: result.vibeReasoning,
        vibeThreshold: VIBE_SCORE_THRESHOLD,
      }}
    />
  );
}
