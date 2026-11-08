import { useCallback, useEffect, useState } from 'react';
import { countBusinessDays, formatRange, todayIso, yearOf } from '../lib/dates';
import { BalanceCards, DownloadButton, Notice, RequestTable, Toast, YearSelect, resultNotice } from '../components';

export default function MyLeave({ api, baseYear }) {
  const [year, setYear] = useState(baseYear);
  const [balances, setBalances] = useState(null);
  const [requests, setRequests] = useState(null);
  const [options, setOptions] = useState(null);
  const [notice, setNotice] = useState(null);

  const [leaveType, setLeaveType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [details, setDetails] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formNotice, setFormNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([api(`/balances?year=${year}`), api(`/requests?scope=mine&year=${year}`)]);
      setBalances(b[0]?.balances || []);
      setRequests(r);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api, year]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api('/my/leave-options')
      .then((o) => { setOptions(o); setLeaveType((cur) => cur || o[0]?.leave_type || ''); })
      .catch(() => {});
  }, [api]);

  const selected = options?.find((o) => o.leave_type === leaveType);
  const workingDays = countBusinessDays(startDate, endDate);
  const balance = balances?.find((b) => b.leave_type === leaveType);
  const sameYear = startDate && yearOf(startDate) === year && yearOf(endDate) === year;
  const overBalance = Boolean(balance && !balance.unlimited && sameYear && workingDays > balance.available);

  const handleApply = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFormNotice(null);
    try {
      const data = await api('/requests', {
        method: 'POST',
        body: { leave_type: leaveType, start_date: startDate, end_date: endDate, details: selected?.unlimited ? details : '', reason },
      });
      setFormNotice(resultNotice(data));
      setStartDate(''); setEndDate(''); setDetails(''); setReason('');
      if (yearOf(data.request.start_date) !== year) setYear(yearOf(data.request.start_date));
      else await load();
    } catch (err) {
      setFormNotice({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (r) => {
    if (!window.confirm(`Cancel your ${r.leave_type} request for ${formatRange(r.start_date, r.end_date)}?`)) return;
    try {
      await api(`/requests/${r.id}`, { method: 'PATCH', body: { status: 'Cancelled' } });
      setNotice({ type: 'success', message: 'Request cancelled.' });
      await load();
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    }
  };

  return (
    <div className="space-y-6">
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <section className="card lg:col-span-3">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold text-slate-700">My balances</h3>
            <YearSelect value={year} onChange={setYear} baseYear={baseYear} id="balance-year" />
          </div>
          <BalanceCards balances={balances} />
          <p className="mt-3 text-xs text-slate-400">Entitlements reset every 1 January. Unused days do not carry forward.</p>
        </section>

        <section className="card lg:col-span-2">
          <h3 className="mb-4 text-lg font-semibold text-slate-700">Request leave</h3>
          <form onSubmit={handleApply} className="space-y-4">
            <div>
              <label className="label" htmlFor="leave-type">Leave type</label>
              <select id="leave-type" className="input" value={leaveType} onChange={(e) => setLeaveType(e.target.value)} required disabled={!options?.length}>
                {options?.map((o) => <option key={o.leave_type} value={o.leave_type}>{o.leave_type}{o.unlimited ? ' (unlimited)' : ''}</option>)}
              </select>
            </div>
            {selected?.unlimited && (
              <div>
                <label className="label" htmlFor="details">Type of leave <span className="text-red-500">*</span></label>
                <input id="details" className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={120} required minLength={2}
                  placeholder="e.g. Bereavement, Marriage, Exam, Compassionate" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="start-date">Start date</label>
                <input id="start-date" type="date" className="input" value={startDate} required
                  onChange={(e) => { setStartDate(e.target.value); if (!endDate || e.target.value > endDate) setEndDate(e.target.value); }} />
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
                  : `${workingDays} working day${workingDays === 1 ? '' : 's'} (weekends excluded)`}
                {overBalance && ` — more than your ${balance.available} available`}
              </p>
            )}
            {startDate && startDate < todayIso() && <p className="text-xs text-slate-400">Start date is in the past — fine for sick leave taken already.</p>}
            <div>
              <label className="label" htmlFor="reason">Reason <span className="font-normal text-slate-400">(optional)</span></label>
              <textarea id="reason" className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Notice notice={formNotice} onDismiss={() => setFormNotice(null)} />
            <button type="submit" className="btn-primary w-full" disabled={submitting || !leaveType || workingDays === 0 || overBalance}>
              {submitting ? 'Submitting…' : 'Submit for approval'}
            </button>
          </form>
        </section>
      </div>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-700">My requests · {year}</h3>
          <div className="flex gap-2">
            <DownloadButton api={api} path={`/export/my-requests.csv?year=${year}`} onError={(m) => setNotice({ type: 'error', message: m })}>Leave history</DownloadButton>
            <DownloadButton api={api} path={`/export/my-balances.csv?year=${year}`} onError={(m) => setNotice({ type: 'error', message: m })}>Balances</DownloadButton>
          </div>
        </div>
        <RequestTable
          rows={requests}
          empty={`No leave requests in ${year}.`}
          actions={(r) => r.status === 'Pending' && (
            <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => handleCancel(r)}>Cancel</button>
          )}
        />
      </section>
    </div>
  );
}
