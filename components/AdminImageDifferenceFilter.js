'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import AdminProfileLink from './AdminProfileLink';
import { adminProfileListScrollKey, safeAdminProfileListReturn } from '../lib/admin/profile-navigation';

const STATUS_LABELS = {
  new_in_drive: 'New images available',
  missing_from_drive: 'Missing from Drive',
  count_mismatch: 'Image count differs',
  legacy_review: 'Legacy image review',
  source_error: 'Drive source issue',
  up_to_date: 'Up to date',
};

function statusLabel(status) { return STATUS_LABELS[status] || 'Review required'; }

function detail(profile) {
  if (profile.status === 'new_in_drive') return `${profile.newCount} new image${profile.newCount === 1 ? '' : 's'}`;
  if (profile.status === 'missing_from_drive') {
    const missing = `${profile.missingCount} missing from Drive · preserved in ACE`;
    return profile.newCount ? `${missing} · ${profile.newCount} new candidate${profile.newCount === 1 ? '' : 's'}` : missing;
  }
  if (profile.status === 'count_mismatch') return 'Inventory differs · exact identity review required';
  if (profile.status === 'legacy_review') return 'Existing gallery predates provenance tracking';
  return profile.message || 'Drive source could not be compared';
}

function formatTimestamp(value) {
  if (!value) return 'Not checked in this session';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Checked at an unknown time' : `Last checked ${date.toLocaleString()}`;
}

