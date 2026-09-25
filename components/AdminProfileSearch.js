'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export default function AdminProfileSearch({ datasetId, profiles = [] }) {
  const [query, setQuery] = useState('');
  const [majorGroup, setMajorGroup] = useState('all');
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    return profiles.filter((profile) => {
      const matchesQuery = !normalizedQuery || [profile.name, profile.id, profile.major, profile.role]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
      return matchesQuery && (majorGroup === 'all' || profile.effectiveMajorGroup === majorGroup);
    });
  }, [majorGroup, normalizedQuery, profiles]);

  return (
    <section className="admin-profile-search" aria-labelledby="admin-profile-search-title">
      <div className="admin-section-title"><span>Direct navigation</span><h2 id="admin-profile-search-title">Find a profile</h2></div>
      <label className="admin-profile-search-label" htmlFor="admin-profile-search-input">Search name, profile ID, major, or role</label>
      <input
        id="admin-profile-search-input"
        className="admin-profile-search-input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="e.g. Jay Nguyen, nursing, Little"
        autoComplete="off"
      />
      <label className="admin-profile-search-label" htmlFor="admin-major-group-filter">Major category</label>
      <select id="admin-major-group-filter" className="admin-profile-search-input" value={majorGroup} onChange={(event) => setMajorGroup(event.target.value)}>
        <option value="all">All categories</option>
        <option value="Other / Undeclared">Other / Undeclared review</option>
        {[...new Set(profiles.map((profile) => profile.effectiveMajorGroup).filter(Boolean))]
          .filter((value) => value !== 'Other / Undeclared')
          .sort()
          .map((value) => <option value={value} key={value}>{value}</option>)}
      </select>
      <p className="admin-profile-search-count" aria-live="polite">
        {normalizedQuery || majorGroup !== 'all' ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : `${profiles.length} profiles`}
      </p>
      {matches.length > 0 ? (
        <div className="admin-profile-search-results">
          {matches.map((profile) => (
            <Link href={`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profile.id)}`} key={profile.id}>
              <strong>{profile.name}</strong>
              <span>{[profile.role, profile.major, profile.effectiveMajorGroup, profile.id].filter(Boolean).join(' · ')}</span>
              {profile.hasMajorGroupOverride && <small>Manual category: {profile.effectiveMajorGroup}</small>}
            </Link>
          ))}
        </div>
      ) : (
        <p className="admin-profile-search-empty">No profiles match “{query.trim()}”.</p>
      )}
    </section>
  );
}
