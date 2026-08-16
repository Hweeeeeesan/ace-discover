import { notFound } from 'next/navigation';
import ProfileDetail from '../../../../components/ProfileDetail';
import { getPublishedProfile } from '../../../../lib/datasets/public';

export async function generateMetadata({ params }) {
  const { id: datasetSlug, profileId } = await params;
  const result = await getPublishedProfile(datasetSlug, profileId);
  return result ? { title: `${result.profile.name} · ACE Discover` } : {};
}

export default async function DatasetProfilePage({ params }) {
  const { id: datasetSlug, profileId } = await params;
  const result = await getPublishedProfile(datasetSlug, profileId);
  if (!result) notFound();
  return <ProfileDetail profile={result.profile} datasetSlug={result.dataset.slug} />;
}
