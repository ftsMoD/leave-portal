import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, createApi, loadSession, saveSession } from './lib/api';
import { ChangePasswordDialog, Notice } from './components';
import EmployeeView from './views/EmployeeView';
import ManagerView from './views/ManagerView';

function LoginView({ onLogin, demoMode, notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice || '');

  const handleLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      onLogin(data);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 font-sans">
      <form onSubmit={handleLogin} className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md">
        <h2 className="mb-6 text-center text-2xl font-bold text-slate-800">Leave Portal</h2>
        {error && <div className="mb-4"><Notice notice={{ type: 'error', message: error }} /></div>}
        <div className="mb-4">
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </div>
        <div className="mb-6">
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {demoMode && (
          <div className="mt-4 text-center text-xs text-slate-400">
            Demo accounts (password <code>password123</code>):<br />
            employee@company.com · manager@company.com
          </div>
        )}
      </form>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [storage, setStorage] = useState(null);
  const [tab, setTab] = useState(session?.user?.role === 'manager' ? 'approvals' : 'mine');
  const [pendingCount, setPendingCount] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState('');
  const closePassword = useCallback(() => setShowPassword(false), []);

  useEffect(() => {
    apiRequest('/health').then((d) => setStorage(d.storage)).catch(() => setStorage(null));
  }, []);

  const handleLogout = useCallback((reason) => {
    saveSession(null);
    setSession(null);
    setPendingCount(0);
    setShowPassword(false);
    setLogoutNotice(typeof reason === 'string' ? reason : '');
  }, []);

  const api = useMemo(() => createApi(session?.token, handleLogout), [session?.token, handleLogout]);

  // Validate a stored session on load (expired tokens, disabled accounts, role changes).
  useEffect(() => {
    if (!session?.token) return;
    api('/auth/me')
      .then(({ user }) => {
        if (user.role !== session.user.role || user.name !== session.user.name) {
          const next = { ...session, user };
          saveSession(next);
          setSession(next);
        }
      })
      .catch(() => { /* 401 handled by createApi */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const handleLogin = ({ token, user }) => {
    const next = { token, user };
    saveSession(next);
    setSession(next);
    setLogoutNotice('');
    setTab(user.role === 'manager' ? 'approvals' : 'mine');
  };

  if (!session?.token) {
    return <LoginView key={logoutNotice} onLogin={handleLogin} demoMode={storage === 'memory'} notice={logoutNotice} />;
  }

  const { user } = session;
  const isManager = user.role === 'manager';

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {storage === 'memory' && (
        <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">
          Demo mode — data is held in memory and resets when the server restarts. Set <code>DATABASE_URL</code> to persist.
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-4 shadow sm:px-6">
        <h1 className="text-xl font-bold text-slate-800">Leave Portal</h1>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-600">
            <b>{user.name}</b> <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs capitalize text-slate-500">{user.role}</span>
          </span>
          <button type="button" onClick={() => setShowPassword(true)} className="text-sm text-slate-500 hover:text-slate-800">Change password</button>
          <button type="button" onClick={() => handleLogout()} className="rounded bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600">Logout</button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        {isManager && (
          <nav className="mb-6 flex gap-1 border-b border-slate-200" role="tablist">
            {[
              { id: 'approvals', label: 'Approvals', badge: pendingCount },
              { id: 'mine', label: 'My leave' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                {t.label}
                {t.badge > 0 && <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">{t.badge}</span>}
              </button>
            ))}
          </nav>
        )}

        {isManager && tab === 'approvals'
          ? <ManagerView api={api} currentUserId={user.id} onPendingCount={setPendingCount} />
          : <EmployeeView api={api} />}
      </main>

      {showPassword && <ChangePasswordDialog api={api} onClose={closePassword} />}
    </div>
  );
}
