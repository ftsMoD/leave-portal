// Date helpers. All leave dates are plain 'YYYY-MM-DD' strings and are
// handled in UTC so results never shift with the server's timezone.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function parseISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject impossible dates like 2026-02-31 (JS would roll them over).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

// Inclusive count of Mon–Fri between start and end.
// NOTE: public holidays are not excluded (see README → Known limitations).
function countBusinessDays(startDate, endDate) {
  let count = 0;
  for (let t = startDate.getTime(); t <= endDate.getTime(); t += DAY_MS) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function rangeLengthDays(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1;
}

module.exports = { parseISODate, toISODate, countBusinessDays, rangeLengthDays, MAX_RANGE_DAYS, DAY_MS };
