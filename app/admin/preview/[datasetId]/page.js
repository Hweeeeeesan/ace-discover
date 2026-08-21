import Link from 'next/link';
import AdminProfileSearch from '../../../../components/AdminProfileSearch';
import { notFound, redirect } from 'next/navigation';
import { getAdminIdentity } from '../../../../lib/admin/authorization';
import { getAdminDatasetProfileList } from '../../../../lib/datasets/admin';

export const metadata = { title: 'Dataset profiles · ACE Discover', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminDatasetPreview({ params }) {
  const identity = await getAdminIdentity();
  if (identity.state === 'unconfigured' || identity.state === 'unauthenticated') redirect('/admin');
  if (identity.state !== 'authorized') notFound();

  const { datasetId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(String(datasetId || ''))) notFound();
  const result = await getAdminDatasetProfileList(datasetId);
  if (!result) notFound();

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div><span>Admin-only dataset preview</span><h1>{result.dataset.name}</h1><p>{result.dataset.profileCount} normalized profiles · {result.dataset.status}. This route is never exposed through public dataset RPCs.</p></div>
        <div className="admin-header-actions"><Link href={`/admin?dataset=${encodeURIComponent(result.dataset.id)}`}>Back to Admin</Link></div>
      </header>
      <AdminProfileSearch datasetId={result.dataset.id} profiles={result.profiles} />
      <section className="admin-preview-profile-list" aria-label={`${result.dataset.name} profiles`}>
        {result.profiles.map((profile) => (
          <Link href={`/admin/preview/${encodeURIComponent(result.dataset.id)}/${encodeURIComponent(profile.id)}`} key={profile.id}>
            <strong>{profile.name}</strong>
            <span>{[profile.role, profile.major, profile.year].filter(Boolean).join(' · ')}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
