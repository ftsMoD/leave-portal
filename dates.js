// Date helpers. Leave dates are plain 'YYYY-MM-DD' strings handled in UTC so
// results never shift with the server's timezone.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function parseISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

const toISODate = (date) => date.toISOString().slice(0, 10);

// Inclusive Mon–Fri count. Public holidays are booked as their own leave type.
function countBusinessDays(startDate, endDate) {
  let count = 0;
  for (let t = startDate.getTime(); t <= endDate.getTime(); t += DAY_MS) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

const rangeLengthDays = (startDate, endDate) => Math.round((endDate - startDate) / DAY_MS) + 1;

// Working days of [startIso, endIso] that fall inside calendar `year`.
function businessDaysInYear(startIso, endIso, year) {
  const s = parseISODate(startIso);
  const e = parseISODate(endIso);
  const from = new Date(Math.max(s.getTime(), Date.UTC(year, 0, 1)));
  const to = new Date(Math.min(e.getTime(), Date.UTC(year, 11, 31)));
  return to < from ? 0 : countBusinessDays(from, to);
}

function yearsSpanned(startIso, endIso) {
  const years = [];
  for (let y = Number(startIso.slice(0, 4)); y <= Number(endIso.slice(0, 4)); y += 1) years.push(y);
  return years;
}

// Today's date in the company timezone (default Singapore / Manila, UTC+8).
function todayIso(timeZone = process.env.COMPANY_TIMEZONE || 'Asia/Singapore') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const currentYear = () => Number(todayIso().slice(0, 4));

module.exports = {
  parseISODate, toISODate, countBusinessDays, rangeLengthDays, businessDaysInYear,
  yearsSpanned, todayIso, currentYear, MAX_RANGE_DAYS, DAY_MS,
};
