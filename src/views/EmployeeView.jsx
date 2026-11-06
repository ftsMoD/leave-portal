import { useCallback, useEffect, useState } from 'react';
import { countBusinessDays, formatRange, todayIso } from '../lib/dates';
import { EmptyState, Notice, Spinner, StatusBadge } from '../components';

const MAX_REASON = 500;

function BalanceCard({ balance }) {
  const { leave_type, total_days, used_days, pending_days } = balance;
  const available = Math.max(total_days - used_days - pending_days, 0);
  const pct = (n) => (total_days > 0 ? `${Math.min((n / total_days) * 100, 100)}%` : '0%');

  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-blue-900">{leave_type}</span>
        <span className="text-sm text-blue-700">
          <b className="text-lg">{available}</b> of {total_days} days left
        </span>
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white" aria-hidden="true">
        <div className="bg-blue-700" style={{ width: pct(used_days) }} />
        <div className="bg-blue-300" style={{ width: pct(pending_days) }} />
      </div>
      <div className="mt-2 flex gap-4 text-xs text-blue-800/80">
        <span>{used_days} used</span>
        <span>{pending_days} pending</span>
      </div>
    </div>
  );
}

export default function EmployeeView({ api }) {
  const [balances, setBalances] = useState(null);
  const [requests, setRequests] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [leaveType, setLeaveType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([api('/balances/me'), api('/leave/requests?scope=mine')]);
      setBalances(b);
      setRequests(r);
      setLoadError('');
      setLeaveType((current) => current || b[0]?.leave_type || '');
    } catch (err) {
      if (err.status !== 401) setLoadError(err.message);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const workingDays = countBusinessDays(startDate, endDate);
  const selected = balances?.find((b) => b.leave_type === leaveType);
  const available = selected ? selected.total_days - selected.used_days - selected.pending_days : 0;
  const overBalance = selected && workingDays > available;

  const handleApply = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const data = await api('/leave/apply', {
        method: 'POST',
        body: { leave_type: leaveType, start_date: startDate, end_date: endDate, reason },
      });
      setNotice({ type: 'success', message: `${data.message} (${data.request.total_days} working day${data.request.total_days === 1 ? '' : 's'})` });
      setStartDate('');
      setEndDate('');
      setReason('');
      await load();
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (request) => {
    if (!window.confirm(`Cancel your ${request.leave_type} request for ${formatRange(request.start_date, request.end_date)}?`)) return;
    try {
      await api(`/leave/requests/${request.id}`, { method: 'PATCH', body: { status: 'Cancelled' } });
      setNotice({ type: 'success', message: 'Request cancelled.' });
      await load();
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    }
  };

  if (loadError) return <Notice notice={{ type: 'error', message: loadError }} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="card">
          <h3 className="mb-4 text-lg font-semibold text-slate-700">My leave balances</h3>
          {!balances ? <Spinner /> : balances.length === 0 ? (
            <EmptyState>No leave entitlements set up yet. Contact HR.</EmptyState>
          ) : (
            <div className="space-y-3">
              {balances.map((b) => <BalanceCard key={b.id} balance={b} />)}
            </div>
          )}
        </section>

        <section className="card">
          <h3 className="mb-4 text-lg font-semibold text-slate-700">Apply for leave</h3>
          <form onSubmit={handleApply} className="space-y-4">
            <div>
              <label className="label" htmlFor="leave-type">Leave type</label>
              <select id="leave-type" className="input" value={leaveType} onChange={(e) => setLeaveType(e.target.value)} required disabled={!balances?.length}>
                {balances?.map((b) => <option key={b.id} value={b.leave_type}>{b.leave_type}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="start-date">Start date</label>
                <input
                  id="start-date"
                  type="date"
                  className="input"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    if (!endDate || e.target.value > endDate) setEndDate(e.target.value);
                  }}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="end-date">End date</label>
                <input id="end-date" type="date" className="input" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} required />
              </div>
            </div>
            {startDate && endDate && (
              <p className={`text-sm ${overBalance || workingDays === 0 ? 'text-red-600' : 'text-slate-500'}`}>
                {workingDays === 0
                  ? 'These dates fall on a weekend — no working days selected.'
                  : `${workingDays} working day${workingDays === 1 ? '' : 's'} (weekends excluded)${overBalance ? ` — exceeds your ${available} available day${available === 1 ? '' : 's'}` : ''}`}
              </p>
            )}
            {startDate && startDate < todayIso() && (
              <p className="text-xs text-slate-400">Start date is in the past — fine for retroactive sick leave.</p>
            )}
            <div>
              <label className="label" htmlFor="reason">Reason <span className="font-normal text-slate-400">(optional)</span></label>
              <textarea id="reason" className="input" rows={3} placeholder="Reason…" maxLength={MAX_REASON} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Notice notice={notice} onDismiss={() => setNotice(null)} />
            <button type="submit" className="btn-primary w-full" disabled={submitting || !leaveType || workingDays === 0 || overBalance}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </form>
        </section>
      </div>

      <section className="card">
        <h3 className="mb-4 text-lg font-semibold text-slate-700">My requests</h3>
        {!requests ? <Spinner /> : requests.length === 0 ? (
          <EmptyState>You haven't submitted any leave requests yet.</EmptyState>
        ) : (
          <div className="-mx-6 overflow-x-auto px-6">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b text-sm text-slate-500">
                  <th className="pb-3 font-medium">Dates</th>
                  <th className="pb-3 font-medium">Type</th>
                  <th className="pb-3 font-medium">Days</th>
                  <th className="pb-3 font-medium">Reason</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3" />
                </tr>
              </thead>
              <tbody className="divide-y text-sm">
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="py-3 pr-3 text-slate-800">{formatRange(r.start_date, r.end_date)}</td>
                    <td className="py-3 pr-3">{r.leave_type}</td>
                    <td className="py-3 pr-3">{r.total_days}</td>
                    <td className="max-w-[16rem] truncate py-3 pr-3 text-slate-500" title={r.reason}>{r.reason || '—'}</td>
                    <td className="py-3 pr-3">
                      <StatusBadge status={r.status} />
                      {r.decided_by_name && r.status !== 'Cancelled' && (
                        <span className="ml-2 text-xs text-slate-400">by {r.decided_by_name}</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      {r.status === 'Pending' && (
                        <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => handleCancel(r)}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
