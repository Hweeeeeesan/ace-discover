'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAJOR_GROUP_ORDER, normalizeMajorGroup } from '../lib/import/major-group';

const TEXT_FIELDS = [
  ['name', 'Name', 'input'], ['pronouns', 'Pronouns', 'input'], ['year', 'Year', 'input'],
  ['major', 'Major', 'input'], ['instagram', 'Instagram', 'input'], ['hobbies', 'Hobbies', 'textarea'],
  ['hobbyDetails', 'Hobby details', 'textarea'], ['music', 'Music', 'textarea'],
  ['movies', 'Movies & shows', 'textarea'], ['uniqueThings', 'Things that make me, me', 'textarea'],
  ['tagline', 'Personality phrase', 'textarea'], ['passion', 'I could talk about this for hours', 'textarea'],
  ['perfectDay', 'Perfect day', 'textarea'], ['idealHangout', 'Ideal hangout', 'textarea'],
  ['bucketList', 'Bucket list', 'textarea'], ['hotTake', 'Harmless hot take', 'textarea'],
  ['bio', 'Public story', 'textarea'], ['aceTraitSlideUrl', 'Personal ACE Trait slide URL', 'input'],
];

const VIBE_ORDER = [
  'Foodie', 'Outdoors', 'Gaming', 'Music', 'Creative', 'Fitness', 'Sports', 'Travel',
  'Movies & TV', 'Anime', 'Nightlife', 'Coffee & Cafes', 'Studying', 'Fashion',
  'Photography', 'Volunteering',
];

