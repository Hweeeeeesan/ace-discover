import { notFound, redirect } from 'next/navigation';
import { profiles } from '../../../lib/profiles';
import { profilePath } from '../../../lib/datasets/model';

export function generateStaticParams() {
  return profiles.map((profile) => ({ id: profile.id }));
}

export default async function LegacyProfilePage({ params }) {
  const { id } = await params;
  if (!profiles.some((profile) => profile.id === id)) notFound();
  redirect(profilePath('fall-2025', id));
}
