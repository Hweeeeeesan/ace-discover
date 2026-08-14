'use client';

import { useState } from 'react';
import { readSeenIds, resetSeenIds, SEEN_CHANGE_EVENT } from '../lib/seen-profiles';

export default function ResetSeenHistory() {
  const [message, setMessage] = useState('');
  function reset() {
    const count = readSeenIds().length;
    resetSeenIds();
    window.dispatchEvent(new Event(SEEN_CHANGE_EVENT));
    setMessage(count ? `Cleared ${count} seen profile${count === 1 ? '' : 's'}.` : 'Seen history is already empty.');
  }
  return (
    <div className="admin-reset-card">
      <div><h2>Seen history</h2><p>Seen history is stored only in this browser. Resetting it does not change profile data or affect other devices.</p></div>
      <button type="button" onClick={reset}>Reset my seen history</button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
