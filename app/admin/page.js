import Link from 'next/link';
import AdminIssueList from '../../components/AdminIssueList';
import ResetSeenHistory from '../../components/ResetSeenHistory';
import { importHealth } from '../../lib/import-health';
import { profiles } from '../../lib/profiles';

export const metadata = { title: 'Admin · ACE Discover', robots: { index: false, follow: false } };

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

function Distribution({ title, eyebrow, values }) {
  const maximum = Math.max(1, ...Object.values(values));
  return (
    <section className="admin-section">
      <div className="admin-section-title"><span>{eyebrow}</span><h2>{title}</h2></div>
      <div className="vibe-distribution">
        {Object.entries(values).map(([label, count]) => (
          <div key={label}>
            <span>{label}</span><strong>{count}</strong>
            <i style={{ '--vibe-width': `${Math.max(2, (count / maximum) * 100)}%` }} />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function AdminPage() {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const metrics = [
    ['Total profiles', importHealth.totalProfiles],
    ['Littles', importHealth.roleCounts.Little],
    ['Bigs', importHealth.roleCounts.Big],
    ['Family', importHealth.roleCounts.Family],
    ['Valid Instagram', importHealth.instagramCount],
    ['Slide decks', importHealth.slideDeckCount],
    ['Usable Drive images', importHealth.imageStatus.usable],
    ['Missing / invalid images', importHealth.imageStatus.missingOrInvalid],
  ];
  return (
    <main className="admin-shell">
      <header className="admin-header"><div><span>Organizer utility · no authentication</span><h1>ACE Discover health</h1><p>Safe aggregate data generated with the latest workbook import. This page contains no raw private application fields.</p></div><Link href="/">Open discovery</Link></header>
      <section className="admin-metrics" aria-label="Profile metrics">{metrics.map(([label, value]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}</section>
      <ResetSeenHistory />
      <section className="admin-section"><div className="admin-section-title"><span>Maintenance</span><h2>Actionable profile issues</h2></div>{Object.entries(issueMeta).map(([key, [title, description]]) => <AdminIssueList key={key} title={title} description={description} profiles={importHealth.issues[key].map((id) => byId.get(id)).filter(Boolean).map(({ id, name, role, program }) => ({ id, name, role, program }))} />)}</section>
      <Distribution eyebrow="Classification" title="Major Area distribution" values={importHealth.majorGroupDistribution} />
      <Distribution eyebrow="Classification" title="Social Level distribution" values={importHealth.socialLevelDistribution} />
      <Distribution eyebrow="Classification" title="Social Style distribution" values={importHealth.socialStyleDistribution} />
      <Distribution eyebrow="Classification" title="Vibe distribution" values={importHealth.vibeDistribution} />
      <footer className="admin-footer">Health report generated {new Date(importHealth.generatedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.</footer>
    </main>
  );
}
