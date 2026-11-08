import { useState } from 'react';
import { apiRequest } from '../lib/api';
import { Notice, PasswordFields } from '../components';

function Shell({ title, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 font-sans">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md">
        <h2 className="mb-1 text-center text-2xl font-bold text-slate-800">Leave Portal</h2>
        <p className="mb-6 text-center text-sm text-slate-500">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function LoginView({ onLogin, notice, demoMode }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(notice ? { type: 'warning', message: notice } : null);

  const submitLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      onLogin(await apiRequest('/auth/login', { method: 'POST', body: { email, password } }));
    } catch (err) {
      setMessage({ type: 'error', message: err.message });
      setBusy(false);
    }
  };

  const submitForgot = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const data = await apiRequest('/auth/forgot', { method: 'POST', body: { email } });
      setMessage({ type: 'success', message: data.message });
    } catch (err) {
      setMessage({ type: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'forgot') {
    return (
      <Shell title="Reset your password">
        <form onSubmit={submitForgot} className="space-y-4">
          <Notice notice={message} />
          <div>
            <label className="label" htmlFor="email">Work email</label>
            <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Sending…' : 'Email me a reset link'}</button>
          <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-800" onClick={() => { setMode('login'); setMessage(null); }}>
            ← Back to sign in
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title="Sign in with your work email">
      <form onSubmit={submitLogin} className="space-y-4">
        <Notice notice={message} />
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-800" onClick={() => { setMode('forgot'); setMessage(null); }}>
          Forgot password?
        </button>
        {demoMode && (
          <p className="text-center text-xs text-slate-400">
            Local demo: admin@example.com, ceo@example.com, employee@example.com — password <code>password123</code>
          </p>
        )}
      </form>
    </Shell>
  );
}

export function ResetPasswordView({ token, onDone }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [done, setDone] = useState(false);

  return (
    <Shell title="Choose a new password">
      <div className="space-y-4">
        <Notice notice={message} />
        {done ? (
          <button type="button" className="btn-primary w-full" onClick={onDone}>Go to sign in</button>
        ) : (
          <PasswordFields
            requireCurrent={false}
            busy={busy}
            submitLabel="Set password"
            onSubmit={async ({ new_password }) => {
              setBusy(true);
              setMessage(null);
              try {
                const data = await apiRequest('/auth/reset', { method: 'POST', body: { token, new_password } });
                setMessage({ type: 'success', message: data.message });
                setDone(true);
                return true;
              } catch (err) {
                setMessage({ type: 'error', message: err.message });
                return false;
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </div>
    </Shell>
  );
}

export function ForcePasswordChange({ api, user, onChanged, onLogout }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  return (
    <Shell title={`Welcome, ${user.name}. Please set your own password to continue.`}>
      <div className="space-y-4">
        <Notice notice={message} />
        <PasswordFields
          busy={busy}
          submitLabel="Set password and continue"
          onSubmit={async (body) => {
            setBusy(true);
            setMessage(null);
            try {
              onChanged(await api('/auth/password', { method: 'POST', body }));
              return true;
            } catch (err) {
              setMessage({ type: 'error', message: err.message });
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
        <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-800" onClick={() => onLogout()}>Sign out</button>
      </div>
    </Shell>
  );
}

export function SetupRequired() {
  return (
    <Shell title="Almost there">
      <Notice notice={{ type: 'warning', message: 'The database is not connected yet. In Vercel, open Storage, connect a Postgres (Neon) database to this project, run the setup SQL, then redeploy.' }} />
    </Shell>
  );
}
