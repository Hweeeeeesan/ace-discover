'use client';

import { useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

export function AdminLogin({ configured = true }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function signIn() {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setError('Supabase Auth is not configured for this environment.');
      return;
    }
    setPending(true);
    setError('');
    const redirectTo = `${window.location.origin}/auth/callback?next=/admin`;
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, queryParams: { prompt: 'select_account' } },
    });
    if (authError) {
      setError('Google sign-in could not be started. Please try again.');
      setPending(false);
    }
  }

  return (
    <button className="admin-auth-button" type="button" onClick={signIn} disabled={pending || !configured}>
      <LogIn size={18} /> {pending ? 'Opening Google…' : 'Continue with Google'}
      {error && <span role="alert">{error}</span>}
    </button>
  );
}

export function AdminSignOut() {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    const supabase = createSupabaseBrowserClient();
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/admin');
  }

  return (
    <button className="admin-signout-button" type="button" onClick={signOut} disabled={pending}>
      <LogOut size={16} /> {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
