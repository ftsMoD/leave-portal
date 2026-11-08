import { useCallback, useEffect, useState } from 'react';
import { formatRange } from '../lib/dates';
import { Modal, RequestTable, Toast, leaveLabel, resultNotice, usePolling } from '../components';

const FILTERS = ['Pending', 'Approved', 'Rejected', 'All'];

function DecisionModal({ request, status, onConfirm, onClose }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const approve = status === 'Approved';
  return (
    <Modal title={`${approve ? 'Approve' : 'Reject'} leave request`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onConfirm(note); setBusy(false); }}
      >
        <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <div className="font-medium">{request.employee_name}</div>
          <div>{leaveLabel(request)}</div>
          <div>{formatRange(request.start_date, request.end_date)} · {request.total_days} working day{request.total_days === 1 ? '' : 's'}</div>
          {request.reason && <div className="mt-1 text-slate-500">“{request.reason}”</div>}
        </div>
        <div>
          <label className="label" htmlFor="decision-note">Comment for {request.employee_name.split(' ')[0]} <span className="font-normal text-slate-400">(optional)</span></label>
          <textarea id="decision-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Back</button>
          <button type="submit" className={approve ? 'btn-success' : 'btn-danger'} disabled={busy}>
            {busy ? 'Saving…' : approve ? 'Approve' : 'Reject'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Approvals({ api, user, highlightId, onPendingCount }) {
  const [requests, setRequests] = useState(null);
  const [filter, setFilter] = useState('Pending');
  const [decision, setDecision] = useState(null);
  const [notice, setNotice] = useState(null);
  const isAdmin = user.role === 'admin';

  const load = useCallback(async () => {
    try {
      const data = await api('/requests?scope=approvals');
      setRequests(data);
      onPendingCount?.(data.filter((r) => r.status === 'Pending').length);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api, onPendingCount]);

  useEffect(() => { load(); }, [load]);
  usePolling(load, 60_000);

  useEffect(() => {
    if (!highlightId || !requests) return;
    const r = requests.find((x) => x.id === highlightId);
    if (r && r.status !== 'Pending') setFilter('All');
    setTimeout(() => document.getElementById(`request-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  }, [highlightId, requests]);

  const decide = async (note) => {
    const { request, status } = decision;
    try {
      const data = await api(`/requests/${request.id}`, { method: 'PATCH', body: { status, note } });
      setNotice(resultNotice(data));
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    }
    setDecision(null);
    load();
  };

  const visible = requests?.filter((r) => filter === 'All' || r.status === filter);

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-700">{isAdmin ? 'All leave requests' : 'Requests from my team'}</h3>
          {isAdmin && <p className="text-xs text-slate-400">Line managers approve first. As HR you can step in for any request except your own.</p>}
        </div>
        <div className="inline-flex rounded-md border border-slate-200 p-0.5 text-sm" role="tablist" aria-label="Filter requests">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
              className={`rounded px-3 py-1 ${filter === f ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      <RequestTable
        rows={visible}
        showEmployee
        showManager={isAdmin}
        highlightId={highlightId}
        empty={filter === 'Pending' ? 'Nothing waiting for approval.' : 'No requests to show.'}
        actions={(r) => r.status === 'Pending' && (
          <span className="space-x-1.5">
            <button type="button" className="btn-success px-2 py-1 text-xs" onClick={() => setDecision({ request: r, status: 'Approved' })}>Approve</button>
            <button type="button" className="btn-danger px-2 py-1 text-xs" onClick={() => setDecision({ request: r, status: 'Rejected' })}>Reject</button>
          </span>
        )}
      />
      {decision && <DecisionModal {...decision} onConfirm={decide} onClose={() => setDecision(null)} />}
    </section>
  );
}
