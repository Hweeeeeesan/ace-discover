'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const CATEGORY_LABELS = Object.freeze({
  incomplete: 'Incomplete',
  organization_representation: 'Organization representation',
  public_appropriateness: 'Public appropriateness',
  pii: 'PII',
  formatting: 'Formatting',
  other_quality: 'Other quality concerns',
});

async function requestQa(method, body) {
  const response = await fetch('/api/admin/datasets/profile-qa', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The public response QA request failed.');
  return payload;
}

function resolutionLabel(issue) {
  if (issue.resolution === 'allowed_as_is') return 'Resolved · Allowed as-is';
  if (issue.resolution === 'override_active') return 'Resolved · Public override active';
  if (issue.resolution === 'hidden') return 'Resolved · Hidden publicly';
  return issue.severity === 'block' ? 'Blocked pending action' : 'Needs review';
}

function QaIssueActions({ datasetId, profile, issue, persistenceAvailable, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');

  async function act(action, extra = {}) {
    setPending(action);
    setError('');
    try {
      await requestQa('PATCH', {
        datasetId,
        profileId: profile.id,
        field: issue.field,
        rule: issue.rule,
        sourceHash: issue.sourceHash,
        action,
        ...extra,
      });
      setEditing(false);
      await onChanged();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setPending('');
    }
  }

  if (issue.resolution === 'allowed_as_is') {
    return (
      <div className="profile-qa-issue-actions">
        <div>
          <button type="button" onClick={() => act('reopen')} disabled={Boolean(pending) || !persistenceAvailable}>{pending === 'reopen' ? 'Reopening…' : 'Reopen review'}</button>
          <Link href={`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profile.id)}#admin-profile-editor-title`}>Open full profile</Link>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }
  if (issue.resolution !== 'unresolved') {
    return <div className="profile-qa-issue-actions"><div><Link href={`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profile.id)}#admin-profile-editor-title`}>Open full profile</Link></div></div>;
  }
  return (
    <div className="profile-qa-issue-actions">
      <div>
        {issue.severity !== 'block' && (
          <button type="button" onClick={() => act('allow')} disabled={Boolean(pending) || !persistenceAvailable}>{pending === 'allow' ? 'Allowing…' : 'Allow as-is'}</button>
        )}
        <button type="button" onClick={() => { setError(''); setEditing((current) => !current); }} disabled={Boolean(pending)}>Edit public version</button>
        <button type="button" onClick={() => { if (window.confirm(`Hide ${issue.fieldLabel} from the public profile? The imported response will be preserved.`)) act('hide'); }} disabled={Boolean(pending)}>Hide field</button>
        <Link href={`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profile.id)}#admin-profile-editor-title`}>Open full profile</Link>
      </div>
      {editing && (
        <form onSubmit={(event) => { event.preventDefault(); act('edit', { value }); }}>
          <label>
            Safe public replacement
            <textarea value={value} onChange={(event) => setValue(event.target.value)} rows="4" required />
          </label>
          <small>Write the public version manually. The imported source response will not be changed.</small>
          <div><button type="button" onClick={() => setEditing(false)} disabled={Boolean(pending)}>Cancel</button><button type="submit" disabled={Boolean(pending)}>{pending === 'edit' ? 'Saving…' : 'Save public override'}</button></div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export default function AdminProfileQa({ datasetId }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('needs_review');

  async function loadQa() {
    setLoading(true);
    setError('');
    try {
      setReport(await requestQa('POST', { datasetId }));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    requestQa('POST', { datasetId })
      .then((result) => { if (!cancelled) setReport(result); })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [datasetId]);

  const visibleProfiles = useMemo(() => (report?.profiles || []).map((profile) => ({
    ...profile,
    visibleIssues: profile.issues.filter((issue) => (
      (category === 'all' || issue.category === category)
      && (
        status === 'all'
        || (status === 'needs_review' && issue.resolution === 'unresolved' && issue.severity === 'review')
        || (status === 'blocked' && issue.resolution === 'unresolved' && issue.severity === 'block')
        || (status === 'resolved' && issue.resolution !== 'unresolved')
      )
    )),
  })).filter((profile) => profile.visibleIssues.length), [category, report, status]);

  const summary = report?.summary;
  return (
    <section className="admin-section profile-qa" aria-labelledby="profile-qa-title">
      <div className="admin-section-title profile-qa-heading">
        <div><span>Content QA</span><h2 id="profile-qa-title">Public response QA</h2><p>Deterministic review signals only. Admin makes the final public-content decision.</p></div>
        <button type="button" onClick={loadQa} disabled={loading}>{loading ? 'Checking…' : 'Re-check responses'}</button>
      </div>
      <div className="profile-qa-summary" aria-live="polite">
        <article><strong>{summary?.totalProfiles ?? '—'}</strong><span>Profiles</span></article>
        <article className="is-clear"><strong>{summary?.clearProfiles ?? '—'}</strong><span>Clear</span></article>
        <article className="is-review"><strong>{summary?.reviewProfiles ?? '—'}</strong><span>Need review</span></article>
        <article className="is-resolved"><strong>{summary?.resolvedProfiles ?? '—'}</strong><span>Resolved</span></article>
        <article className="is-block"><strong>{summary?.blockedProfiles ?? '—'}</strong><span>Blocked</span></article>
      </div>
      {summary && <p className="profile-qa-resolution-summary">Issues: {summary.unresolvedReviewIssues} need review · {summary.allowedAsIsIssues} allowed as-is · {summary.overrideProtectedIssues} protected by override · {summary.hiddenIssues} hidden · {summary.blockedIssues} blocked</p>}
      <div className="profile-qa-toolbar">
        <label>Filter status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="needs_review">Needs review</option><option value="resolved">Resolved</option><option value="blocked">Blocked</option><option value="all">All statuses</option></select></label>
        <label>Filter category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
      {!report?.dispositionPersistenceAvailable && report && <p className="profile-qa-migration-note">Allow/Reopen decisions are read-only until the profile content QA migration is applied. Edit and Hide continue to use existing public overrides.</p>}
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      {!loading && report && visibleProfiles.length === 0 && <p className="profile-qa-empty">No responses match this review filter.</p>}
      <div className="profile-qa-queue">
        {visibleProfiles.map((profile) => (
          <article className={`profile-qa-profile status-${profile.status}`} key={profile.id}>
            <header><div><strong>{profile.name}</strong><span>{profile.role}</span></div><b>{profile.unresolvedIssueCount} unresolved</b></header>
            {profile.visibleIssues.map((issue) => (
              <section className={`profile-qa-issue resolution-${issue.resolution}`} key={`${issue.field}-${issue.rule}-${issue.sourceHash}`}>
                <div className="profile-qa-issue-title"><div><span>{issue.fieldLabel}</span><strong>{CATEGORY_LABELS[issue.category]}</strong></div><b>{resolutionLabel(issue)}</b></div>
                <blockquote>{issue.sourcePreview}</blockquote>
                <p>{issue.reason}</p>
                {issue.resolution === 'override_active' && <div className="profile-qa-public-state"><strong>Public</strong><span>✓ Admin override active</span><p>{issue.effectivePreview}</p></div>}
                {issue.resolution === 'hidden' && <div className="profile-qa-public-state"><strong>Public</strong><span>✓ Field hidden</span></div>}
                <QaIssueActions datasetId={datasetId} profile={profile} issue={issue} persistenceAvailable={report.dispositionPersistenceAvailable} onChanged={loadQa} />
              </section>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
