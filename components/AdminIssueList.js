'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export default function AdminIssueList({ title, description, profiles }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return profiles;
    return profiles.filter((profile) => `${profile.name} ${profile.role} ${profile.program} ${profile.id}`.toLowerCase().includes(term));
  }, [profiles, query]);
  return (
    <details className="admin-issue">
      <summary><span><strong>{title}</strong><small>{description}</small></span><b>{profiles.length}</b></summary>
      <div className="admin-issue-body">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name, role, program, or ID" aria-label={`Filter ${title}`} />
        <div className="admin-issue-list">
          {filtered.map((profile) => (
            <Link href={`/profile/${profile.id}`} key={profile.id}>
              <strong>{profile.name}</strong><span>{profile.role}{profile.program ? ` · ${profile.program}` : ''} · {profile.id}</span>
            </Link>
          ))}
          {!filtered.length && <p>No matching profiles.</p>}
        </div>
      </div>
    </details>
  );
}
