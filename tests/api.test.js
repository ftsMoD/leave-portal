// API tests. Run: npm test
// Against Postgres instead of memory: TEST_DATABASE_URL=postgres://... npm test
//   (WARNING: drops and recreates the leave portal tables in that database.)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const app = require('../api/index.js');
const { setStore } = require('../server/store');
const { createMemoryStore, seed } = require('../server/store/memory');
const { DAY_MS, toISODate } = require('../server/dates');

let server;
let base;
let pgStore;

async function seedPostgres(url) {
  const { Client } = require('pg');
  const { createPostgresStore } = require('../server/store/postgres');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS leave_requests, leave_balances, users CASCADE');
  await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const data = seed();
  for (const u of data.users) {
    await client.query('INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [u.id, u.email, u.name, u.role, u.password_hash]);
  }
  for (const b of data.balances) {
    await client.query('INSERT INTO leave_balances (id, user_id, leave_type, total_days, used_days) VALUES ($1,$2,$3,$4,$5)', [b.id, b.user_id, b.leave_type, b.total_days, b.used_days]);
  }
  for (const r of data.requests) {
    await client.query('INSERT INTO leave_requests (id, user_id, leave_type, start_date, end_date, total_days, reason, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, r.user_id, r.leave_type, r.start_date, r.end_date, r.total_days, r.reason, r.status]);
  }
  await client.query("SELECT setval('users_id_seq', 100), setval('leave_balances_id_seq', 100), setval('leave_requests_id_seq', 100)");
  await client.end();
  return createPostgresStore(url);
}

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    pgStore = await seedPostgres(process.env.TEST_DATABASE_URL);
    setStore(pgStore);
  } else {
    setStore(createMemoryStore());
  }
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  if (pgStore) await pgStore.pool.end();
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const loginAs = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: 'password123' } })).data.token;

// Monday N weeks from the seeded request's week (seed uses next Monday).
function mondayInWeeks(n) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const wd = new Date(today).getUTCDay();
  const next = today + (((8 - wd) % 7) || 7) * DAY_MS;
  return next + n * 7 * DAY_MS;
}
const day = (t, offset = 0) => toISODate(new Date(t + offset * DAY_MS));

let emp, mgr, alex;

test('health reports storage backend', async () => {
  const { status, data } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.storage, process.env.TEST_DATABASE_URL ? 'postgres' : 'memory');
});

test('login rejects bad credentials and accepts good ones (case-insensitive email)', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'employee@company.com', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ghost@company.com', password: 'password123' } })).status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { email: 'Employee@Company.com ', password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'employee');
  assert.equal(ok.data.user.password_hash, undefined);
  emp = ok.data.token;
  mgr = await loginAs('manager@company.com');
  alex = await loginAs('alex@company.com');
});

test('protected routes require a valid token', async () => {
  assert.equal((await call('GET', '/api/leave/requests')).status, 401);
  assert.equal((await call('GET', '/api/leave/requests', { token: 'garbage' })).status, 401);
});

test('employees see only their own balances and requests', async () => {
  const bal = await call('GET', '/api/balances/me', { token: emp });
  assert.equal(bal.status, 200);
  const vacation = bal.data.find((b) => b.leave_type === 'Vacation');
  assert.equal(vacation.pending_days, 3);
  assert.equal((await call('GET', '/api/balances/2', { token: emp })).status, 403);
  assert.equal((await call('GET', '/api/balances/1', { token: mgr })).status, 200);

  const alexReqs = await call('GET', '/api/leave/requests', { token: alex });
  assert.deepEqual(alexReqs.data, []);
  const all = await call('GET', '/api/leave/requests', { token: mgr });
  assert.equal(all.data.length, 1);
  assert.equal(all.data[0].employee_name, 'John Doe');
});

