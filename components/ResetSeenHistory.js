'use client';

import { useState } from 'react';
import { readSeenIds, resetSeenIds, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';

export default function ResetSeenHistory({ datasetSlug = 'fall-2025', datasetName = 'Fall 2025' }) {
  const [message, setMessage] = useState('');
  function reset() {
    const count = readSeenIds(datasetSlug).length;
    resetSeenIds(datasetSlug);
    window.dispatchEvent(new Event(SEEN_CHANGE_EVENT));
    setMessage(count ? `Cleared ${count} seen profile${count === 1 ? '' : 's'}.` : 'Seen history is already empty.');
  }
  return (
    <div className="admin-reset-card">
      <div><h2>{datasetName} seen history</h2><p>Seen history is stored only in this browser and isolated by semester. Resetting it does not change profile data or affect other devices.</p></div>
      <button type="button" onClick={reset}>Reset my seen history</button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
