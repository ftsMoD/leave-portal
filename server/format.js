// Human-readable date labels for emails and the activity log.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(iso, withYear = true) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const base = `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
  return withYear ? `${base} ${y}` : base;
}

function formatRange(startIso, endIso) {
  if (startIso === endIso) return label(startIso);
  return `${label(startIso, startIso.slice(0, 4) !== endIso.slice(0, 4))} – ${label(endIso)}`;
}

const describeRequest = (r) =>
  `${r.leave_type}${r.details ? ` (${r.details})` : ''}, ${formatRange(r.start_date, r.end_date)}, ${r.total_days} day${r.total_days === 1 ? '' : 's'}`;

module.exports = { formatRange, describeRequest };
