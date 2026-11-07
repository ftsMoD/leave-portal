// API tests. Run: npm test   (uses PGlite in memory with the fictional demo data)
// Against real Postgres: TEST_DATABASE_URL=postgres://... npm test
//   WARNING: drops and recreates the leave portal tables in that database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.JWT_SECRET = 'test-secret';
process.env.APP_URL = 'https://leave.example.test';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const app = require('../api/index.js');
const { setDb, createPgDriver, createPgliteDriver, SCHEMA_PATH } = require('../server/db');
const { seedDemo } = require('../server/demo');
const { setTestTransport } = require('../server/mailer');
const { businessDaysInYear, currentYear } = require('../server/dates');

const sent = [];
let server;
let base;
let driver;

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    driver = createPgDriver(process.env.TEST_DATABASE_URL);
    await driver.query('DROP TABLE IF EXISTS audit_log, password_tokens, leave_requests, balance_adjustments, entitlements, users, leave_types CASCADE');
    await driver.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    await seedDemo(driver);
  } else {
    driver = await createPgliteDriver({ demo: true });
  }
  setDb(driver);
  setTestTransport({ sendMail: async (m) => { sent.push(m); return { messageId: String(sent.length) }; } });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await driver.end();
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (email, password = 'password123') => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;
const apply = (token, body) => call('POST', '/api/requests', { token, body });

// Monday of ISO-ish week n in 2027 (2027-01-04 is a Monday).
const mon2027 = (week, plus = 0) => new Date(Date.UTC(2027, 0, 4 + week * 7 + plus)).toISOString().slice(0, 10);

const T = {};

test('health reports database and email status', async () => {
  const { data } = await call('GET', '/api/health');
  assert.equal(data.database, process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite');
  assert.equal(data.email, true);
  assert.equal(data.app_url, true);
});

test('login + roles', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'nope' } })).status, 401);
  const res = await call('POST', '/api/auth/login', { body: { email: ' Admin@Example.com', password: 'password123' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, 'admin');
  assert.equal(res.data.user.password_hash, undefined);
  T.admin = res.data.token; // Hannah, PH, manager Marcus
  T.marcus = await login('ceo@example.com'); // approver, SG
  T.priya = await login('coo@example.com'); // approver, SG
  T.daniel = await login('employee@example.com'); // user, SG, manager Marcus
  T.carlo = await login('dev@example.com'); // user, PH, manager Priya
});

test('leave options apply N/A + Singapore-only childcare rule', async () => {
  const carlo = (await call('GET', '/api/my/leave-options', { token: T.carlo })).data.map((o) => o.leave_type);
  const daniel = (await call('GET', '/api/my/leave-options', { token: T.daniel })).data;
  assert.ok(!carlo.includes('Childcare Leave'));
  assert.ok(daniel.some((o) => o.leave_type === 'Childcare Leave'));
  assert.equal(daniel.find((o) => o.leave_type === 'Unpaid Leave').unlimited, true);

  const r = await apply(T.carlo, { leave_type: 'Childcare Leave', start_date: mon2027(1), end_date: mon2027(1) });
  assert.equal(r.status, 400);

  // Moving Daniel to the Philippines hides childcare even though the entitlement row exists.
  const staff = (await call('GET', '/api/admin/staff', { token: T.admin })).data;
  const danielId = staff.find((s) => s.email === 'employee@example.com').id;
  T.danielId = danielId;
  await call('PUT', `/api/admin/staff/${danielId}`, { token: T.admin, body: { location: 'Philippines' } });
  assert.ok(!(await call('GET', '/api/my/leave-options', { token: T.daniel })).data.some((o) => o.leave_type === 'Childcare Leave'));
  await call('PUT', `/api/admin/staff/${danielId}`, { token: T.admin, body: { location: 'Singapore' } });
});

