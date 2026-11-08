import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../lib/dates';
import { DownloadButton, EmptyState, Modal, Notice, ROLE_LABELS, Spinner, Toast, YearSelect } from '../components';

function entitlementState(value) {
  if (value === undefined) return { mode: 'na', days: '' };
  if (value === 'unlimited') return { mode: 'unlimited', days: '' };
  return { mode: 'days', days: String(value) };
}

function StaffForm({ api, member, staff, types, currentUserId, onSaved, onClose }) {
  const creating = !member;
  const [form, setForm] = useState({
    name: member?.name ?? '',
    email: member?.email ?? '',
    location: member?.location ?? '',
    role: member?.role ?? 'user',
    manager_id: member?.manager_id ?? '',
    active: member?.active ?? true,
  });
  const [ents, setEnts] = useState(() => Object.fromEntries(types.map((t) => [t.name, entitlementState(member?.entitlements?.[t.name])])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setEnt = (type, patch) => setEnts((s) => ({ ...s, [type]: { ...s[type], ...patch } }));

  const managers = staff.filter((s) => s.active && ['approver', 'admin'].includes(s.role) && s.id !== member?.id);
  const locations = [...new Set(staff.map((s) => s.location).filter(Boolean))];
  const isSelf = member?.id === currentUserId;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const entitlements = Object.fromEntries(Object.entries(ents).map(([t, v]) => [t, v.mode === 'days' ? Number(v.days || 0) : v.mode]));
    const body = { ...form, manager_id: form.manager_id === '' ? null : Number(form.manager_id), entitlements };
    try {
      const data = creating
        ? await api('/admin/staff', { method: 'POST', body })
        : await api(`/admin/staff/${member.id}`, { method: 'PUT', body });
      onSaved({ type: 'success', message: creating ? `${form.name} added. Next: set a temporary password or send a set-up email.` : data.message });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={creating ? 'Add staff member' : `Edit ${member.name}`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-5">
        {error && <Notice notice={{ type: 'error', message: error }} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="sf-name">Full name</label>
            <input id="sf-name" className="input" value={form.name} onChange={set('name')} required maxLength={100} />
          </div>
          <div>
            <label className="label" htmlFor="sf-email">Work email</label>
            <input id="sf-email" type="email" className="input" value={form.email} onChange={set('email')} required />
          </div>
          <div>
            <label className="label" htmlFor="sf-location">Location</label>
            <input id="sf-location" className="input" list="sf-locations" value={form.location} onChange={set('location')} required />
            <datalist id="sf-locations">{locations.map((l) => <option key={l} value={l} />)}</datalist>
          </div>
          <div>
            <label className="label" htmlFor="sf-role">Role in leave portal</label>
            <select id="sf-role" className="input" value={form.role} onChange={set('role')} disabled={isSelf}>
              {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="sf-manager">Line manager / approver</label>
            <select id="sf-manager" className="input" value={form.manager_id ?? ''} onChange={set('manager_id')}>
              <option value="">None (requests go to HR)</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {!creating && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.active} onChange={set('active')} disabled={isSelf} />
              Account active
            </label>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">Leave entitlements (days per calendar year)</h4>
          <div className="divide-y rounded-md border">
            {types.map((t) => {
              const v = ents[t.name];
              const blocked = t.location_only && form.location && form.location !== t.location_only;
              return (
                <div key={t.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-[9rem] flex-1 text-sm text-slate-700">
                    {t.name}
                    {t.location_only && <span className={`ml-1 text-xs ${blocked ? 'text-amber-600' : 'text-slate-400'}`}>({t.location_only} only{blocked ? ' — hidden for this location' : ''})</span>}
                  </span>
                  <select aria-label={`${t.name} entitlement`} className="input w-36 py-1.5" value={v.mode} onChange={(e) => setEnt(t.name, { mode: e.target.value })}>
                    <option value="days">Days</option>
                    <option value="unlimited">Unlimited</option>
                    <option value="na">N/A</option>
                  </select>
                  <input aria-label={`${t.name} days`} type="number" min="0" max="366" className="input w-20 py-1.5" value={v.days}
                    onChange={(e) => setEnt(t.name, { days: e.target.value })} disabled={v.mode !== 'days'} required={v.mode === 'days'} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdjustmentsModal({ api, member, types, baseYear, onClose, onChanged }) {
  const limited = types.filter((t) => typeof member.entitlements[t.name] === 'number');
  const [year, setYear] = useState(baseYear);
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ leave_type: limited[0]?.name ?? '', days: '', reason: '' });
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api(`/admin/adjustments?user_id=${member.id}&year=${year}`).then(setRows).catch((err) => setNotice({ type: 'error', message: err.message }));
  }, [api, member.id, year]);
  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/adjustments', { method: 'POST', body: { user_id: member.id, year, leave_type: form.leave_type, days: Number(form.days), reason: form.reason } });
      setForm((f) => ({ ...f, days: '', reason: '' }));
      setNotice({ type: 'success', message: 'Adjustment saved.' });
      load();
      onChanged();
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this adjustment?')) return;
    try {
      await api(`/admin/adjustments/${id}`, { method: 'DELETE' });
      load();
      onChanged();
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    }
  };

  return (
    <Modal title={`Adjust balances — ${member.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Use a negative number to deduct days (e.g. <b>-4</b> for leave taken before the portal went live) or a positive number to add days.
        </p>
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        <form onSubmit={add} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-6">
          <div className="sm:col-span-1">
            <label className="label" htmlFor="adj-year">Year</label>
            <YearSelect value={year} onChange={setYear} baseYear={baseYear} id="adj-year" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="adj-type">Leave type</label>
            <select id="adj-type" className="input" value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
              {limited.map((t) => <option key={t.name}>{t.name}</option>)}
            </select>
          </div>
          <div className="sm:col-span-1">
            <label className="label" htmlFor="adj-days">Days (+/−)</label>
            <input id="adj-days" type="number" className="input" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} required />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="adj-reason">Reason</label>
            <input id="adj-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required minLength={3} />
          </div>
          <div className="sm:col-span-6 flex justify-end">
            <button type="submit" className="btn-primary" disabled={!limited.length}>Add adjustment</button>
          </div>
        </form>
        {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState>No adjustments for {year}.</EmptyState> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th className="pb-2">Leave type</th><th className="pb-2">Days</th><th className="pb-2">Reason</th><th className="pb-2">By</th><th /></tr></thead>
            <tbody className="divide-y">
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="py-2">{a.leave_type}</td>
                  <td className={`py-2 font-medium ${a.days < 0 ? 'text-red-600' : 'text-green-700'}`}>{a.days > 0 ? '+' : ''}{a.days}</td>
                  <td className="py-2 text-slate-600">{a.reason}</td>
                  <td className="py-2 text-xs text-slate-400">{a.created_by_name}<br />{formatDateTime(a.created_at)}</td>
                  <td className="py-2 text-right"><button type="button" className="text-xs text-red-600 hover:underline" onClick={() => remove(a.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function TempPasswordModal({ result, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Temporary password" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Share this with <b>{result.name}</b> privately (in person or a direct message). They will be asked to choose their own password when they first sign in. It won't be shown again.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-slate-100 px-3 py-2 text-lg tracking-wide text-slate-800" data-testid="temp-password">{result.password}</code>
          <button type="button" className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(result.password); setCopied(true); } catch { /* clipboard blocked */ } }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex justify-end"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

function accessLabel(s) {
  if (!s.active) return { text: 'Inactive', cls: 'bg-slate-100 text-slate-500' };
  if (s.locked) return { text: 'Locked (15 min)', cls: 'bg-red-100 text-red-700' };
  if (!s.has_password) return { text: 'No password yet', cls: 'bg-amber-100 text-amber-800' };
  if (s.must_change_password) return { text: 'Temp password', cls: 'bg-blue-100 text-blue-700' };
  return { text: 'Active', cls: 'bg-green-100 text-green-700' };
}

export default function Staff({ api, user, baseYear, emailEnabled }) {
  const [staff, setStaff] = useState(null);
  const [types, setTypes] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | member
  const [adjusting, setAdjusting] = useState(null);
  const [tempResult, setTempResult] = useState(null);
  const [busy, setBusy] = useState(null); // e.g. "12:setup" while that action runs

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api('/admin/staff'), api('/leave-types')]);
      setStaff(s);
      setTypes(t);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, okMessage, busyKey = null) => {
    setBusy(busyKey);
    try {
      const data = await fn();
      if (okMessage !== false) setNotice({ type: 'success', message: data?.message || okMessage });
      load();
      return data;
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const tempPassword = async (s) => {
    if (s.has_password && !window.confirm(`Replace ${s.name}'s password with a temporary one? They will be signed out.`)) return;
    const data = await act(() => api(`/admin/staff/${s.id}/temp-password`, { method: 'POST' }), false, `${s.id}:temp`);
    if (data) setTempResult({ name: s.name, password: data.password });
  };
  const setupEmail = (s) => act(() => api(`/admin/staff/${s.id}/setup-email`, { method: 'POST' }), undefined, `${s.id}:setup`);
  const toggleActive = (s) => {
    if (s.active && !window.confirm(`Deactivate ${s.name}? They will be signed out and unable to sign in. Their leave history is kept.`)) return;
    act(() => api(`/admin/staff/${s.id}`, { method: 'PUT', body: { active: !s.active } }), s.active ? 'Account deactivated.' : 'Account reactivated.');
  };
  const remove = (s) => {
    if (!window.confirm(`Permanently delete ${s.name}? Only possible if they have no leave records.`)) return;
    act(() => api(`/admin/staff/${s.id}`, { method: 'DELETE' }));
  };

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold text-slate-700">Staff, roles &amp; entitlements</h3>
          <p className="text-xs text-slate-400">{staff ? `${staff.filter((s) => s.active).length} active` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DownloadButton api={api} path="/export/staff.csv" onError={(m) => setNotice({ type: 'error', message: m })}>Export</DownloadButton>
          <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => setEditing('new')} disabled={!types}>+ Add staff member</button>
        </div>
      </div>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />

      {!staff || !types ? <Spinner /> : (
        <div className="relative -mx-6 overflow-x-auto px-6">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b text-slate-500">
                <th className="pb-2 pr-3 font-medium">Name</th>
                <th className="pb-2 pr-3 font-medium">Location</th>
                <th className="pb-2 pr-3 font-medium">Role</th>
                <th className="pb-2 pr-3 font-medium">Line manager</th>
                <th className="pb-2 pr-3 font-medium">Sign-in</th>
                <th className="pb-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {staff.map((s) => {
                const access = accessLabel(s);
                return (
                  <tr key={s.id} className={s.active ? '' : 'opacity-60'}>
                    <td className="py-2.5 pr-3"><div className="font-medium text-slate-800">{s.name}</div><div className="text-xs text-slate-400">{s.email}</div></td>
                    <td className="py-2.5 pr-3">{s.location}</td>
                    <td className="py-2.5 pr-3">{ROLE_LABELS[s.role]}</td>
                    <td className="py-2.5 pr-3 text-slate-600">{s.manager_name || '—'}</td>
                    <td className="py-2.5 pr-3"><span className={`rounded px-2 py-0.5 text-xs ${access.cls}`}>{access.text}</span></td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setEditing(s)}>Edit</button>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setAdjusting(s)}>Adjust balance</button>
                        {s.active && (
                          <button type="button" className="text-blue-600 hover:underline disabled:text-slate-400" disabled={Boolean(busy)} onClick={() => tempPassword(s)}>
                            {busy === `${s.id}:temp` ? 'Generating…' : 'Temp password'}
                          </button>
                        )}
                        {s.active && emailEnabled && (
                          <button type="button" className="text-blue-600 hover:underline disabled:text-slate-400" disabled={Boolean(busy)} onClick={() => setupEmail(s)}>
                            {busy === `${s.id}:setup` ? 'Sending…' : 'Send set-up email'}
                          </button>
                        )}
                        {s.id !== user.id && <button type="button" className="text-slate-500 hover:underline" onClick={() => toggleActive(s)}>{s.active ? 'Deactivate' : 'Reactivate'}</button>}
                        {s.id !== user.id && s.request_count === 0 && <button type="button" className="text-red-600 hover:underline" onClick={() => remove(s)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && types && (
        <StaffForm api={api} member={editing === 'new' ? null : editing} staff={staff} types={types} currentUserId={user.id}
          onClose={() => setEditing(null)} onSaved={(n) => { setEditing(null); setNotice(n); load(); }} />
      )}
      {adjusting && types && (
        <AdjustmentsModal api={api} member={adjusting} types={types} baseYear={baseYear} onClose={() => setAdjusting(null)} onChanged={load} />
      )}
      {tempResult && <TempPasswordModal result={tempResult} onClose={() => setTempResult(null)} />}
    </section>
  );
}
