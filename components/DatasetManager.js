'use client';

import Link from 'next/link';
import { AlertTriangle, Archive, CheckCircle2, Database, FileSpreadsheet, Images, Link2, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

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

async function deleteJson(url) {
  const response = await fetch(url, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The semester could not be removed.');
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

const IMAGE_HEALTH_LABELS = Object.freeze({
  ready: 'Ready',
  needs_import: 'Need import',
  unsupported_source: 'Unsupported source',
  degraded_source: 'Degraded fallback',
  inaccessible: 'Inaccessible',
  normalization_required: 'Need normalization',
  failed: 'Failed',
  no_source: 'No source',
});

function ImageSourceHealthSummary({ report, loading, error, showIssues, onToggleIssues, onRefresh }) {
  const counts = report?.summary?.counts || {};
  return (
    <div className="dataset-image-health">
      <div className="dataset-image-health-summary" aria-live="polite">
        {Object.entries(IMAGE_HEALTH_LABELS).map(([state, label]) => (
          <article key={state} className={`state-${state}`}>
            <strong>{report ? counts[state] || 0 : '—'}</strong>
            <span>{label}</span>
          </article>
        ))}
      </div>
      <div className="dataset-image-health-actions">
        <button type="button" onClick={onRefresh} disabled={loading}>{loading ? 'Checking…' : 'Re-check sources'}</button>
        <button type="button" onClick={onToggleIssues} disabled={!report?.issues?.length} aria-expanded={showIssues}>Review issues</button>
      </div>
      {error && <small className="dataset-image-health-error" role="alert">{error}</small>}
      {showIssues && report?.issues?.length > 0 && (
        <ul className="dataset-image-health-issues">
          {report.issues.map((profile) => (
            <li key={profile.id}>
              <div><strong>{profile.name}</strong><span>{profile.health.label}</span></div>
              <p>{profile.health.summary}</p>
              {profile.health.dimensions?.length > 0 && <small>{profile.health.dimensions.map((item) => item.label).join(' · ')}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContentQaPreviewSummary({ contentQa }) {
  if (!contentQa?.summary) return null;
  const summary = contentQa.summary;
  return (
    <section className="dataset-content-qa-preview" aria-label="Public response QA preview">
      <div><strong>Public response QA</strong><span>Deterministic content review · Admin-only</span></div>
      <p><b>{summary.clearProfiles}</b> clear <b>{summary.reviewProfiles}</b> need review <b>{summary.blockedProfiles}</b> blocked</p>
    </section>
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
      <ContentQaPreviewSummary contentQa={preview.contentQa} />
      <div className="dataset-preview-issues">
        {Object.entries(preview.safeIssues || {}).filter(([, profiles]) => profiles.length).map(([key, profiles]) => (
          <details key={key}>
            <summary>{key.replace(/([A-Z])/g, ' $1')} <b>{profiles.length}</b></summary>
            <ul>{profiles.slice(0, 40).map((profile) => <li key={profile.id}><strong>{profile.name}</strong><span>{profile.role} · {profile.id}</span></li>)}</ul>
          </details>
        ))}
      </div>
      <p className="dataset-preview-note">Only normalized public profile fields and Drive allowlist IDs will be saved. Source files and private Sheet responses are not retained.</p>
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      <button className="dataset-primary-action" type="button" onClick={save} disabled={pending}>
        <Database size={17} /> {pending ? 'Saving…' : 'Save Dataset'}
      </button>
    </section>
  );
}

function SyncPreview({ preview, onApplied, onCancel }) {
  const [pending, setPending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const { diff } = preview;
  const needsAcknowledgement = diff.counts.removed > 0;

  async function apply() {
    setPending(true);
    setError('');
    try {
      const result = await postJson('/api/admin/datasets/sync/apply', {
        importId: preview.importId,
        datasetId: preview.metadata.id,
        acknowledgeRemoved: acknowledged,
        sourceType: preview.sourceType,
        sheetId: preview.sheetId,
        sheetTab: preview.sheetTab,
        sourceHash: preview.sourceHash,
        previewHash: preview.previewHash,
      });
      onApplied(result.dataset);
    } catch (applyError) {
      setError(applyError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="dataset-import-preview dataset-sync-preview" aria-label="Changes since last sync">
      <div className="dataset-preview-heading">
        <div><span>Changes since last sync</span><h3>{preview.metadata.name}</h3></div>
        <b>Not applied</b>
      </div>
      <div className="dataset-diff-counts">
        <article><strong>+ {diff.counts.added}</strong><span>New profiles</span></article>
        <article><strong>~ {diff.counts.updated}</strong><span>Updated profiles</span></article>
        <article><strong>− {diff.counts.removed}</strong><span>Missing from source</span></article>
      </div>
      {!diff.hasChanges && <p className="dataset-no-changes">No normalized public profile changes were found.</p>}
      {diff.added.length > 0 && <div className="dataset-diff-group"><h4>New</h4><ul>{diff.added.map((profile) => <li key={profile.id}><b>+</b><strong>{profile.name}</strong></li>)}</ul></div>}
      {diff.updated.length > 0 && <div className="dataset-diff-group"><h4>Updated</h4><ul>{diff.updated.map((profile) => <li key={profile.id}><b>~</b><span><strong>{profile.name}</strong><small>{profile.fields.join(' · ')}</small></span></li>)}</ul></div>}
      {needsAcknowledgement && (
        <div className="dataset-removed-warning">
          <AlertTriangle size={18} />
          <div><strong>{diff.counts.removed} profile{diff.counts.removed === 1 ? ' is' : 's are'} no longer present in the source.</strong><p>ACE Discover will preserve {diff.counts.removed === 1 ? 'this profile' : 'these profiles'} and all existing galleries.</p></div>
          <ul>{diff.removed.map((profile) => <li key={profile.id}>{profile.name}</li>)}</ul>
          <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand these profiles are missing from the source and will be preserved.</label>
        </div>
      )}
      <p className="dataset-preview-note">Applying updates normalized public fields atomically. Existing Admin-managed galleries remain authoritative; changed Drive links are reported but do not replace them.</p>
      <ContentQaPreviewSummary contentQa={preview.contentQa} />
      <p className="dataset-preview-note">Validated snapshot: {preview.health.totalProfiles} profiles. No public change occurs until Apply Changes succeeds.</p>
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      <div className="dataset-preview-actions">
        <button type="button" onClick={onCancel} disabled={pending}>Cancel</button>
        <button className="dataset-primary-action" type="button" onClick={apply} disabled={pending || (needsAcknowledgement && !acknowledged)}><Database size={17} /> {pending ? 'Applying…' : 'Apply Changes'}</button>
      </div>
    </section>
  );
}

function SheetConnector({ dataset, onPreview, onError, setPendingAction, pendingAction }) {
  const [sheetUrl, setSheetUrl] = useState('');
  const [connection, setConnection] = useState(null);
  const [tab, setTab] = useState('');

  async function inspect(event) {
    event.preventDefault();
    setPendingAction('connect-sheet');
    onError('');
    try {
      const result = await postJson('/api/admin/datasets/sheets/connect', { sheetUrl });
      setConnection(result);
      setTab(result.suggestedTab || '');
    } catch (connectError) {
      onError(connectError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function previewSync() {
    if (!connection || !tab) return;
    setPendingAction('analyze-sheet');
    onError('');
    try {
      const result = await postJson('/api/admin/datasets/sheets/analyze', {
        datasetId: dataset.id,
        sheetId: connection.sheetId,
        tab,
      });
      onPreview(result);
    } catch (analyzeError) {
      onError(analyzeError.message);
    } finally {
      setPendingAction('');
    }
  }

  return (
    <form className="dataset-sheet-connector" onSubmit={inspect}>
      <label>Google Sheets URL<input type="url" value={sheetUrl} onChange={(event) => { setSheetUrl(event.target.value); setConnection(null); setTab(''); }} placeholder="https://docs.google.com/spreadsheets/d/…/edit" required /></label>
      <button type="submit" disabled={Boolean(pendingAction)}><Link2 size={16} /> {pendingAction === 'connect-sheet' ? 'Checking access…' : 'Connect Google Sheet'}</button>
      {connection && (
        <div className="dataset-sheet-confirmation">
          <p><strong>{connection.title}</strong><span>Service account access verified</span></p>
          <label>Worksheet<select value={tab} onChange={(event) => setTab(event.target.value)} required><option value="">Choose a worksheet</option>{connection.tabs.map((item) => <option key={item.id} value={item.title}>{item.title}</option>)}</select></label>
          {!connection.suggestedTab && connection.tabs.length > 1 && <small>Multiple worksheets were found. Choose the response worksheet before continuing.</small>}
          <button type="button" className="dataset-primary-action" onClick={previewSync} disabled={!tab || Boolean(pendingAction)}><RefreshCw size={16} /> {pendingAction === 'analyze-sheet' ? 'Analyzing…' : 'Preview Sheet changes'}</button>
        </div>
      )}
    </form>
  );
}

export default function DatasetManager({ datasets, selectedDatasetId = '' }) {
  const router = useRouter();
  const [showImport, setShowImport] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pendingAction, setPendingAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showSourceEditor, setShowSourceEditor] = useState(false);
  const [showManualUpdate, setShowManualUpdate] = useState(false);
  const [addSource, setAddSource] = useState('excel');
  const [addSheetUrl, setAddSheetUrl] = useState('');
  const [addSheet, setAddSheet] = useState(null);
  const [addSheetTab, setAddSheetTab] = useState('');
  const [addName, setAddName] = useState('');
  const [addTerm, setAddTerm] = useState('');
  const [addYear, setAddYear] = useState('');
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeConfirmation, setRemoveConfirmation] = useState('');
  const [editingDatasetId, setEditingDatasetId] = useState('');
  const [datasetNameDraft, setDatasetNameDraft] = useState('');
  const [imageImportStatus, setImageImportStatus] = useState(null);
  const [imageImportResult, setImageImportResult] = useState(null);
  const [imageImportError, setImageImportError] = useState('');
  const [imageStatusVersion, setImageStatusVersion] = useState(0);
  const [imageHealth, setImageHealth] = useState(null);
  const [imageHealthError, setImageHealthError] = useState('');
  const [imageHealthLoading, setImageHealthLoading] = useState(false);
  const [showImageHealthIssues, setShowImageHealthIssues] = useState(false);
  const active = datasets.find((dataset) => dataset.status === 'active');
  const selected = datasets.find((dataset) => dataset.id === selectedDatasetId) || active || datasets[0];
  const defaultYear = new Date().getFullYear();
  const defaultTerm = new Date().getMonth() >= 6 ? 'Fall' : 'Spring';
  const suggestedName = useMemo(() => `${defaultTerm} ${defaultYear}`, [defaultTerm, defaultYear]);

  useEffect(() => {
    setImageImportResult(null);
    setImageImportError('');
    setImageHealth(null);
    setImageHealthError('');
    setShowImageHealthIssues(false);
  }, [selected?.id]);

  useEffect(() => {
    let cancelled = false;
    setImageImportError('');
    if (!selected || selected.status === 'archived') {
      setImageImportStatus(null);
      return () => { cancelled = true; };
    }
    setImageImportStatus(null);
    postJson('/api/admin/datasets/images/import/status', { datasetId: selected.id })
      .then((result) => { if (!cancelled) setImageImportStatus(result); })
      .catch((statusError) => { if (!cancelled) setImageImportError(statusError.message); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.status, imageStatusVersion]);

  async function checkImageSourceHealth() {
    if (!selected) return;
    setImageHealthLoading(true);
    setImageHealthError('');
    try {
      setImageHealth(await postJson('/api/admin/datasets/images/health', { datasetId: selected.id }));
    } catch (healthError) {
      setImageHealthError(healthError.message);
    } finally {
      setImageHealthLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!selected) return () => { cancelled = true; };
    setImageHealthLoading(true);
    setImageHealthError('');
    postJson('/api/admin/datasets/images/health', { datasetId: selected.id })
      .then((result) => { if (!cancelled) setImageHealth(result); })
      .catch((healthError) => { if (!cancelled) setImageHealthError(healthError.message); })
      .finally(() => { if (!cancelled) setImageHealthLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id, imageStatusVersion]);

  function openAddSemester() {
    const next = !showImport;
    if (next) {
      setAddName(suggestedName);
      setAddTerm(defaultTerm);
      setAddYear(String(defaultYear));
    }
    setShowImport(next);
  }

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

  async function checkSheetUpdates() {
    if (!selected) return;
    setPendingAction('check-sheet');
    setError('');
    setMessage('');
    try {
      setPreview(await postJson('/api/admin/datasets/sheets/analyze', { datasetId: selected.id }));
    } catch (checkError) {
      setError(checkError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function previewMissingImages() {
    if (!selected) return;
    setPendingAction('preview-images');
    setImageImportError('');
    try {
      setImageImportResult(await postJson('/api/admin/datasets/images/import/preview', {
        datasetId: selected.id,
      }));
    } catch (previewError) {
      setImageImportError(previewError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function importMissingImages() {
    if (!selected || imageImportResult?.mode !== 'preview') return;
    setPendingAction('apply-images');
    setImageImportError('');
    try {
      const result = await postJson('/api/admin/datasets/images/import/apply', {
        datasetId: selected.id,
        confirm: true,
      });
      setImageImportResult(result);
      setImageStatusVersion((value) => value + 1);
      router.refresh();
    } catch (applyError) {
      setImageImportError(applyError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function inspectAddSheet() {
    setPendingAction('connect-new-sheet');
    setError('');
    try {
      const result = await postJson('/api/admin/datasets/sheets/connect', { sheetUrl: addSheetUrl });
      setAddSheet(result);
      setAddSheetTab(result.suggestedTab || '');
    } catch (connectError) {
      setError(connectError.message);
    } finally {
      setPendingAction('');
    }
  }

  async function analyzeNewSheet(event) {
    event.preventDefault();
    if (!addSheet || !addSheetTab) {
      setError('Verify the Google Sheet and choose a worksheet first.');
      return;
    }
    setPendingAction('analyze-new-sheet');
    setError('');
    setMessage('');
    try {
      setPreview(await postJson('/api/admin/datasets/sheets/analyze', {
        name: addName,
        term: addTerm,
        year: addYear,
        sheetId: addSheet.sheetId,
        tab: addSheetTab,
      }));
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

  function startEditingName(dataset) {
    setError('');
    setMessage('');
    setEditingDatasetId(dataset.id);
    setDatasetNameDraft(dataset.name);
  }

  function cancelEditingName() {
    if (!pendingAction.startsWith('rename-')) {
      setEditingDatasetId('');
      setDatasetNameDraft('');
    }
  }

  async function saveDatasetName(event, dataset) {
    event.preventDefault();
    const name = datasetNameDraft.trim();
    if (!name) {
      setError('Dataset name is required.');
      return;
    }
    setPendingAction(`rename-${dataset.id}`);
    setError('');
    setMessage('');
    try {
      await postJson('/api/admin/datasets/name', { datasetId: dataset.id, name });
      setEditingDatasetId('');
      setDatasetNameDraft('');
      setMessage(`Dataset renamed to ${name}.`);
      router.refresh();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setPendingAction('');
    }
  }

  function openRemoveDialog(dataset) {
    if (dataset.status === 'active') {
      setError('You cannot remove the active semester. Activate another semester first.');
      return;
    }
    setError('');
    setMessage('');
    setRemoveConfirmation('');
    setRemoveTarget(dataset);
  }

  function closeRemoveDialog() {
    if (pendingAction === `remove-${removeTarget?.id}`) return;
    setRemoveTarget(null);
    setRemoveConfirmation('');
  }

  async function removeSemester() {
    if (!removeTarget || removeConfirmation !== removeTarget.name) return;
    setPendingAction(`remove-${removeTarget.id}`);
    setError('');
    try {
      const result = await deleteJson(`/api/admin/datasets/${encodeURIComponent(removeTarget.id)}`);
      const deleted = result.dataset || {};
      setMessage(`${removeTarget.name} was removed with ${deleted.profilesDeleted || 0} profiles, ${deleted.imageRowsDeleted || 0} image records, and ${deleted.storageObjectsDeleted || 0} Storage objects.`);
      setRemoveTarget(null);
      setRemoveConfirmation('');
      router.replace('/admin');
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
            {editingDatasetId === dataset.id ? (
              <form className="dataset-name-editor" onSubmit={(event) => saveDatasetName(event, dataset)}>
                <label>Dataset name<input autoFocus value={datasetNameDraft} onChange={(event) => setDatasetNameDraft(event.target.value)} maxLength="100" required /></label>
                <div><button type="submit" disabled={pendingAction === `rename-${dataset.id}`}>{pendingAction === `rename-${dataset.id}` ? 'Saving…' : 'Save name'}</button><button type="button" onClick={cancelEditingName} disabled={pendingAction === `rename-${dataset.id}`}>Cancel</button></div>
              </form>
            ) : <div><strong>{dataset.name}</strong><span>{dataset.slug} · {dataset.profileCount} profiles · imported {dataset.importedAt ? new Date(dataset.importedAt).toLocaleDateString() : '—'}</span></div>}
            <b className={`dataset-status status-${dataset.status}`}>{dataset.status}</b>
            <div className="dataset-actions">
              <Link href={`/admin?dataset=${encodeURIComponent(dataset.id)}`}>Health</Link>
              <Link href={`/admin/preview/${encodeURIComponent(dataset.id)}`}>Profiles</Link>
              {editingDatasetId !== dataset.id && <button type="button" onClick={() => startEditingName(dataset)} disabled={Boolean(pendingAction) || dataset.deletionPending}><Pencil size={14} /> Edit name</button>}
              {dataset.status !== 'active' && <button type="button" onClick={() => activate(dataset)} disabled={Boolean(pendingAction) || dataset.deletionPending}>Make Active</button>}
              {dataset.status === 'ready' && <button type="button" onClick={() => setStatus(dataset, 'archived')} disabled={Boolean(pendingAction) || dataset.deletionPending}><Archive size={14} /> Archive</button>}
              {dataset.status === 'archived' && <button type="button" onClick={() => setStatus(dataset, 'ready')} disabled={Boolean(pendingAction) || dataset.deletionPending}><RotateCcw size={14} /> Restore</button>}
              <button
                type="button"
                className="dataset-remove-action"
                onClick={() => openRemoveDialog(dataset)}
                disabled={Boolean(pendingAction) || dataset.status === 'active'}
                aria-describedby={dataset.status === 'active' ? `active-remove-note-${dataset.id}` : undefined}
                title={dataset.status === 'active' ? 'Activate another semester before removing this one.' : 'Permanently remove this semester'}
              >
                <Trash2 size={14} /> {dataset.status === 'active' ? 'Active — cannot remove' : dataset.deletionPending ? 'Finish Removal' : 'Remove Semester'}
              </button>
              {dataset.status === 'active' && <span className="sr-only" id={`active-remove-note-${dataset.id}`}>You cannot remove the active semester. Activate another semester first.</span>}
            </div>
          </article>
        ))}
        {!datasets.length && <p className="dataset-empty">Run the migration and seed Fall 2025, then refresh this page.</p>}
      </div>
      {selected && (
        <section className="dataset-source-card" aria-labelledby="dataset-source-title">
          <div><span>Data source</span><h3 id="dataset-source-title">{selected.sourceType === 'google_sheet' ? 'Google Sheet' : 'Excel Workbook'}</h3></div>
          {selected.sourceType === 'google_sheet' ? (
            <div className="dataset-source-details">
              <strong>{selected.googleSheetTitle || 'Connected Google Sheet'}</strong>
              <span><CheckCircle2 size={14} /> Connected · {selected.googleSheetTab}</span>
              <small>Last synced {selected.lastSourceSyncAt ? new Date(selected.lastSourceSyncAt).toLocaleString() : '—'}</small>
            </div>
          ) : <p>Upload a workbook whenever this semester needs a reviewed update.</p>}
          <div className="dataset-source-actions">
            {selected.sourceType === 'google_sheet' && <button type="button" onClick={checkSheetUpdates} disabled={Boolean(pendingAction)}><RefreshCw size={16} /> {pendingAction === 'check-sheet' ? 'Checking…' : 'Check for updates'}</button>}
            <button type="button" onClick={() => setShowManualUpdate((value) => !value)} disabled={Boolean(pendingAction)}><FileSpreadsheet size={16} /> {selected.sourceType === 'google_sheet' ? 'Upload Excel fallback' : 'Upload Updated Workbook'}</button>
            {selected.sourceType !== 'google_sheet' && <button type="button" onClick={() => setShowSourceEditor((value) => !value)} disabled={Boolean(pendingAction)}><Link2 size={16} /> Connect Google Sheet</button>}
          </div>
          {showManualUpdate && (
            <form className="dataset-source-inline-form" onSubmit={analyze}>
              <input type="hidden" name="datasetId" value={selected.id} />
              <label>Workbook (.xlsx, max 15 MiB)<input name="workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
              <p>This fallback uses the same preview and approval flow. A connected Sheet remains connected.</p>
              <button className="dataset-primary-action" type="submit" disabled={pendingAction === 'analyze'}><Upload size={17} /> {pendingAction === 'analyze' ? 'Analyzing…' : 'Preview workbook update'}</button>
            </form>
          )}
          {showSourceEditor && selected.sourceType !== 'google_sheet' && <SheetConnector dataset={selected} onPreview={setPreview} onError={setError} setPendingAction={setPendingAction} pendingAction={pendingAction} />}
        </section>
      )}
      {selected && (
        <section className="dataset-image-import-card" id="dataset-image-source-health" aria-labelledby="dataset-images-title">
          <div className="dataset-image-import-heading">
            <span>Image source health</span>
            <h3 id="dataset-images-title">Storage and Drive readiness</h3>
          </div>
          <p>Read-only checks use the same Drive download, validation, thumbnail guard, and normalization path as image import.</p>
          <ImageSourceHealthSummary
            report={imageHealth}
            loading={imageHealthLoading}
            error={imageHealthError}
            showIssues={showImageHealthIssues}
            onToggleIssues={() => setShowImageHealthIssues((value) => !value)}
            onRefresh={checkImageSourceHealth}
          />
          <div className="dataset-image-import-action-row">
            <span>{selected.status === 'archived'
              ? 'Restore this archived dataset before importing images.'
              : `${imageImportStatus ? imageImportStatus.profilesNeedingImport : '—'} profile${imageImportStatus?.profilesNeedingImport === 1 ? '' : 's'} need image import.`}</span>
            <button
              type="button"
              title="Preview missing images"
              onClick={previewMissingImages}
              disabled={selected.status === 'archived' || !imageImportStatus?.profilesNeedingImport || Boolean(pendingAction)}
            >
              <Images size={16} /> {pendingAction === 'preview-images' ? 'Previewing…' : 'Preview image import'}
            </button>
          </div>
          {imageImportError && !imageImportResult && <small role="alert">{imageImportError}</small>}
        </section>
      )}
      <button className="dataset-import-toggle" type="button" onClick={openAddSemester} aria-expanded={showImport}><Plus size={17} /> {showImport ? 'Close Add Semester' : 'Add Semester'}</button>
      {showImport && (
        <form className="dataset-import-form" onSubmit={addSource === 'excel' ? analyze : analyzeNewSheet}>
          <label>Semester name<input name="name" value={addName} onChange={(event) => setAddName(event.target.value)} maxLength="100" required /></label>
          <label>Term<select name="term" value={addTerm} onChange={(event) => setAddTerm(event.target.value)}><option>Spring</option><option>Summer</option><option>Fall</option><option>Winter</option></select></label>
          <label>Year<input name="year" type="number" min="2020" max="2100" value={addYear} onChange={(event) => setAddYear(event.target.value)} required /></label>
          <div className="dataset-source-picker" role="group" aria-label="Data source">
            <span>Data source</span>
            <button type="button" className={addSource === 'excel' ? 'is-selected' : ''} onClick={() => setAddSource('excel')}><FileSpreadsheet size={16} /> Upload Excel Workbook</button>
            <button type="button" className={addSource === 'google_sheet' ? 'is-selected' : ''} onClick={() => setAddSource('google_sheet')}><Link2 size={16} /> Connect Google Sheet</button>
          </div>
          {addSource === 'excel' ? (
            <label className="dataset-file-input">Workbook (.xlsx, max 15 MiB)<input name="workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
          ) : (
            <div className="dataset-new-sheet-fields">
              <label>Google Sheets URL<input type="url" value={addSheetUrl} onChange={(event) => { setAddSheetUrl(event.target.value); setAddSheet(null); }} placeholder="https://docs.google.com/spreadsheets/d/…/edit" required /></label>
              <button type="button" onClick={inspectAddSheet} disabled={!addSheetUrl || Boolean(pendingAction)}>{pendingAction === 'connect-new-sheet' ? 'Checking access…' : 'Verify Sheet'}</button>
              {addSheet && <label>Worksheet<select value={addSheetTab} onChange={(event) => setAddSheetTab(event.target.value)} required><option value="">Choose a worksheet</option>{addSheet.tabs.map((tab) => <option key={tab.id} value={tab.title}>{tab.title}</option>)}</select></label>}
              {addSheet && !addSheet.suggestedTab && addSheet.tabs.length > 1 && <small>Multiple worksheets were found. Choose the response worksheet.</small>}
            </div>
          )}
          <p>Both sources use the same ACE privacy, normalization, validation, and preview pipeline. Analysis never publishes automatically.</p>
          <button className="dataset-primary-action" type="submit" disabled={Boolean(pendingAction) || (addSource === 'google_sheet' && (!addSheet || !addSheetTab))}>{addSource === 'excel' ? <Upload size={17} /> : <RefreshCw size={17} />} {pendingAction.startsWith('analyze') ? 'Analyzing…' : addSource === 'excel' ? 'Analyze workbook' : 'Analyze Google Sheet'}</button>
        </form>
      )}
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      {message && <p className="admin-form-success" role="status"><CheckCircle2 size={16} /> {message}</p>}
      {preview?.mode === 'sync' && <SyncPreview preview={preview} onCancel={() => setPreview(null)} onApplied={(dataset) => { setPreview(null); setShowManualUpdate(false); setShowSourceEditor(false); setMessage(`${dataset.name} was updated atomically${dataset.status === 'active' ? ' and is now reflected on the public site' : ''}.`); setImageStatusVersion((value) => value + 1); router.refresh(); }} />}
      {preview && preview.mode !== 'sync' && <ImportPreview preview={preview} onSaved={(dataset) => { setPreview(null); setShowImport(false); setMessage(`${dataset.name} was saved as READY and is not live.`); setImageStatusVersion((value) => value + 1); router.refresh(); }} />}
      {imageImportResult && (
        <div className="dataset-image-import-backdrop" role="presentation">
          <section className="dataset-image-import-dialog" role="dialog" aria-modal="true" aria-labelledby="image-import-title">
            <span>{imageImportResult.mode === 'preview' ? 'Missing image preview' : 'Image import complete'}</span>
            <h3 id="image-import-title">
              {imageImportResult.mode === 'preview'
                ? `${imageImportResult.summary.readyProfiles} profile${imageImportResult.summary.readyProfiles === 1 ? '' : 's'} ready`
                : `Imported images for ${imageImportResult.summary.profilesImported} profile${imageImportResult.summary.profilesImported === 1 ? '' : 's'}`}
            </h3>
            <div className="dataset-image-import-summary">
              <article><strong>{imageImportResult.mode === 'preview' ? imageImportResult.summary.readyProfiles : imageImportResult.summary.profilesImported}</strong><span>{imageImportResult.mode === 'preview' ? 'Ready profiles' : 'Profiles imported'}</span></article>
              <article><strong>{imageImportResult.mode === 'preview' ? imageImportResult.summary.validImagesDiscovered : imageImportResult.summary.imagesUploaded}</strong><span>{imageImportResult.mode === 'preview' ? 'Valid images' : 'Images uploaded'}</span></article>
              <article><strong>{imageImportResult.summary.rejectedFiles}</strong><span>Warnings</span></article>
              <article><strong>{imageImportResult.summary.failedProfiles}</strong><span>Failures</span></article>
            </div>
            <p className="dataset-image-import-skipped">
              Scanned {imageImportResult.summary.profilesScanned} profiles · preserved {imageImportResult.summary.profilesSkippedExistingGallery} existing galler{imageImportResult.summary.profilesSkippedExistingGallery === 1 ? 'y' : 'ies'}
              {imageImportResult.mode === 'preview' ? ` · ${imageImportResult.summary.inaccessibleSources} inaccessible Drive source${imageImportResult.summary.inaccessibleSources === 1 ? '' : 's'}` : ''}
            </p>
            {imageImportResult.profiles.length > 0 && (
              <ul className="dataset-image-import-results">
                {imageImportResult.profiles.map((profile) => (
                  <li key={profile.id} className={profile.status === 'failed' ? 'is-failed' : ''}>
                    <strong>{profile.name}</strong>
                    <span>{profile.imagesReady} image{profile.imagesReady === 1 ? '' : 's'} {imageImportResult.mode === 'preview' ? 'ready' : 'imported'}{profile.rejectedFiles ? ` · ${profile.rejectedFiles} unsupported/rejected` : ''}</span>
                    {profile.dimensions.length > 0 && <small>{profile.dimensions.map((size) => `${size.width}×${size.height}`).join(' · ')}</small>}
                    {profile.status === 'failed' && <small>{profile.message}</small>}
                  </li>
                ))}
              </ul>
            )}
            {imageImportError && <p className="admin-form-error" role="alert">{imageImportError}</p>}
            <div className="dataset-image-import-actions">
              {imageImportResult.mode === 'preview' ? (
                <>
                  <button type="button" onClick={() => { setImageImportResult(null); setImageImportError(''); }} disabled={pendingAction === 'apply-images'}>Cancel</button>
                  <button className="dataset-primary-action" type="button" onClick={importMissingImages} disabled={!imageImportResult.summary.readyProfiles || pendingAction === 'apply-images'}><Images size={16} /> {pendingAction === 'apply-images' ? 'Importing…' : 'Import missing images'}</button>
                </>
              ) : <button className="dataset-primary-action" type="button" onClick={() => { setImageImportResult(null); setImageImportError(''); }}>Done</button>}
            </div>
          </section>
        </div>
      )}
      {removeTarget && (
        <div className="dataset-remove-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRemoveDialog(); }} onKeyDown={(event) => { if (event.key === 'Escape') closeRemoveDialog(); }}>
          <section className="dataset-remove-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-remove-title" aria-describedby="dataset-remove-description">
            <span>Permanent action</span>
            <h3 id="dataset-remove-title">Remove {removeTarget.name}?</h3>
            <p id="dataset-remove-description">This permanently removes {removeTarget.name}, its imported profiles, image metadata, and Storage images. This cannot be undone.</p>
            <label>Type <strong>{removeTarget.name}</strong> to confirm<input autoFocus value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} disabled={pendingAction === `remove-${removeTarget.id}`} /></label>
            {error && <p className="dataset-remove-error" role="alert">{error}</p>}
            <div>
              <button type="button" onClick={closeRemoveDialog} disabled={pendingAction === `remove-${removeTarget.id}`}>Cancel</button>
              <button className="dataset-confirm-remove" type="button" onClick={removeSemester} disabled={removeConfirmation !== removeTarget.name || pendingAction === `remove-${removeTarget.id}`}><Trash2 size={15} /> {pendingAction === `remove-${removeTarget.id}` ? 'Removing…' : `Remove ${removeTarget.name}`}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
