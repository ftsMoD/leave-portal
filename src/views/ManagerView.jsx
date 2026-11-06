import { useCallback, useEffect, useState } from 'react';
import { formatRange } from '../lib/dates';
import { EmptyState, Notice, Spinner, StatusBadge } from '../components';

export default function ManagerView({ api, currentUserId, onPendingCount }) {
  const [requests, setRequests] = useState(null);
  const [filter, setFilter] = useState('Pending');
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const fetchRequests = useCallback(async () => {
    try {
      const data = await api('/leave/requests');
      setRequests(data);
      onPendingCount?.(data.filter((r) => r.status === 'Pending' && r.user_id !== currentUserId).length);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api, currentUserId, onPendingCount]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleAction = async (request, status) => {
    setBusyId(request.id);
    setNotice(null);
    try {
      await api(`/leave/requests/${request.id}`, { method: 'PATCH', body: { status } });
      setNotice({ type: 'success', message: `${request.employee_name}'s ${request.leave_type} request ${status.toLowerCase()}.` });
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setBusyId(null);
      fetchRequests();
    }
  };

  const visible = requests?.filter((r) => filter === 'All' || r.status === filter) ?? [];

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-slate-700">Team leave requests</h3>
        <div className="inline-flex rounded-md border border-slate-200 p-0.5 text-sm" role="tablist" aria-label="Filter requests">
          {['Pending', 'Approved', 'Rejected', 'All'].map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-1 ${filter === f ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4"><Notice notice={notice} onDismiss={() => setNotice(null)} /></div>

      {!requests ? <Spinner /> : visible.length === 0 ? (
        <EmptyState>{filter === 'Pending' ? 'Nothing waiting for approval.' : 'No requests to show.'}</EmptyState>
      ) : (
        <div className="-mx-6 overflow-x-auto px-6">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b text-sm text-slate-500">
                <th className="pb-3 font-medium">Employee</th>
                <th className="pb-3 font-medium">Type</th>
                <th className="pb-3 font-medium">Dates</th>
                <th className="pb-3 font-medium">Days</th>
                <th className="pb-3 font-medium">Reason</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y text-sm">
              {visible.map((r) => {
                const own = r.user_id === currentUserId;
                return (
                  <tr key={r.id}>
                    <td className="py-3 pr-3 font-medium text-slate-800">{r.employee_name}{own && <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>}</td>
                    <td className="py-3 pr-3">{r.leave_type}</td>
                    <td className="py-3 pr-3">{formatRange(r.start_date, r.end_date)}</td>
                    <td className="py-3 pr-3">{r.total_days}</td>
                    <td className="max-w-[14rem] truncate py-3 pr-3 text-slate-500" title={r.reason}>{r.reason || '—'}</td>
                    <td className="py-3 pr-3">
                      <StatusBadge status={r.status} />
                      {r.decided_by_name && r.status !== 'Pending' && r.status !== 'Cancelled' && (
                        <span className="ml-2 text-xs text-slate-400">by {r.decided_by_name}</span>
                      )}
                    </td>
                    <td className="space-x-2 whitespace-nowrap py-3">
                      {r.status === 'Pending' && (own ? (
                        <span className="text-xs text-slate-400">Needs another manager</span>
                      ) : (
                        <>
                          <button type="button" className="btn-success px-2 py-1 text-xs" disabled={busyId === r.id} onClick={() => handleAction(r, 'Approved')}>Approve</button>
                          <button type="button" className="btn-danger px-2 py-1 text-xs" disabled={busyId === r.id} onClick={() => handleAction(r, 'Rejected')}>Reject</button>
                        </>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
