// Fictional demo data for local development (PGlite). Never used when DATABASE_URL is set.

const bcrypt = require('bcryptjs');
const { todayIso, DAY_MS } = require('./dates');

const DEMO_PASSWORD = 'password123';

const LEAVE_TYPES = [
  ['Annual Leave', 1, null],
  ['Public Holiday', 2, null],
  ['Sick Leave', 3, null],
  ['Childcare Leave', 4, 'Singapore'],
  ['Unpaid Leave', 5, null],
  ['Other Leave', 6, null],
];

// [email, name, location, role, managerEmail, annual, ph, sick, childcare|null]
const PEOPLE = [
  ['admin@example.com', 'Hannah Reyes', 'Philippines', 'admin', 'ceo@example.com', 12, 11, 7, null],
  ['ceo@example.com', 'Marcus Lee', 'Singapore', 'approver', 'coo@example.com', 12, 11, 14, 2],
  ['coo@example.com', 'Priya Nair', 'Singapore', 'approver', 'ceo@example.com', 12, 11, 14, 2],
  ['employee@example.com', 'Daniel Ong', 'Singapore', 'user', 'ceo@example.com', 12, 11, 14, 2],
  ['dev@example.com', 'Carlo Santos', 'Philippines', 'user', 'coo@example.com', 12, 11, 7, null],
];

function nextMonday() {
  const t = Date.parse(`${todayIso()}T00:00:00Z`);
  const wd = new Date(t).getUTCDay();
  return t + ((((8 - wd) % 7) || 7) * DAY_MS);
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);

async function seedDemo(db) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  await db.transaction(async (q) => {
    for (const [name, order, loc] of LEAVE_TYPES) {
      await q('INSERT INTO leave_types (name, sort_order, location_only) VALUES ($1, $2, $3)', [name, order, loc]);
    }
    for (const [email, name, location, role] of PEOPLE) {
      await q('INSERT INTO users (email, name, location, role, password_hash) VALUES ($1, $2, $3, $4, $5)', [email, name, location, role, hash]);
    }
    for (const [email, , , , manager, annual, ph, sick, childcare] of PEOPLE) {
      const { id } = (await q('UPDATE users SET manager_id = (SELECT id FROM users WHERE email = $2) WHERE email = $1 RETURNING id', [email, manager])).rows[0];
      const ents = { 'Annual Leave': annual, 'Public Holiday': ph, 'Sick Leave': sick, 'Unpaid Leave': null, 'Other Leave': null };
      if (childcare !== null) ents['Childcare Leave'] = childcare;
      for (const [type, days] of Object.entries(ents)) {
        await q('INSERT INTO entitlements (user_id, leave_type, days_per_year) VALUES ($1, $2, $3)', [id, type, days]);
      }
    }
    const mon = nextMonday();
    const daniel = (await q("SELECT id, manager_id FROM users WHERE email = 'employee@example.com'")).rows[0];
    await q(
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, total_days, reason, approver_id, created_by)
       VALUES ($1, 'Annual Leave', $2, $3, 3, 'Family trip', $4, $1)`,
      [daniel.id, iso(mon), iso(mon + 2 * DAY_MS), daniel.manager_id]);
    await q("INSERT INTO audit_log (actor_name, action, summary) VALUES ('System', 'demo.seeded', 'Demo data loaded')");
  });
}

module.exports = { seedDemo, DEMO_PASSWORD };
