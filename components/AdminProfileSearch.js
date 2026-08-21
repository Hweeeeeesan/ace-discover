'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export default function AdminProfileSearch({ datasetId, profiles = [] }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!normalizedQuery) return profiles;
    return profiles.filter((profile) => [profile.name, profile.id, profile.major, profile.role]
      .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)));
  }, [normalizedQuery, profiles]);

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
      <p className="admin-profile-search-count" aria-live="polite">
        {normalizedQuery ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : `${profiles.length} profiles`}
      </p>
      {matches.length > 0 ? (
        <div className="admin-profile-search-results">
          {matches.map((profile) => (
            <Link href={`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profile.id)}`} key={profile.id}>
              <strong>{profile.name}</strong>
              <span>{[profile.role, profile.major, profile.id].filter(Boolean).join(' · ')}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="admin-profile-search-empty">No profiles match “{query.trim()}”.</p>
      )}
    </section>
  );
}
