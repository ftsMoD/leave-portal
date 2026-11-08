import { useEffect, useRef, useState } from 'react';
import { formatRange } from './lib/dates';

export const ROLE_LABELS = { user: 'User', approver: 'Approver', admin: 'Administrator' };

const STATUS_STYLES = {
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
  Cancelled: 'bg-slate-100 text-slate-500',
  Pending: 'bg-yellow-100 text-yellow-800',
};

export function StatusBadge({ status }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.Pending}`}>{status}</span>;
}

export function Notice({ notice, onDismiss }) {
  if (!notice) return null;
  const tone = {
    error: 'border-red-200 bg-red-50 text-red-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    success: 'border-green-200 bg-green-50 text-green-700',
  }[notice.type] || 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div role={notice.type === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${tone}`}>
      <span>{notice.message}</span>
      {onDismiss && <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">✕</button>}
    </div>
  );
}

// Floating result message, visible wherever the user has scrolled.
// Success/warning messages fade after 7s; errors stay until dismissed.
export function Toast({ notice, onDismiss }) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!notice || notice.type === 'error') return undefined;
    const t = setTimeout(() => dismiss.current?.(), 7000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 shadow-lg sm:left-auto sm:right-6 sm:w-[26rem]">
      <Notice notice={notice} onDismiss={onDismiss} />
    </div>
  );
}

// Adds a warning when the server reports the notification email failed.
export function resultNotice(data, fallback) {
  const message = data?.message || fallback;
  if (data?.email === false) return { type: 'warning', message: `${message} The email notification could not be sent.` };
  return { type: 'success', message };
}

export const EmptyState = ({ children }) => <p className="py-6 text-center text-sm text-slate-400">{children}</p>;
export const Spinner = () => <p className="py-6 text-center text-sm text-slate-400">Loading…</p>;

export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('input, select, textarea, button')?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={`my-8 w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg bg-white p-6 shadow-lg`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function YearSelect({ value, onChange, baseYear, id = 'year' }) {
  const years = [baseYear - 1, baseYear, baseYear + 1];
  return (
    <select id={id} aria-label="Year" className="input w-auto py-1.5" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
}

export function DownloadButton({ api, path, children, onError }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary px-2.5 py-1.5 text-xs"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await api.download(path); } catch (err) { onError?.(err.message); } finally { setBusy(false); }
      }}
    >
      {busy ? 'Preparing…' : `⬇ ${children}`}
    </button>
  );
}

export const leaveLabel = (r) => (r.details ? `${r.leave_type} — ${r.details}` : r.leave_type);

