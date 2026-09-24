import Link from 'next/link';
import AdminAppPreview from '../../components/AdminAppPreview';
import AdminIssueList from '../../components/AdminIssueList';
import AdminProfileQa from '../../components/AdminProfileQa';
import { AdminLogin, AdminSignOut } from '../../components/AdminAuth';
import DatasetManager from '../../components/DatasetManager';
import ResetSeenHistory from '../../components/ResetSeenHistory';
import { getAdminIdentity } from '../../lib/admin/authorization';
import { listAdminDatasets } from '../../lib/datasets/admin';

export const metadata = { title: 'Admin · ACE Discover', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const issueMeta = {
  missingInstagram: ['Missing Instagram', 'No valid canonical Instagram profile URL.'],
  missingMajor: ['Missing major', 'Major is blank or uses a missing-value placeholder.'],
  missingYear: ['Missing year', 'Year is blank or uses a missing-value placeholder.'],
  missingMeaningfulText: ['Missing meaningful text', 'Profile has fewer than 40 meaningful characters across public body fields.'],
  missingOrInvalidImage: ['Missing or invalid image', 'Image submission cannot currently be served by ACE Discover.'],
  missingSocialLevel: ['Missing social level', 'No valid 1–5 response was available in the applicable form layout.'],
  missingSocialStyle: ['Missing social style', 'No conservative Introvert, Ambivert, or Extrovert classification was available.'],
  missingOrUnclassifiedMajorGroup: ['Other / unclassified major area', 'The submitted major is missing, undeclared, or does not match a reliable major-area rule.'],
};

function Distribution({ title, eyebrow, values = {} }) {
  const maximum = Math.max(1, ...Object.values(values));
  return (
    <section className="admin-section">
      <div className="admin-section-title"><span>{eyebrow}</span><h2>{title}</h2></div>
      <div className="vibe-distribution">{Object.entries(values).map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong><i style={{ '--vibe-width': `${Math.max(2, (count / maximum) * 100)}%` }} /></div>)}</div>
    </section>
  );
}

function AuthScreen({ state, authError }) {
  const unconfigured = state === 'unconfigured';
  return (
    <main className="admin-auth-shell">
      <section className="admin-auth-card">
        <span>ACE Discover Admin</span>
        <h1>{unconfigured ? 'Admin setup required' : 'Organizer access'}</h1>
        <p>{unconfigured ? 'Configure the Supabase public Auth environment variables to enable Google sign-in.' : 'Sign in with an authorized Google account to manage semester datasets.'}</p>
        {authError && <p className="admin-form-error" role="alert">Google sign-in could not be completed. Please try again.</p>}
        <AdminLogin configured={!unconfigured} />
        <Link href="/">Back to public discovery</Link>
      </section>
    </main>
  );
}

export default async function AdminPage({ searchParams }) {
  const identity = await getAdminIdentity();
  const query = await searchParams;
  if (identity.state === 'unconfigured' || identity.state === 'unauthenticated') {
    return <AuthScreen state={identity.state} authError={query?.authError === '1'} />;
  }
  if (identity.state === 'denied') {
    return (
      <main className="admin-auth-shell"><section className="admin-auth-card"><span>ACE Discover Admin</span><h1>Access denied</h1><p>{identity.user.email} is signed in but is not an authorized ACE Discover Owner or Admin.</p><AdminSignOut /><Link href="/">Back to public discovery</Link></section></main>
    );
  }

  let datasets = [];
  let databaseError = '';
  try {
    datasets = await listAdminDatasets();
  } catch (error) {
    databaseError = error.message;
  }
  const selected = datasets.find((dataset) => dataset.id === query?.dataset)
    || datasets.find((dataset) => dataset.status === 'active')
    || datasets[0];
  const health = selected?.health;
  const safeIssues = selected?.safeIssues || {};
  const metrics = health ? [
    ['Total records', selected.totalRecordCount ?? health.totalProfiles],
    ['Public profiles', selected.publicProfileCount ?? health.totalProfiles],
    ['Hidden profiles', selected.hiddenProfileCount ?? 0],
    ['Littles', health.roleCounts.Little],
    ['Bigs', health.roleCounts.Big],
    ['Family', health.roleCounts.Family],
    ['Valid Instagram', health.instagramCount],
    ['Slide decks', health.slideDeckCount],
    ['Usable images', health.imageStatus.usable],
    ['Image issues', health.imageStatus.missingOrInvalid],
  ] : [];

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div><span>{identity.role} · {identity.user.email}</span><h1>ACE Discover Admin</h1><p>Authenticated semester publishing and privacy-safe import health.</p></div>
        <div className="admin-header-actions"><Link href="/">Open discovery</Link><AdminSignOut /></div>
      </header>
      {databaseError && <p className="admin-setup-warning" role="alert">Database setup is incomplete: {databaseError}</p>}
      <DatasetManager datasets={datasets} selectedDatasetId={selected?.id || ''} />
      <AdminAppPreview />
      {selected && health && (
        <>
          <section className="admin-dataset-heading"><span>Inspecting dataset</span><h2>{selected.name}</h2><b>{selected.status}</b></section>
          <section className="admin-metrics" aria-label="Profile metrics">{metrics.map(([label, value]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}</section>
          <ResetSeenHistory datasetSlug={selected.slug} datasetName={selected.name} />
          <section className="admin-section"><div className="admin-section-title"><span>Maintenance</span><h2>Actionable profile issues</h2></div>{Object.entries(issueMeta).map(([key, [title, description]]) => <AdminIssueList key={key} title={title} description={description} profiles={safeIssues[key] || []} datasetId={selected.id} />)}</section>
          <AdminProfileQa datasetId={selected.id} />
          <Distribution eyebrow="Classification" title="Major Area distribution" values={health.majorGroupDistribution} />
          <Distribution eyebrow="Classification" title="Social Level distribution" values={health.socialLevelDistribution} />
          <Distribution eyebrow="Classification" title="Social Style distribution" values={health.socialStyleDistribution} />
          <Distribution eyebrow="Classification" title="Vibe distribution" values={health.vibeDistribution} />
          <footer className="admin-footer">Health report generated {new Date(health.generatedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.</footer>
        </>
      )}
    </main>
  );
}
