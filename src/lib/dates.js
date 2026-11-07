// UI-side date helpers. The server recomputes working days authoritatively;
// this copy only powers the live preview in the apply form.

const DAY_MS = 24 * 60 * 60 * 1000;

function parse(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function countBusinessDays(startIso, endIso) {
  const start = parse(startIso);
  const end = parse(endIso);
  if (!start || !end || end < start) return 0;
  let count = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Mon 23 Nov" / "Mon 23 Nov 2026"
function label(d, withYear) {
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

export function formatDate(iso) {
  const d = parse(iso);
  return d ? label(d, true) : iso;
}

export function formatRange(startIso, endIso) {
  if (startIso === endIso) return formatDate(startIso);
  const s = parse(startIso);
  const e = parse(endIso);
  if (!s || !e) return `${startIso} – ${endIso}`;
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  return `${label(s, !sameYear)} – ${label(e, true)}`;
}

export function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export const yearOf = (iso) => Number(String(iso || '').slice(0, 4)) || null;

export function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