test('unlimited leave requires a note; request routes to line manager by email', async () => {
  sent.length = 0;
  assert.equal((await apply(T.daniel, { leave_type: 'Other Leave', start_date: mon2027(2), end_date: mon2027(2) })).status, 400);
  const r = await apply(T.daniel, { leave_type: 'Other Leave', details: 'Bereavement', start_date: mon2027(2), end_date: mon2027(2, 1), reason: 'Family' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.request.total_days, 2);
  assert.equal(r.data.email, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ceo@example.com']);
  assert.match(sent[0].text, /Bereavement/);
  assert.match(sent[0].text, new RegExp(`https://leave.example.test/\\?view=approvals&request=${r.data.request.id}`));
  T.danielOther = r.data.request.id;
});

test('visibility: users see only their own data; approvers see direct reports', async () => {
  assert.equal((await call('GET', '/api/balances?scope=team', { token: T.daniel })).status, 403);
  assert.equal((await call('GET', '/api/requests?scope=all', { token: T.daniel })).status, 403);
  assert.equal((await call('GET', '/api/requests?scope=approvals', { token: T.daniel })).status, 403);
  const mine = (await call('GET', '/api/requests', { token: T.daniel })).data;
  assert.ok(mine.every((r) => r.employee_name === 'Daniel Ong'));

  const marcusTeam = (await call('GET', '/api/balances?scope=team', { token: T.marcus })).data.map((p) => p.name).sort();
  assert.deepEqual(marcusTeam, ['Daniel Ong', 'Hannah Reyes', 'Priya Nair']);
  const priyaQueue = (await call('GET', '/api/requests?scope=approvals', { token: T.priya })).data;
  assert.ok(priyaQueue.every((r) => ['Carlo Santos', 'Marcus Lee'].includes(r.employee_name)));
  assert.equal((await call('GET', '/api/balances?scope=all', { token: T.marcus })).status, 403);
});

test('approval: only line manager or HR admin; decision emails the employee', async () => {
  assert.equal((await call('PATCH', `/api/requests/${T.danielOther}`, { token: T.priya, body: { status: 'Approved' } })).status, 403);
  assert.equal((await call('PATCH', `/api/requests/${T.danielOther}`, { token: T.daniel, body: { status: 'Approved' } })).status, 403);
  sent.length = 0;
  const ok = await call('PATCH', `/api/requests/${T.danielOther}`, { token: T.marcus, body: { status: 'Approved', note: 'Take care' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.request.decided_by_name, 'Marcus Lee');
  assert.deepEqual(sent[0].to, ['employee@example.com']);
  assert.match(sent[0].subject, /approved/);
  assert.equal((await call('PATCH', `/api/requests/${T.danielOther}`, { token: T.marcus, body: { status: 'Rejected' } })).status, 409);

  // HR admin can approve someone who isn't their direct report (line manager unavailable).
  const c = await apply(T.carlo, { leave_type: 'Annual Leave', start_date: mon2027(3), end_date: mon2027(3, 4) });
  assert.equal(c.status, 201);
  assert.deepEqual(sent.at(-1).to, ['coo@example.com']);
  const byHr = await call('PATCH', `/api/requests/${c.data.request.id}`, { token: T.admin, body: { status: 'Rejected', note: 'Clashes with audit' } });
  assert.equal(byHr.status, 200);
  assert.match(sent.at(-1).subject, /rejected/);
});

test('nobody approves their own leave, including the HR admin', async () => {
  const h = await apply(T.admin, { leave_type: 'Annual Leave', start_date: mon2027(4), end_date: mon2027(4) });
  assert.equal(h.status, 201);
  assert.deepEqual(sent.at(-1).to, ['ceo@example.com']); // Hannah's line manager
  assert.equal((await call('PATCH', `/api/requests/${h.data.request.id}`, { token: T.admin, body: { status: 'Approved' } })).status, 403);
  assert.equal((await call('PUT', `/api/admin/requests/${h.data.request.id}`, { token: T.admin, body: { status: 'Approved' } })).status, 403);
  assert.equal((await call('PATCH', `/api/requests/${h.data.request.id}`, { token: T.marcus, body: { status: 'Approved' } })).status, 200);
});

test('balances: limits, pending counted, per-year split, adjustments', async () => {
  // Carlo: Sick 7/yr. 8 working days → rejected.
  assert.equal((await apply(T.carlo, { leave_type: 'Sick Leave', start_date: mon2027(6), end_date: mon2027(7, 2) })).status, 400);

  // Annual across New Year 2027 → 2028 is split by calendar year.
  const start = '2027-12-29';
  const end = '2028-01-04';
  const r = await apply(T.carlo, { leave_type: 'Annual Leave', start_date: start, end_date: end });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const y27 = (await call('GET', '/api/balances?year=2027', { token: T.carlo })).data[0].balances.find((b) => b.leave_type === 'Annual Leave');
  const y28 = (await call('GET', '/api/balances?year=2028', { token: T.carlo })).data[0].balances.find((b) => b.leave_type === 'Annual Leave');
  assert.equal(y27.pending, businessDaysInYear(start, end, 2027));
  assert.equal(y28.pending, businessDaysInYear(start, end, 2028));
  assert.equal(y28.available, 12 - y28.pending); // fresh entitlement on 1 Jan, no carry-forward

  // Admin deducts 3 days of 2027 Annual Leave taken before go-live.
  const carloId = (await call('GET', '/api/admin/staff', { token: T.admin })).data.find((s) => s.email === 'dev@example.com').id;
  T.carloId = carloId;
  const adj = await call('POST', '/api/admin/adjustments', { token: T.admin, body: { user_id: carloId, leave_type: 'Annual Leave', year: 2027, days: -3, reason: 'Taken before portal launch' } });
  assert.equal(adj.status, 201);
  const after = (await call('GET', '/api/balances?year=2027', { token: T.carlo })).data[0].balances.find((b) => b.leave_type === 'Annual Leave');
  assert.equal(after.adjustment, -3);
  assert.equal(after.available, y27.available - 3);
  assert.equal((await call('POST', '/api/admin/adjustments', { token: T.admin, body: { user_id: carloId, leave_type: 'Unpaid Leave', year: 2027, days: 2, reason: 'x y z' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/adjustments', { token: T.carlo, body: { user_id: carloId, leave_type: 'Annual Leave', year: 2027, days: 5, reason: 'self-serve' } })).status, 403);
});

test('concurrent requests cannot overdraw a balance', async () => {
  // Carlo: Sick 7 in 2027. Three simultaneous 3-day requests → only two fit.
  const results = await Promise.all([10, 11, 12].map((w) => apply(T.carlo, { leave_type: 'Sick Leave', start_date: mon2027(w), end_date: mon2027(w, 2) })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 400]);
});

test('overlaps rejected; owner can cancel only pending', async () => {
  const a = await apply(T.daniel, { leave_type: 'Annual Leave', start_date: mon2027(20), end_date: mon2027(20, 2) });
  assert.equal(a.status, 201);
  assert.equal((await apply(T.daniel, { leave_type: 'Sick Leave', start_date: mon2027(20, 1), end_date: mon2027(20, 1) })).status, 409);
  assert.equal((await call('PATCH', `/api/requests/${a.data.request.id}`, { token: T.carlo, body: { status: 'Cancelled' } })).status, 403);
  assert.equal((await call('PATCH', `/api/requests/${a.data.request.id}`, { token: T.daniel, body: { status: 'Cancelled' } })).status, 200);
  assert.equal((await call('PATCH', `/api/requests/${T.danielOther}`, { token: T.daniel, body: { status: 'Cancelled' } })).status, 409);
});

test('admin can add, edit and delete any leave entry', async () => {
  const created = await call('POST', '/api/admin/requests', { token: T.admin, body: { user_id: T.carloId, leave_type: 'Public Holiday', start_date: mon2027(15), end_date: mon2027(15), status: 'Approved' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.request.status, 'Approved');
  const id = created.data.request.id;

  const edited = await call('PUT', `/api/admin/requests/${id}`, { token: T.admin, body: { end_date: mon2027(15, 1), details: '', reason: 'Two local holidays' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.request.total_days, 2);
  assert.equal((await call('PUT', `/api/admin/requests/${id}`, { token: T.marcus, body: { reason: 'x' } })).status, 403);
  assert.equal((await call('DELETE', `/api/admin/requests/${id}`, { token: T.admin })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/requests/${id}`, { token: T.admin })).status, 404);
});

test('staff admin: create, temp password, forced change, setup email + reset', async () => {
  // Line manager must be an approver/admin.
  const bad = await call('POST', '/api/admin/staff', { token: T.admin, body: { name: 'New Person', email: 'new@example.com', location: 'Vietnam', role: 'user', manager_id: T.carloId, entitlements: {} } });
  assert.equal(bad.status, 400);

  const priyaId = (await call('GET', '/api/admin/staff', { token: T.admin })).data.find((s) => s.email === 'coo@example.com').id;
  const created = await call('POST', '/api/admin/staff', {
    token: T.admin,
    body: { name: 'New Person', email: 'New@Example.com', location: 'Vietnam', role: 'user', manager_id: priyaId,
      entitlements: { 'Annual Leave': 12, 'Sick Leave': 7, 'Childcare Leave': 'na', 'Unpaid Leave': 'unlimited' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const newId = created.data.id;
  assert.equal((await call('POST', '/api/admin/staff', { token: T.admin, body: { name: 'Dup', email: 'new@example.com', location: 'X', role: 'user' } })).status, 409);

  // No password yet → cannot log in.
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'anything12' } })).status, 401);

  const temp = await call('POST', `/api/admin/staff/${newId}/temp-password`, { token: T.admin });
  assert.equal(temp.status, 200);
  const tok = await login('new@example.com', temp.data.password);
  assert.equal((await call('GET', '/api/balances', { token: tok })).status, 403); // must change first
  assert.equal((await call('GET', '/api/auth/me', { token: tok })).data.user.must_change_password, true);
  assert.equal((await call('POST', '/api/auth/password', { token: tok, body: { current_password: temp.data.password, new_password: 'short' } })).status, 400);
  const changed = await call('POST', '/api/auth/password', { token: tok, body: { current_password: temp.data.password, new_password: 'a-much-longer-pass' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/api/balances', { token: tok })).status, 401); // old token revoked
  const opts = (await call('GET', '/api/my/leave-options', { token: changed.data.token })).data.map((o) => o.leave_type);
  assert.deepEqual(opts, ['Annual Leave', 'Sick Leave', 'Unpaid Leave']);

  // Set-up email → link → reset.
  sent.length = 0;
  assert.equal((await call('POST', `/api/admin/staff/${newId}/setup-email`, { token: T.admin })).status, 200);
  const link = sent[0].text.match(/\?reset=([\w-]+)/);
  assert.ok(link, 'reset link in email');
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: link[1], new_password: 'brand-new-password' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: link[1], new_password: 'brand-new-password' } })).status, 400); // single use
  assert.equal((await call('GET', '/api/balances', { token: changed.data.token })).status, 401);
  assert.ok(await login('new@example.com', 'brand-new-password'));

  // Forgot password: same response for unknown emails, and no email for them.
  sent.length = 0;
  const known = await call('POST', '/api/auth/forgot', { body: { email: 'new@example.com' } });
  const unknown = await call('POST', '/api/auth/forgot', { body: { email: 'ghost@example.com' } });
  assert.equal(known.data.message, unknown.data.message);
  assert.equal(sent.length, 1);

  // Deactivate → session dies. No requests → can be deleted.
  const t2 = await login('new@example.com', 'brand-new-password');
  await call('PUT', `/api/admin/staff/${newId}`, { token: T.admin, body: { active: false } });
  assert.equal((await call('GET', '/api/balances', { token: t2 })).status, 401);
  assert.equal((await call('DELETE', `/api/admin/staff/${newId}`, { token: T.admin })).status, 200);
  // Staff with history can't be deleted (deactivate instead).
  assert.equal((await call('DELETE', `/api/admin/staff/${T.carloId}`, { token: T.admin })).status, 409);
});

test('admin guard rails', async () => {
  const me = (await call('GET', '/api/auth/me', { token: T.admin })).data.user;
  assert.equal((await call('PUT', `/api/admin/staff/${me.id}`, { token: T.admin, body: { role: 'user' } })).status, 400);
  assert.equal((await call('PUT', `/api/admin/staff/${me.id}`, { token: T.admin, body: { active: false } })).status, 400);
  assert.equal((await call('DELETE', `/api/admin/staff/${me.id}`, { token: T.admin })).status, 400);
  assert.equal((await call('GET', '/api/admin/staff', { token: T.marcus })).status, 403);
});

test('reports and CSV exports (with formula-injection guard)', async () => {
  const r = await apply(T.daniel, { leave_type: 'Annual Leave', start_date: mon2027(30), end_date: mon2027(30), reason: '=HYPERLINK("http://evil")' });
  assert.equal(r.status, 201);
  const csv = await call('GET', '/api/export/my-requests.csv?year=2027', { token: T.daniel });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /my-leave-history-2027\.csv/);
  assert.match(csv.data, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  assert.ok(!csv.data.includes('Carlo'));

  const bal = await call('GET', '/api/export/my-balances.csv?year=2027', { token: T.daniel });
  assert.match(bal.data, /Annual Leave/);
  assert.equal((await call('GET', '/api/export/balances.csv', { token: T.daniel })).status, 403);
  const all = await call('GET', '/api/export/balances.csv?year=2027', { token: T.admin });
  assert.match(all.data, /Carlo Santos/);
  assert.match((await call('GET', '/api/export/staff.csv', { token: T.admin })).data, /Childcare Leave/);
  assert.match((await call('GET', '/api/export/activity.csv', { token: T.admin })).data, /approved/);

  const summary = await call('GET', '/api/admin/reports/summary', { token: T.admin });
  assert.equal(summary.status, 200);
  assert.equal(typeof summary.data.pending_count, 'number');
  assert.ok(summary.data.activity.length > 5);
  assert.equal(summary.data.today.slice(0, 4), String(currentYear()));
});

test('account lockout after 5 failed attempts', async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'coo@example.com', password: 'wrong-password' } })).status, 401);
  }
  const locked = await call('POST', '/api/auth/login', { body: { email: 'coo@example.com', password: 'password123' } });
  assert.equal(locked.status, 429);
});

test('bad input, unknown routes, missing JWT secret', async () => {
  assert.equal((await call('GET', '/api/nope', { token: T.daniel })).status, 404);
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await apply(T.daniel, { leave_type: 'Annual Leave', start_date: '2027-02-31', end_date: '2027-03-01' })).status, 400);
  assert.equal((await apply(T.daniel, { leave_type: 'Annual Leave', start_date: mon2027(40, 5), end_date: mon2027(40, 6) })).status, 400);
  delete process.env.JWT_SECRET;
  try {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'employee@example.com', password: 'password123' } })).status, 500);
  } finally {
    process.env.JWT_SECRET = 'test-secret';
  }
});
