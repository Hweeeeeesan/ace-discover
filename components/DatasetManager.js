'use client';

import Link from 'next/link';
import { Archive, CheckCircle2, Database, RotateCcw, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The request failed.');
  return payload;
}

function PreviewDistribution({ title, values = {} }) {
  return (
    <div className="dataset-preview-distribution">
      <strong>{title}</strong>
      <div>{Object.entries(values).map(([label, count]) => <span key={label}>{label}<b>{count}</b></span>)}</div>
    </div>
  );
}

function ImportPreview({ preview, onSaved }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const health = preview.health;
  const metrics = [
    ['Total profiles', health.totalProfiles],
    ['Little', health.roleCounts.Little || 0],
    ['Big', health.roleCounts.Big || 0],
    ['Family', health.roleCounts.Family || 0],
    ['Usable images', health.imageStatus.usable],
    ['Image issues', health.imageStatus.missingOrInvalid],
    ['Valid Instagram', health.instagramCount],
    ['Slide decks', health.slideDeckCount],
    ['Missing major', health.missingFieldCounts.missingMajor],
    ['Missing year', health.missingFieldCounts.missingYear],
    ['Other / Undeclared', health.missingFieldCounts.missingOrUnclassifiedMajorGroup],
    ['Missing social level', health.missingFieldCounts.missingSocialLevel],
    ['Missing social style', health.missingFieldCounts.missingSocialStyle],
  ];

  async function save() {
    setPending(true);
    setError('');
    try {
      const result = await postJson('/api/admin/datasets/save', { importId: preview.importId });
      onSaved(result.dataset);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="dataset-import-preview" aria-label="Import preview">
      <div className="dataset-preview-heading">
        <div><span>Safe import preview</span><h3>{preview.metadata.name}</h3></div>
        <b>Not live</b>
      </div>
      <div className="dataset-preview-metrics">{metrics.map(([label, value]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}</div>
      <div className="dataset-preview-distributions">
        <PreviewDistribution title="Major Area" values={health.majorGroupDistribution} />
        <PreviewDistribution title="Social Level" values={health.socialLevelDistribution} />
        <PreviewDistribution title="Social Style" values={health.socialStyleDistribution} />
        <PreviewDistribution title="Vibes" values={health.vibeDistribution} />
      </div>
      <div className="dataset-preview-issues">
        {Object.entries(preview.safeIssues || {}).filter(([, profiles]) => profiles.length).map(([key, profiles]) => (
          <details key={key}>
            <summary>{key.replace(/([A-Z])/g, ' $1')} <b>{profiles.length}</b></summary>
            <ul>{profiles.slice(0, 40).map((profile) => <li key={profile.id}><strong>{profile.name}</strong><span>{profile.role} · {profile.id}</span></li>)}</ul>
          </details>
        ))}
      </div>
      <p className="dataset-preview-note">Only normalized public profile fields and Drive allowlist IDs will be saved. The uploaded workbook is not retained.</p>
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      <button className="dataset-primary-action" type="button" onClick={save} disabled={pending}>
        <Database size={17} /> {pending ? 'Saving…' : 'Save Dataset'}
      </button>
    </section>
  );
}

export default function DatasetManager({ datasets, selectedDatasetId = '' }) {
  const router = useRouter();
  const [showImport, setShowImport] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pendingAction, setPendingAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const active = datasets.find((dataset) => dataset.status === 'active');
  const selected = datasets.find((dataset) => dataset.id === selectedDatasetId) || active || datasets[0];
  const defaultYear = new Date().getFullYear();
  const defaultTerm = new Date().getMonth() >= 6 ? 'Fall' : 'Spring';
  const suggestedName = useMemo(() => `${defaultTerm} ${defaultYear}`, [defaultTerm, defaultYear]);

  async function analyze(event) {
    event.preventDefault();
    setPendingAction('analyze');
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/datasets/analyze', { method: 'POST', body: new FormData(event.currentTarget) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Workbook analysis failed.');
      setPreview(payload);
    } catch (analyzeError) {
      setError(analyzeError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function activate(dataset) {
    const confirmation = `Make ${dataset.name} live?\nThe public discovery feed will switch to this dataset.\nThe current dataset will remain saved.`;
    if (!window.confirm(confirmation)) return;
    setPendingAction(dataset.id);
    setError('');
    try {
      await postJson('/api/admin/datasets/activate', { datasetId: dataset.id });
      setMessage(`${dataset.name} is now live. The previous dataset remains archived and can be restored.`);
      router.refresh();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function setStatus(dataset, status) {
    setPendingAction(dataset.id);
    setError('');
    try {
      await postJson('/api/admin/datasets/status', { datasetId: dataset.id, status });
      setMessage(`${dataset.name} is now ${status}.`);
      router.refresh();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setPendingAction('');
    }
  }

  return (
    <section className="dataset-manager admin-section" aria-labelledby="dataset-manager-title">
      <div className="admin-section-title"><span>Semester publishing</span><h2 id="dataset-manager-title">Dataset Manager</h2></div>
      <div className="live-dataset-card">
        <span>Live dataset</span>
        <strong>{active?.name || 'No database dataset is active'}</strong>
        <b>{active ? `${active.profileCount} profiles` : 'Public discovery is using the Fall 2025 fallback'}</b>
      </div>
      <div className="dataset-list">
        {datasets.map((dataset) => (
          <article className={dataset.id === selected?.id ? 'is-selected' : ''} key={dataset.id}>
            <div><strong>{dataset.name}</strong><span>{dataset.profileCount} profiles · imported {dataset.importedAt ? new Date(dataset.importedAt).toLocaleDateString() : '—'}</span></div>
            <b className={`dataset-status status-${dataset.status}`}>{dataset.status}</b>
            <div className="dataset-actions">
              <Link href={`/admin?dataset=${encodeURIComponent(dataset.id)}`}>Health</Link>
              <Link href={`/admin/preview/${encodeURIComponent(dataset.id)}`}>Profiles</Link>
              {dataset.status !== 'active' && <button type="button" onClick={() => activate(dataset)} disabled={Boolean(pendingAction)}>Make Active</button>}
              {dataset.status === 'ready' && <button type="button" onClick={() => setStatus(dataset, 'archived')} disabled={Boolean(pendingAction)}><Archive size={14} /> Archive</button>}
              {dataset.status === 'archived' && <button type="button" onClick={() => setStatus(dataset, 'ready')} disabled={Boolean(pendingAction)}><RotateCcw size={14} /> Restore</button>}
            </div>
          </article>
        ))}
        {!datasets.length && <p className="dataset-empty">Run the migration and seed Fall 2025, then refresh this page.</p>}
      </div>
      <button className="dataset-import-toggle" type="button" onClick={() => setShowImport((value) => !value)}><Upload size={17} /> Import Semester</button>
      {showImport && (
        <form className="dataset-import-form" onSubmit={analyze}>
          <label>Semester name<input name="name" defaultValue={suggestedName} maxLength="100" required /></label>
          <label>Term<select name="term" defaultValue={defaultTerm}><option>Spring</option><option>Summer</option><option>Fall</option><option>Winter</option></select></label>
          <label>Year<input name="year" type="number" min="2020" max="2100" defaultValue={defaultYear} required /></label>
          <label className="dataset-file-input">Workbook (.xlsx, max 15 MiB)<input name="workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
          <p>The workbook is analyzed with the existing ACE privacy and normalization importer. Analysis never publishes automatically.</p>
          <button className="dataset-primary-action" type="submit" disabled={pendingAction === 'analyze'}><Upload size={17} /> {pendingAction === 'analyze' ? 'Analyzing…' : 'Analyze workbook'}</button>
        </form>
      )}
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      {message && <p className="admin-form-success" role="status"><CheckCircle2 size={16} /> {message}</p>}
      {preview && <ImportPreview preview={preview} onSaved={(dataset) => { setPreview(null); setShowImport(false); setMessage(`${dataset.name} was saved as READY and is not live.`); router.refresh(); }} />}
    </section>
  );
}
