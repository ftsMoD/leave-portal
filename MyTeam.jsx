import { useCallback, useEffect, useState } from 'react';
import { BalanceMatrix, Toast, YearSelect } from '../components';

export default function MyTeam({ api, baseYear }) {
  const [year, setYear] = useState(baseYear);
  const [people, setPeople] = useState(null);
  const [types, setTypes] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api(`/balances?scope=team&year=${year}`), api('/leave-types')]);
      setPeople(p);
      setTypes(t);
    } catch (err) {
      if (err.status !== 401) setNotice({ type: 'error', message: err.message });
    }
  }, [api, year]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold text-slate-700">My direct reports</h3>
          <p className="text-xs text-slate-400">Days available / entitlement for {year}. Hover a cell for the breakdown.</p>
        </div>
        <YearSelect value={year} onChange={setYear} baseYear={baseYear} id="team-year" />
      </div>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      <BalanceMatrix people={people} types={types} />
    </section>
  );
}