export function RequestTable({ rows, showEmployee = false, showManager = false, highlightId, actions, empty = 'No requests to show.' }) {
  if (!rows) return <Spinner />;
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="relative -mx-6 overflow-x-auto px-6">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b text-slate-500">
            {showEmployee && <th className="pb-2 pr-3 font-medium">Employee</th>}
            {showManager && <th className="pb-2 pr-3 font-medium">Line manager</th>}
            <th className="pb-2 pr-3 font-medium">Leave</th>
            <th className="pb-2 pr-3 font-medium">Dates</th>
            <th className="pb-2 pr-3 font-medium">Days</th>
            <th className="pb-2 pr-3 font-medium">Reason</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            {actions && <th className="pb-2 font-medium"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.id} id={`request-${r.id}`} className={highlightId === r.id ? 'bg-blue-50 ring-2 ring-inset ring-blue-300' : ''}>
              {showEmployee && <td className="py-2.5 pr-3 font-medium text-slate-800">{r.employee_name}</td>}
              {showManager && <td className="py-2.5 pr-3 text-slate-500">{r.line_manager_name || '—'}</td>}
              <td className="py-2.5 pr-3">{leaveLabel(r)}</td>
              <td className="whitespace-nowrap py-2.5 pr-3">{formatRange(r.start_date, r.end_date)}</td>
              <td className="py-2.5 pr-3">{r.total_days}</td>
              <td className="max-w-[14rem] truncate py-2.5 pr-3 text-slate-500" title={r.reason}>{r.reason || '—'}</td>
              <td className="py-2.5 pr-3">
                <StatusBadge status={r.status} />
                {r.decided_by_name && ['Approved', 'Rejected'].includes(r.status) && (
                  <span className="ml-1.5 text-xs text-slate-400" title={r.decision_note || undefined}>by {r.decided_by_name}</span>
                )}
              </td>
              {actions && <td className="whitespace-nowrap py-2.5 text-right">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Balance cards for one person.
export function BalanceCards({ balances }) {
  if (!balances) return <Spinner />;
  if (!balances.length) return <EmptyState>No leave entitlements set up yet. Contact HR.</EmptyState>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {balances.map((b) => {
        const total = b.unlimited ? 0 : Math.max(b.entitlement + b.adjustment, 0);
        const pct = (n) => (total > 0 ? `${Math.min((n / total) * 100, 100)}%` : '0%');
        return (
          <div key={b.leave_type} className="rounded-lg border border-blue-100 bg-blue-50 p-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-blue-900">{b.leave_type}</span>
              {b.unlimited ? (
                <span className="text-sm text-blue-700">Unlimited</span>
              ) : (
                <span className="text-sm text-blue-700"><b className="text-lg">{b.available}</b> of {total} left</span>
              )}
            </div>
            {!b.unlimited && (
              <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white" aria-hidden="true">
                <div className="bg-blue-700" style={{ width: pct(b.used) }} />
                <div className="bg-blue-300" style={{ width: pct(b.pending) }} />
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-blue-800/80">
              <span>{b.used} used</span>
              <span>{b.pending} pending</span>
              {b.adjustment !== 0 && <span>{b.adjustment > 0 ? '+' : ''}{b.adjustment} adjusted</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// People × leave types grid (team / all staff).
export function BalanceMatrix({ people, types }) {
  if (!people || !types) return <Spinner />;
  if (!people.length) return <EmptyState>No one to show.</EmptyState>;
  return (
    <div className="relative -mx-6 overflow-x-auto px-6">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b text-slate-500">
            <th className="pb-2 pr-3 font-medium">Employee</th>
            {types.map((t) => <th key={t.name} className="pb-2 pr-3 font-medium">{t.name.replace(' Leave', '')}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {people.map((p) => (
            <tr key={p.user_id}>
              <td className="py-2 pr-3">
                <div className="font-medium text-slate-800">{p.name}</div>
                <div className="text-xs text-slate-400">{p.location}</div>
              </td>
              {types.map((t) => {
                const b = p.balances.find((x) => x.leave_type === t.name);
                if (!b) return <td key={t.name} className="py-2 pr-3 text-slate-300">N/A</td>;
                return (
                  <td key={t.name} className="py-2 pr-3" title={b.unlimited ? `${b.used} used, ${b.pending} pending` : `Entitlement ${b.entitlement}, adjusted ${b.adjustment}, used ${b.used}, pending ${b.pending}`}>
                    {b.unlimited ? (
                      <span className="text-slate-600">∞ <span className="text-xs text-slate-400">({b.used} used)</span></span>
                    ) : (
                      <span className={b.available <= 0 ? 'font-semibold text-red-600' : 'text-slate-800'}>
                        {b.available}<span className="text-xs text-slate-400"> / {b.entitlement + b.adjustment}</span>
                      </span>
                    )}
                    {b.pending > 0 && <div className="text-xs text-amber-600">{b.pending} pending</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PasswordFields({ onSubmit, busy, requireCurrent = true, submitLabel = 'Update password' }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (next !== confirm) return setError('New passwords do not match.');
        setError('');
        const ok = await onSubmit({ current_password: current, new_password: next });
        if (ok) { setCurrent(''); setNext(''); setConfirm(''); }
      }}
    >
      {error && <Notice notice={{ type: 'error', message: error }} />}
      {requireCurrent && (
        <div>
          <label className="label" htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </div>
      )}
      <div>
        <label className="label" htmlFor="pw-new">New password</label>
        <input id="pw-new" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        <p className="mt-1 text-xs text-slate-400">At least 10 characters.</p>
      </div>
      <div>
        <label className="label" htmlFor="pw-confirm">Confirm new password</label>
        <input id="pw-confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}

// Re-run `load` every `ms` while the tab is visible ("live" views).
export function usePolling(load, ms) {
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && load();
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [load, ms]);
}