test('apply: validates dates and computes working days server-side', async () => {
  const mon = mondayInWeeks(2);
  const sat = day(mon, 5), sun = day(mon, 6);
  assert.equal((await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Vacation', start_date: sat, end_date: sun } })).status, 400);
  assert.equal((await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Vacation', start_date: day(mon, 4), end_date: day(mon) } })).status, 400);
  assert.equal((await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Vacation', start_date: '2026-02-31', end_date: '2026-03-02' } })).status, 400);
  assert.equal((await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Unicorn', start_date: day(mon), end_date: day(mon) } })).status, 400);

  // Mon → next Mon spans a weekend: 6 working days. Client-sent total_days and user_id are ignored.
  const res = await call('POST', '/api/leave/apply', {
    token: emp,
    body: { user_id: 3, leave_type: 'Vacation', start_date: day(mon), end_date: day(mon, 7), total_days: 1, reason: 'Holiday' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.request.total_days, 6);
  assert.equal(res.data.request.user_id, 1);
  assert.equal(res.data.request.status, 'Pending');
});

test('apply: rejects overlaps and counts pending days against balance', async () => {
  const mon = mondayInWeeks(2);
  const overlap = await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Sick', start_date: day(mon, 2), end_date: day(mon, 2) } });
  assert.equal(overlap.status, 409);

  // Vacation: 15 total - 3 used - 3 pending - 6 pending = 3 available. Ask for 4.
  const later = mondayInWeeks(5);
  const tooMany = await call('POST', '/api/leave/apply', { token: emp, body: { leave_type: 'Vacation', start_date: day(later), end_date: day(later, 3) } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /3 available/);
});

test('approvals: role checks, no self-approval, balance deducted exactly once', async () => {
  const requests = (await call('GET', '/api/leave/requests', { token: mgr })).data;
  const target = requests.find((r) => r.user_id === 1 && r.total_days === 3);

  assert.equal((await call('PATCH', `/api/leave/requests/${target.id}`, { token: emp, body: { status: 'Approved' } })).status, 403);
  assert.equal((await call('PATCH', `/api/leave/requests/${target.id}`, { token: mgr, body: { status: 'Maybe' } })).status, 400);

  const approved = await call('PATCH', `/api/leave/requests/${target.id}`, { token: mgr, body: { status: 'Approved' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.request.decided_by_name, 'Jane Smith');
  assert.equal((await call('PATCH', `/api/leave/requests/${target.id}`, { token: mgr, body: { status: 'Approved' } })).status, 409);

  const vacation = (await call('GET', '/api/balances/me', { token: emp })).data.find((b) => b.leave_type === 'Vacation');
  assert.equal(vacation.used_days, 6);
  assert.equal(vacation.pending_days, 6);

  // Manager applies for own leave, then cannot approve it.
  const mon = mondayInWeeks(3);
  const own = await call('POST', '/api/leave/apply', { token: mgr, body: { leave_type: 'Vacation', start_date: day(mon), end_date: day(mon) } });
  assert.equal(own.status, 201);
  assert.equal((await call('PATCH', `/api/leave/requests/${own.data.request.id}`, { token: mgr, body: { status: 'Approved' } })).status, 403);
  const mine = await call('GET', '/api/leave/requests?scope=mine', { token: mgr });
  assert.ok(mine.data.every((r) => r.user_id === 2));
});

test('cancel: only the owner, only while pending', async () => {
  const requests = (await call('GET', '/api/leave/requests', { token: emp })).data;
  const pending = requests.find((r) => r.status === 'Pending');
  const approved = requests.find((r) => r.status === 'Approved');

  assert.equal((await call('PATCH', `/api/leave/requests/${pending.id}`, { token: alex, body: { status: 'Cancelled' } })).status, 403);
  assert.equal((await call('PATCH', `/api/leave/requests/${approved.id}`, { token: emp, body: { status: 'Cancelled' } })).status, 409);
  const ok = await call('PATCH', `/api/leave/requests/${pending.id}`, { token: emp, body: { status: 'Cancelled' } });
  assert.equal(ok.status, 200);
  const vacation = (await call('GET', '/api/balances/me', { token: emp })).data.find((b) => b.leave_type === 'Vacation');
  assert.equal(vacation.pending_days, 0);
  assert.equal((await call('PATCH', '/api/leave/requests/9999', { token: mgr, body: { status: 'Approved' } })).status, 404);
});

test('change password', async () => {
  assert.equal((await call('POST', '/api/auth/password', { token: alex, body: { current_password: 'wrong', new_password: 'newpassword1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: alex, body: { current_password: 'password123', new_password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: alex, body: { current_password: 'password123', new_password: 'newpassword1' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'alex@company.com', password: 'password123' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'alex@company.com', password: 'newpassword1' } })).status, 200);
});

test('concurrent applications cannot overdraw a balance', async () => {
  // Alex: Sick 10 days. Four simultaneous 3-day requests in different weeks → only 3 fit.
  const results = await Promise.all([6, 7, 8, 9].map((w) => {
    const mon = mondayInWeeks(w);
    return call('POST', '/api/leave/apply', { token: alex, body: { leave_type: 'Sick', start_date: day(mon), end_date: day(mon, 2) } });
  }));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 400]);
});

test('unknown routes and bad JSON', async () => {
  assert.equal((await call('GET', '/api/nope', { token: emp })).status, 404);
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
});

test('refuses to issue tokens without JWT_SECRET', async () => {
  delete process.env.JWT_SECRET;
  try {
    const res = await call('POST', '/api/auth/login', { body: { email: 'employee@company.com', password: 'password123' } });
    assert.equal(res.status, 500);
    assert.match(res.data.error, /JWT_SECRET/);
  } finally {
    process.env.JWT_SECRET = 'test-secret';
  }
});
