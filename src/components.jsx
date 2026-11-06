import { useEffect, useRef, useState } from 'react';

const STATUS_STYLES = {
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
  Cancelled: 'bg-slate-100 text-slate-500',
  Pending: 'bg-yellow-100 text-yellow-800',
};

export function StatusBadge({ status }) {
  return (
    <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.Pending}`}>
      {status}
    </span>
  );
}

export function Notice({ notice, onDismiss }) {
  if (!notice) return null;
  const tone = notice.type === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-green-200 bg-green-50 text-green-700';
  return (
    <div role={notice.type === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${tone}`}>
      <span>{notice.message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }) {
  return <p className="py-6 text-center text-sm text-slate-400">{children}</p>;
}

export function Spinner() {
  return <p className="py-6 text-center text-sm text-slate-400">Loading…</p>;
}

export function ChangePasswordDialog({ api, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const firstField = useRef(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (next !== confirm) return setNotice({ type: 'error', message: 'New passwords do not match.' });
    setBusy(true);
    setNotice(null);
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: current, new_password: next } });
      setNotice({ type: 'success', message: 'Password updated.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-title"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-lg"
      >
        <h2 id="pw-title" className="text-lg font-semibold text-slate-800">Change password</h2>
        <Notice notice={notice} />
        <div>
          <label className="label" htmlFor="pw-current">Current password</label>
          <input ref={firstField} id="pw-current" type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </div>
        <div>
          <label className="label" htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          <p className="mt-1 text-xs text-slate-400">At least 8 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
        </div>
      </form>
    </div>
  );
}
