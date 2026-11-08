import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, createApi, loadSession, saveSession } from './lib/api';
import { Modal, Notice, PasswordFields, ROLE_LABELS } from './components';
import { ForcePasswordChange, LoginView, ResetPasswordView, SetupRequired } from './views/AuthViews';
import MyLeave from './views/MyLeave';
import Approvals from './views/Approvals';
import MyTeam from './views/MyTeam';
import Reports from './views/Reports';
import Staff from './views/Staff';

const TABS = {
  user: ['mine'],
  approver: ['approvals', 'team', 'mine'],
  admin: ['approvals', 'reports', 'staff', 'mine'],
};
const TAB_LABELS = { approvals: 'Approvals', team: 'My team', reports: 'Reports', staff: 'Staff', mine: 'My leave' };

// Deep links from emails: ?view=approvals&request=12, ?view=mine, ?reset=<token>
function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return { view: p.get('view'), request: Number(p.get('request')) || null, reset: p.get('reset') };
}
const clearUrl = () => window.history.replaceState(null, '', window.location.pathname);

function ChangePasswordModal({ api, onChanged, onClose }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  return (
    <Modal title="Change password" onClose={onClose}>
      <div className="space-y-3">
        <Notice notice={notice} />
        <PasswordFields
          busy={busy}
          onSubmit={async (body) => {
            setBusy(true);
            try {
              onChanged(await api('/auth/password', { method: 'POST', body }));
              setNotice({ type: 'success', message: 'Password updated.' });
              return true;
            } catch (err) {
              setNotice({ type: 'error', message: err.message });
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    </Modal>
  );
}

export default function App() {
  const [link] = useState(readUrl);
  const [resetToken, setResetToken] = useState(link.reset);
  const [session, setSession] = useState(loadSession);
  const [health, setHealth] = useState(null);
  const [tab, setTab] = useState(null);
  const [highlightId, setHighlightId] = useState(link.request);
  const [pendingCount, setPendingCount] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState('');

  useEffect(() => {
    apiRequest('/health').then(setHealth).catch(() => setHealth({ database: 'unknown' }));
    if (link.reset || link.view) clearUrl();
  }, [link]);

  const handleLogout = useCallback((reason) => {
    saveSession(null);
    setSession(null);
    setTab(null);
    setPendingCount(0);
    setShowPassword(false);
    setLogoutNotice(typeof reason === 'string' ? reason : '');
  }, []);

  const updateSession = useCallback((next) => {
    saveSession(next);
    setSession(next);
  }, []);

  const api = useMemo(() => createApi(session?.token, handleLogout), [session?.token, handleLogout]);
  const user = session?.user;
  const tabs = user ? TABS[user.role] || TABS.user : [];
  const activeTab = tab && tabs.includes(tab) ? tab : (link.view && tabs.includes(link.view === 'mine' ? 'mine' : link.view) ? link.view : tabs[0]);

  // Validate stored session; pick up role/name changes made by HR.
  useEffect(() => {
    if (!session?.token) return;
    api('/auth/me')
      .then(({ user: fresh }) => {
        if (JSON.stringify(fresh) !== JSON.stringify(session.user)) updateSession({ ...session, user: fresh });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  // Approval badge for approvers/admins, refreshed every minute.
  useEffect(() => {
    if (!user || user.must_change_password || !['approver', 'admin'].includes(user.role)) return undefined;
    const refresh = () => api('/requests?scope=approvals&status=Pending').then((r) => setPendingCount(r.length)).catch(() => {});
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [api, user]);

  const closePassword = useCallback(() => setShowPassword(false), []);

  if (resetToken) return <ResetPasswordView token={resetToken} onDone={() => setResetToken(null)} />;
  if (health?.database === 'missing') return <SetupRequired />;
  if (!session?.token) {
    return (
      <LoginView
        key={logoutNotice}
        notice={logoutNotice}
        demoMode={health?.database === 'pglite'}
        onLogin={({ token, user: u }) => { setLogoutNotice(''); updateSession({ token, user: u }); }}
      />
    );
  }
  if (user.must_change_password) {
    return <ForcePasswordChange api={api} user={user} onLogout={handleLogout} onChanged={({ token, user: u }) => updateSession({ token, user: u })} />;
  }

  const baseYear = health?.year || new Date().getFullYear();

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {health?.database === 'pglite' && (
        <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">Local demo database — data resets when the dev server restarts.</div>
      )}
      {user.role === 'admin' && health && !health.email && (
        <div className="bg-sky-50 px-4 py-2 text-center text-xs text-sky-900">
          Email notifications are off: SMTP settings are not configured yet. Requests still work; approvers just won't get emails.
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-4 shadow sm:px-6">
        <h1 className="text-xl font-bold text-slate-800">Leave Portal</h1>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-600">
            <b>{user.name}</b> <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{ROLE_LABELS[user.role]}</span>
          </span>
          <button type="button" onClick={() => setShowPassword(true)} className="text-sm text-slate-500 hover:text-slate-800">Change password</button>
          <button type="button" onClick={() => handleLogout()} className="rounded bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600">Log out</button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        {tabs.length > 1 && (
          <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={activeTab === t}
                onClick={() => { setTab(t); setHighlightId(null); }}
                className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium ${activeTab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                {TAB_LABELS[t]}
                {t === 'approvals' && pendingCount > 0 && <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">{pendingCount}</span>}
              </button>
            ))}
          </nav>
        )}

        {activeTab === 'approvals' && <Approvals api={api} user={user} highlightId={highlightId} onPendingCount={setPendingCount} />}
        {activeTab === 'team' && <MyTeam api={api} baseYear={baseYear} />}
        {activeTab === 'reports' && <Reports api={api} baseYear={baseYear} />}
        {activeTab === 'staff' && <Staff api={api} user={user} baseYear={baseYear} emailEnabled={Boolean(health?.email && health?.app_url)} />}
        {activeTab === 'mine' && <MyLeave api={api} baseYear={baseYear} />}
      </main>

      {showPassword && <ChangePasswordModal api={api} onClose={closePassword} onChanged={({ token, user: u }) => updateSession({ token, user: u })} />}
    </div>
  );
}
