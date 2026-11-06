// In-memory store for demo / local development.
// On Vercel each function instance keeps its own copy and loses it on cold
// start, so this is NOT suitable for real use — set DATABASE_URL for that.

const bcrypt = require('bcryptjs');
const { toISODate, DAY_MS } = require('../dates');

const DEMO_PASSWORD = 'password123';

// Next Monday (UTC), so the seeded pending request is always in the future.
function nextMonday() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(today).getUTCDay();
  const daysAhead = ((8 - weekday) % 7) || 7;
  return new Date(today + daysAhead * DAY_MS);
}

function seed() {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const monday = nextMonday();
  const wednesday = new Date(monday.getTime() + 2 * DAY_MS);
  const now = new Date().toISOString();

  return {
    users: [
      { id: 1, email: 'employee@company.com', name: 'John Doe', role: 'employee', password_hash: hash, active: true },
      { id: 2, email: 'manager@company.com', name: 'Jane Smith', role: 'manager', password_hash: hash, active: true },
      { id: 3, email: 'alex@company.com', name: 'Alex Tan', role: 'employee', password_hash: hash, active: true },
    ],
    balances: [
      { id: 1, user_id: 1, leave_type: 'Vacation', total_days: 15, used_days: 3 },
      { id: 2, user_id: 1, leave_type: 'Sick', total_days: 10, used_days: 1 },
      { id: 3, user_id: 2, leave_type: 'Vacation', total_days: 18, used_days: 0 },
      { id: 4, user_id: 2, leave_type: 'Sick', total_days: 10, used_days: 0 },
      { id: 5, user_id: 3, leave_type: 'Vacation', total_days: 15, used_days: 0 },
      { id: 6, user_id: 3, leave_type: 'Sick', total_days: 10, used_days: 0 },
    ],
    requests: [
      {
        id: 1, user_id: 1, leave_type: 'Vacation',
        start_date: toISODate(monday), end_date: toISODate(wednesday), total_days: 3,
        reason: 'Family trip', status: 'Pending',
        decided_by: null, decided_at: null, created_at: now,
      },
    ],
    nextRequestId: 2,
  };
}

function createMemoryStore() {
  const db = seed();
  const clone = (o) => (o ? { ...o } : o);
  const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active } : null);
  const nameOf = (id) => db.users.find((u) => u.id === id)?.name ?? null;
  const withNames = (r) => (r ? { ...r, employee_name: nameOf(r.user_id), decided_by_name: r.decided_by ? nameOf(r.decided_by) : null } : null);
  const pendingFor = (userId, leaveType, excludeId) =>
    db.requests
      .filter((r) => r.user_id === userId && r.leave_type === leaveType && r.status === 'Pending' && r.id !== excludeId)
      .reduce((sum, r) => sum + r.total_days, 0);

  const tx = {
    async getBalanceForUpdate(userId, leaveType) {
      return clone(db.balances.find((b) => b.user_id === userId && b.leave_type === leaveType));
    },
    async pendingDays(userId, leaveType, excludeRequestId) {
      return pendingFor(userId, leaveType, excludeRequestId);
    },
    async hasOverlap(userId, start, end) {
      return db.requests.some(
        (r) => r.user_id === userId && ['Pending', 'Approved'].includes(r.status) && r.start_date <= end && r.end_date >= start
      );
    },
    async insertRequest(data) {
      const row = { id: db.nextRequestId++, ...data, status: 'Pending', decided_by: null, decided_at: null, created_at: new Date().toISOString() };
      db.requests.push(row);
      return withNames(row);
    },
    async getRequestForUpdate(id) {
      return clone(db.requests.find((r) => r.id === id));
    },
    async setRequestStatus(id, status, deciderId) {
      const row = db.requests.find((r) => r.id === id);
      row.status = status;
      row.decided_by = deciderId;
      row.decided_at = new Date().toISOString();
      return withNames(row);
    },
    async addUsedDays(balanceId, days) {
      db.balances.find((b) => b.id === balanceId).used_days += days;
    },
  };

  return {
    kind: 'memory',
    async findUserByEmail(email) {
      return clone(db.users.find((u) => u.email === email));
    },
    async getUserById(id) {
      return publicUser(db.users.find((u) => u.id === id));
    },
    async getPasswordHash(id) {
      return db.users.find((u) => u.id === id)?.password_hash ?? null;
    },
    async updatePasswordHash(id, hash) {
      db.users.find((u) => u.id === id).password_hash = hash;
    },
    async listBalances(userId) {
      return db.balances
        .filter((b) => b.user_id === userId)
        .map((b) => ({ ...b, pending_days: pendingFor(userId, b.leave_type) }));
    },
    async listRequests({ userId } = {}) {
      return db.requests
        .filter((r) => userId === undefined || r.user_id === userId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
        .map(withNames);
    },
    // Single-threaded: every check-then-write in a transaction runs without
    // interleaving, so no locking is needed here.
    async transaction(fn) {
      return fn(tx);
    },
  };
}

module.exports = { createMemoryStore, seed, DEMO_PASSWORD };
