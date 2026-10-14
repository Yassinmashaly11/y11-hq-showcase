import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { User } from '../App';

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<{ ceo: { username: string; password: string }; associate: { username: string; password: string } } | null>(null);
  useEffect(() => { api.get<any>('/config').then((c) => setDemo(c.demoLogins)).catch(() => {}); }, []);

  async function login(u: string, p: string) {
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.post<User>('/auth/login', { username: u, password: p }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.post<User>('/auth/login', { username, password }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-art">
        <span className="crest">Y11</span>
        <h1>Football isn't just watched. It's sold.</h1>
        <span className="small" style={{ color: '#8f8d87' }}>Y11 HQ · Team portal</span>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <h2>Log in</h2>
          <label>Username<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <button disabled={busy || !username || !password}>{busy ? 'Logging in…' : 'Log in'}</button>
          {demo && (
            <div className="panel" style={{ marginTop: 8 }}>
              <h3>Recruiter demo</h3>
              <p className="small muted">Fake data. Click anything; it resets every night.</p>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => login(demo.ceo.username, demo.ceo.password)}>Try the CEO view</button>
                <button type="button" className="secondary" onClick={() => login(demo.associate.username, demo.associate.password)}>Try the associate view</button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