export default function AdminImageDifferenceFilter({ datasetId, maintenance = false }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState(() => String(searchParams.get('imageIssue') || 'differences'));
  const [query, setQuery] = useState(() => String(searchParams.get('imageSearch') || '').slice(0, 120));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cacheKey = `ace-admin-image-difference-scan:${datasetId}`;
  const returnParams = new URLSearchParams(searchParams.toString());
  if (filter && filter !== 'differences') returnParams.set('imageIssue', filter);
  else returnParams.delete('imageIssue');
  if (query.trim()) returnParams.set('imageSearch', query.slice(0, 120));
  else returnParams.delete('imageSearch');
  const currentReturnTo = safeAdminProfileListReturn(
    `${pathname}${returnParams.toString() ? `?${returnParams}` : ''}`,
    datasetId,
  );

  useEffect(() => {
    try {
      const cached = JSON.parse(window.sessionStorage.getItem(cacheKey) || 'null');
      if (cached?.dataset?.id === datasetId) setReport(cached);
    } catch {
      // Session caching is optional; a fresh scan remains available.
    }
  }, [cacheKey, datasetId]);

  useEffect(() => {
    const stored = Number(window.sessionStorage.getItem(adminProfileListScrollKey(currentReturnTo, datasetId)));
    if (!Number.isFinite(stored) || stored < 0) return undefined;
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: stored, behavior: 'auto' }));
    return () => window.cancelAnimationFrame(frame);
  }, [currentReturnTo, datasetId]);

  function updateUrl(nextFilter, nextQuery) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFilter && nextFilter !== 'differences') params.set('imageIssue', nextFilter);
    else params.delete('imageIssue');
    if (nextQuery.trim()) params.set('imageSearch', nextQuery.slice(0, 120));
    else params.delete('imageSearch');
    window.history.replaceState(null, '', `${pathname}${params.toString() ? `?${params}` : ''}`);
  }

  async function scan() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/datasets/images/reconcile/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Drive image difference scan failed.');
      setReport(data);
      try { window.sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* optional cache */ }
    } catch (scanError) {
      setError(scanError.message || 'Drive image difference scan failed.');
    } finally {
      setLoading(false);
    }
  }

  function chooseFilter(value) {
    setFilter(value);
    updateUrl(value, query);
  }

  function changeQuery(value) {
    setQuery(value);
    updateUrl(filter, value);
  }

  const rows = useMemo(() => {
    if (!report) return [];
    const term = query.trim().toLowerCase();
    return report.profiles.filter((profile) => {
      if (term && !`${profile.name} ${profile.profileId}`.toLowerCase().includes(term)) return false;
      if (filter === 'all') return true;
      if (filter === 'differences') return profile.difference;
      if (filter === 'new') return profile.status === 'new_in_drive';
      if (filter === 'missing') return profile.status === 'missing_from_drive';
      if (filter === 'count') return profile.status === 'count_mismatch';
      if (filter === 'legacy') return profile.status === 'legacy_review';
      if (filter === 'source') return profile.status === 'source_error';
      if (filter === 'up-to-date') return profile.status === 'up_to_date';
      return false;
    });
  }, [filter, query, report]);

  const summary = report?.summary;
  const issueCards = summary ? [
    { key: 'differences', title: 'Image differences', count: summary.differences, description: 'Current Drive contents differ from ACE', detail: `${summary.newInDrive} new · ${summary.missingFromDrive} missing · ${summary.countMismatch} count mismatch` },
    { key: 'legacy', title: 'Legacy image review', count: summary.legacyReview, description: 'Historical galleries need source identity review', detail: 'Not confirmed differences' },
    { key: 'source', title: 'Drive source issues', count: summary.sourceErrors, description: 'Some image sources could not be verified', detail: 'Review required' },
  ] : [];

  return (
    <section className={`admin-image-difference${maintenance ? ' admin-image-maintenance' : ''}`} aria-labelledby="admin-image-difference-title">
      <div className="admin-image-difference-header">
        <div className="admin-section-title"><span>{maintenance ? 'Maintenance · Actionable profile issues' : 'Drive provenance review'}</span><h2 id="admin-image-difference-title">Image differences</h2></div>
        <button type="button" className="admin-image-difference-button" onClick={scan} disabled={loading}>{loading ? 'Checking Drive…' : 'Check image differences'}</button>
      </div>
      {report ? <p className="admin-image-difference-last-checked" aria-live="polite">{formatTimestamp(report.scannedAt)} · {summary.differences} actionable difference{summary.differences === 1 ? '' : 's'} · {summary.reviewRequired} profiles requiring review</p> : <p className="admin-image-difference-last-checked">No scan result yet. Checking Drive is read-only and does not import or modify images.</p>}
      {maintenance && summary && <div className="admin-image-issue-cards">{issueCards.map((card) => <button type="button" className="admin-image-issue-card" key={card.key} onClick={() => chooseFilter(card.key)}><span><strong>{card.title}</strong><small>{card.description}</small></span><b>{card.count}</b><em>{card.detail}</em><u>Review</u></button>)}</div>}
      {error && <p className="admin-image-difference-error" role="alert">{error}</p>}
      {report && <>
        <div className="admin-image-difference-controls"><label htmlFor={`${maintenance ? 'maintenance' : 'preview'}-image-difference-filter`}>Show</label><select id={`${maintenance ? 'maintenance' : 'preview'}-image-difference-filter`} className="admin-profile-search-input" value={filter} onChange={(event) => chooseFilter(event.target.value)}>
          {maintenance ? <><option value="differences">All differences ({summary.differences})</option><option value="new">New images ({summary.newInDrive})</option><option value="missing">Missing from Drive ({summary.missingFromDrive})</option><option value="count">Count mismatch ({summary.countMismatch})</option><option value="legacy">Legacy review ({summary.legacyReview})</option><option value="source">Source issues ({summary.sourceErrors})</option><option value="up-to-date">Up to date ({summary.upToDate})</option></> : <><option value="all">All ({summary.driveBacked})</option><option value="differences">Image differences ({summary.differences})</option><option value="legacy">Legacy review ({summary.legacyReview})</option><option value="source">Source issues ({summary.sourceErrors})</option><option value="up-to-date">Up to date ({summary.upToDate})</option></>}
        </select></div>
        <label className="admin-image-difference-search" htmlFor={`${maintenance ? 'maintenance' : 'preview'}-image-difference-search`}>Search profiles<input id={`${maintenance ? 'maintenance' : 'preview'}-image-difference-search`} className="admin-profile-search-input" type="search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="Name or profile ID" /></label>
        <p className="admin-profile-search-count" aria-live="polite">Showing {rows.length} profile{rows.length === 1 ? '' : 's'}</p>
        {rows.length > 0 ? <div className="admin-image-difference-list">{rows.map((profile) => <article className="admin-image-difference-row" key={profile.profileId}><div><strong>{profile.name}</strong><span>ACE gallery: {profile.existingCount} · Drive images: {profile.supportedCount ?? ' unavailable'}</span><small>{statusLabel(profile.status)} · {detail(profile)}</small></div>{profile.reviewRequired && <AdminProfileLink datasetId={datasetId} profileId={profile.profileId} returnTo={currentReturnTo} className="admin-image-difference-review">Review images</AdminProfileLink>}</article>)}</div> : <p className="admin-image-difference-empty">No profiles match this status.</p>}
      </>}
    </section>
  );
}