function initialValues(profile) {
  return Object.fromEntries([
    ...TEXT_FIELDS.map(([field]) => [field, profile?.[field] || '']),
    ['majorGroup', profile?.majorGroup || normalizeMajorGroup(profile?.major)],
    ['vibes', Array.isArray(profile?.vibes) ? profile.vibes : []],
  ]);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function AdminProfileEditor({
  datasetId, datasetSlug, profileId, profile, importedPublicData, publicOverrides = {},
  publicOverridesUpdatedAt = null, publicHidden = false, vibeReasoning = [], vibeThreshold = 5,
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() => initialValues(profile));
  const [pending, setPending] = useState(false);
  const [hidden, setHidden] = useState(publicHidden === true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const overrideCount = Object.keys(publicOverrides || {}).length;
  const changedUnderOverride = Object.keys(publicOverrides || {}).filter((field) => !sameValue(importedPublicData?.[field], profile?.[field]));

  function update(field, value) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function reset(field) {
    update(field, field === 'vibes'
      ? (Array.isArray(importedPublicData?.[field]) ? importedPublicData[field] : [])
      : field === 'majorGroup'
        ? normalizeMajorGroup(importedPublicData?.major)
      : (importedPublicData?.[field] || ''));
  }

  function toggleVibe(vibe) {
    setValues((current) => ({
      ...current,
      vibes: current.vibes.includes(vibe)
        ? current.vibes.filter((item) => item !== vibe)
        : current.vibes.length >= 5 ? current.vibes : [...current.vibes, vibe],
    }));
  }

  function cancel() {
    setValues(initialValues(profile));
    setError('');
    setMessage('');
    setEditing(false);
  }

  async function save(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/datasets/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, datasetSlug, profileId, expectedUpdatedAt: publicOverridesUpdatedAt, values }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Profile changes could not be saved.');
      setMessage('Public profile changes saved.');
      setEditing(false);
      router.refresh();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending(false);
    }
  }

  async function setVisibility(nextHidden) {
    const action = nextHidden ? 'hide this profile from every public surface' : 'restore this profile to public surfaces';
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;
    setPending(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/datasets/profile-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, profileId, hidden: nextHidden }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Profile visibility could not be changed.');
      setHidden(payload.publicHidden === true);
      setMessage(payload.publicHidden ? 'Profile hidden from public surfaces.' : 'Profile restored to public surfaces.');
      router.refresh();
    } catch (visibilityError) {
      setError(visibilityError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="admin-profile-editor" aria-labelledby="admin-profile-editor-title">
      <div className="admin-profile-editor-heading">
        <div><p className="eyebrow dark">Admin-only</p><h2 id="admin-profile-editor-title">Public profile</h2></div>
        <div className="admin-profile-editor-status">
          <span className={hidden ? 'admin-profile-visibility-hidden' : 'admin-profile-visibility-public'}>
            {hidden ? 'Hidden from public' : 'Public'}
          </span>
          {overrideCount > 0 && <span>{overrideCount} public field{overrideCount === 1 ? '' : 's'} overridden</span>}
          {publicOverridesUpdatedAt && <span>Last edited {new Date(publicOverridesUpdatedAt).toLocaleString()}</span>}
          {!editing && <button type="button" onClick={() => { setMessage(''); setError(''); setEditing(true); }}>Edit profile</button>}
          <button type="button" onClick={() => setVisibility(!hidden)} disabled={pending}>
            {hidden ? 'Restore to public' : 'Hide from public'}
          </button>
        </div>
      </div>
      {message && <p className="admin-form-success" role="status">{message}</p>}
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      {editing ? (
        <form className="admin-profile-editor-form" onSubmit={save}>
          <fieldset className="admin-profile-major-group">
            <legend>Major Category</legend>
            <p>Raw major: <strong>{importedPublicData?.major || '—'}</strong></p>
            <p>Auto category: <strong>{normalizeMajorGroup(importedPublicData?.major)}</strong></p>
            <label>
              <span>Effective category</span>
              <select value={values.majorGroup} onChange={(event) => update('majorGroup', event.target.value)}>
                {MAJOR_GROUP_ORDER.map((category) => <option value={category} key={category}>{category}</option>)}
              </select>
            </label>
            {publicOverrides.majorGroup !== undefined && <small className="admin-profile-source-change">Manual category override active.</small>}
            <button type="button" className="admin-profile-reset" onClick={() => reset('majorGroup')} disabled={sameValue(values.majorGroup, normalizeMajorGroup(importedPublicData?.major))}>Reset to automatic</button>
          </fieldset>
          {TEXT_FIELDS.map(([field, label, type]) => (
            <label key={field}>
              <span>{label}</span>
              {type === 'textarea'
                ? <textarea value={values[field]} onChange={(event) => update(field, event.target.value)} rows={field === 'bio' ? 6 : 3} />
                : <input type={field === 'aceTraitSlideUrl' ? 'url' : 'text'} value={values[field]} onChange={(event) => update(field, event.target.value)} />}
              {publicOverrides[field] !== undefined && changedUnderOverride.includes(field) && <small className="admin-profile-source-change">Imported source: {String(importedPublicData?.[field] || '')}</small>}
              <button type="button" className="admin-profile-reset" onClick={() => reset(field)} disabled={sameValue(values[field], importedPublicData?.[field] || '')}>Reset to imported</button>
            </label>
          ))}
          <fieldset className="admin-profile-vibes">
            <legend>Vibes <small>{values.vibes.length}/5</small></legend>
            <div>{VIBE_ORDER.map((vibe) => <button className={values.vibes.includes(vibe) ? 'is-selected' : ''} type="button" key={vibe} onClick={() => toggleVibe(vibe)}>{vibe}</button>)}</div>
            <button type="button" className="admin-profile-reset" onClick={() => reset('vibes')} disabled={sameValue(values.vibes, importedPublicData?.vibes || [])}>Reset to automatic</button>
          </fieldset>
          <div className="admin-profile-editor-actions"><button type="button" onClick={cancel} disabled={pending}>Cancel</button><button className="dataset-primary-action" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button></div>
        </form>
      ) : (
        <div className="admin-profile-vibe-reasoning">
          <section className="admin-profile-major-summary" aria-label="Major category">
            <h3>Major Category</h3>
            <p>Raw major: <strong>{importedPublicData?.major || '—'}</strong></p>
            <p>Auto category: <strong>{normalizeMajorGroup(importedPublicData?.major)}</strong></p>
            <p>Effective category: <strong>{profile?.majorGroup || normalizeMajorGroup(importedPublicData?.major)}</strong>{publicOverrides.majorGroup !== undefined && ' · Manual category'}</p>
          </section>
          <p>Imported values remain the source snapshot. Overrides are layered on top and survive future Sheet or Excel updates.</p>
          <h3>Automatic vibe reasoning</h3>
          {!vibeReasoning.length && <p>No automatic vibe evidence matched.</p>}
          {vibeReasoning.map((item) => (
            <article key={item.vibe}>
              <div><strong>{item.vibe}</strong><span>{item.score} · {item.score >= vibeThreshold ? 'Assigned' : 'Below threshold'}</span></div>
              <ul>{item.evidence.map((evidence, index) => <li key={`${item.vibe}-${index}`}>{evidence.field} — “{evidence.phrase}” · {evidence.strength} evidence, +{evidence.points}</li>)}</ul>
            </article>
          ))}
          {overrideCount > 0 && <p className="admin-profile-editor-note">Manual override active. Reset individual fields to restore imported values; reset Vibes to automatic.</p>}
        </div>
      )}
    </section>
  );
}
