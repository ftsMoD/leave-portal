import { useCallback, useEffect, useState } from 'react';
import { countBusinessDays, formatDateTime, formatRange } from '../lib/dates';
import {
  BalanceMatrix, DownloadButton, EmptyState, Modal, Notice, RequestTable, Spinner, YearSelect, resultNotice, usePolling,
} from '../components';

const STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

function RequestEditor({ api, request, staff, types, onSaved, onClose }) {
  const creating = !request;
  const [form, setForm] = useState(() => ({
    user_id: request?.user_id ?? '',
    leave_type: request?.leave_type ?? types[0]?.name ?? '',
    start_date: request?.start_date ?? '',
    end_date: request?.end_date ?? '',
    details: request?.details ?? '',
    reason: request?.reason ?? '',
    status: request?.status ?? 'Approved',
    decision_note: request?.decision_note ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const employee = staff.find((s) => s.id === Number(form.user_id));
  const ent = employee?.entitlements?.[form.leave_type];
  const days = countBusinessDays(form.start_date, form.end_date);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = creating
        ? await api('/admin/requests', { method: 'POST', body: { ...form, user_id: Number(form.user_id) } })
        : await api(`/admin/requests/${request.id}`, { method: 'PUT', body: form });
      onSaved(resultNotice(data));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete this ${request.leave_type} record for ${request.employee_name}? This cannot be undone.`)) return;
    try {
      await api(`/admin/requests/${request.id}`, { method: 'DELETE' });
      onSaved({ type: 'success', message: 'Leave record deleted.' });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal title={creating ? 'Add leave record' : `Edit ${request.employee_name}'s leave`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice notice={{ type: 'error', message: error }} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {creating && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor="ed-user">Employee</label>
              <select id="ed-user" className="input" value={form.user_id} onChange={set('user_id')} required>
                <option value="">Select…</option>
                {staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="ed-type">Leave type</label>
            <select id="ed-type" className="input" value={form.leave_type} onChange={set('leave_type')}>
              {types.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            {employee && ent === undefined && <p className="mt-1 text-xs text-red-600">N/A for {employee.name}.</p>}
          </div>
          <div>
            <label className="label" htmlFor="ed-details">Type of leave / note {ent === 'unlimited' && <span className="text-red-500">*</span>}</label>
            <input id="ed-details" className="input" value={form.details} onChange={set('details')} maxLength={120} placeholder="Required for unlimited types" />
          </div>
          <div>
            <label className="label" htmlFor="ed-start">Start date</label>
            <input id="ed-start" type="date" className="input" value={form.start_date} onChange={set('start_date')} required />
          </div>
          <div>
            <label className="label" htmlFor="ed-end">End date</label>
            <input id="ed-end" type="date" className="input" value={form.end_date} min={form.start_date || undefined} onChange={set('end_date')} required />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="ed-reason">Reason</label>
            <input id="ed-reason" className="input" value={form.reason} onChange={set('reason')} maxLength={500} />
          </div>
          <div>
            <label className="label" htmlFor="ed-status">Status</label>
            <select id="ed-status" className="input" value={form.status} onChange={set('status')}>
              {(creating ? ['Approved', 'Pending'] : STATUSES).map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          {!creating && (
            <div>
              <label className="label" htmlFor="ed-note">Decision comment</label>
              <input id="ed-note" className="input" value={form.decision_note} onChange={set('decision_note')} maxLength={500} />
            </div>
          )}
        </div>
        {days > 0 && <p className="text-sm text-slate-500">{days} working day{days === 1 ? '' : 's'}. Balance rules still apply — add an adjustment first if needed.</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!creating ? <button type="button" className="text-sm text-red-600 hover:underline" onClick={remove}>Delete record</button> : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function StatCard({ label, value, children }) {
  return (
    <div className="card p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-slate-800">{value}</div>
      {children}
    </div>
  );
}

export default function Reports({ api, baseYear }) {
  const [year, setYear] = useState(baseYear);
  const [summary, setSummary] = useState(null);
  const [people, setPeople] = useState(null);
  const [requests, setRequests] = useState(null);
  const [types, setTypes] = useState(null);
  const [staff, setStaff] = useState([]);
  const [status, setStatus] = useState('');
  const [person, setPerson] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | request
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, p, r] = await Promise.all([
        api('/admin/reports/summary'),
        api(`/balances?scope=all&year=${year}`),
        api(`/requests?scope=all&year=${year}${status ? `&status=${status}` : ''}`),
      ]);
      setSummary(s);
      setPeople(p);
      setRequests(r);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api, year, status]);

  useEffect(() => { load(); }, [load]);
  usePolling(load, 30_000); // "real-time" view: refreshes every 30s while open
  useEffect(() => {
    Promise.all([api('/leave-types'), api('/admin/staff')]).then(([t, s]) => { setTypes(t); setStaff(s); }).catch(() => {});
  }, [api]);

  const onError = (m) => setNotice({ type: 'error', message: m });
  const visible = requests?.filter((r) => !person || r.user_id === Number(person));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" aria-hidden="true" />
          Live · refreshes every 30 seconds{summary && ` · updated ${formatDateTime(summary.generated_at)}`}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="report-year" className="text-sm text-slate-500">Year</label>
          <YearSelect value={year} onChange={setYear} baseYear={baseYear} id="report-year" />
        </div>
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />

      {!summary ? <Spinner /> : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Waiting for approval" value={summary.pending_count} />
          <StatCard label="On leave today" value={summary.on_leave_today.length}>
            <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
              {summary.on_leave_today.map((r) => <li key={r.id}>{r.employee_name} · {r.leave_type}</li>)}
            </ul>
          </StatCard>
          <StatCard label="Starting in the next 14 days" value={summary.upcoming.length}>
            <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
              {summary.upcoming.slice(0, 6).map((r) => (
                <li key={r.id}>{r.employee_name} · {formatRange(r.start_date, r.end_date)}{r.status === 'Pending' ? ' (pending)' : ''}</li>
              ))}
            </ul>
          </StatCard>
        </div>
      )}

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-700">Balances · {year}</h3>
          <div className="flex flex-wrap gap-2">
            <DownloadButton api={api} path={`/export/balances.csv?year=${year}`} onError={onError}>Balances report</DownloadButton>
            <DownloadButton api={api} path="/export/staff.csv" onError={onError}>Staff & entitlements</DownloadButton>
          </div>
        </div>
        <BalanceMatrix people={people} types={types} />
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-700">All leave records · {year}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Status" className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select aria-label="Employee" className="input w-auto py-1.5" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Everyone</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <DownloadButton api={api} path={`/export/requests.csv?year=${year}${status ? `&status=${status}` : ''}`} onError={onError}>Leave report</DownloadButton>
            <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => setEditing('new')} disabled={!types}>+ Add leave record</button>
          </div>
        </div>
        <RequestTable
          rows={visible}
          showEmployee
          showManager
          empty="No leave records for this filter."
          actions={(r) => <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => setEditing(r)}>Edit</button>}
        />
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-700">Recent activity</h3>
          <DownloadButton api={api} path="/export/activity.csv" onError={onError}>Full activity log</DownloadButton>
        </div>
        {!summary ? <Spinner /> : summary.activity.length === 0 ? <EmptyState>No activity yet.</EmptyState> : (
          <ul className="divide-y text-sm">
            {summary.activity.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
                <span className="w-32 shrink-0 text-xs text-slate-400">{formatDateTime(a.created_at)}</span>
                <span className="text-slate-700">{a.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && types && (
        <RequestEditor
          api={api}
          request={editing === 'new' ? null : editing}
          staff={staff}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={(n) => { setEditing(null); setNotice(n); load(); }}
        />
      )}
    </div>
  );
}

