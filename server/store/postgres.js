// Postgres store. Works with any Postgres (Neon, Supabase, RDS, local).
// Use your provider's *pooled* connection string on Vercel.

const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids TZ drift).
types.setTypeParser(1082, (v) => v);

const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.name AS employee_name, r.leave_type,
         r.start_date, r.end_date, r.total_days, r.reason, r.status,
         r.decided_by, d.name AS decided_by_name, r.decided_at, r.created_at
  FROM leave_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users d ON d.id = r.decided_by`;

function createPostgresStore(connectionString) {
  // Small pool: each serverless instance only needs a couple of connections.
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });

  const one = async (client, sql, params) => (await client.query(sql, params)).rows[0] ?? null;

  const makeTx = (client) => ({
    getBalanceForUpdate(userId, leaveType) {
      return one(client,
        'SELECT id, user_id, leave_type, total_days, used_days FROM leave_balances WHERE user_id = $1 AND leave_type = $2 FOR UPDATE',
        [userId, leaveType]);
    },
    async pendingDays(userId, leaveType, excludeRequestId) {
      const row = await one(client,
        `SELECT COALESCE(SUM(total_days), 0)::int AS days FROM leave_requests
         WHERE user_id = $1 AND leave_type = $2 AND status = 'Pending' AND ($3::int IS NULL OR id <> $3)`,
        [userId, leaveType, excludeRequestId ?? null]);
      return row.days;
    },
    async hasOverlap(userId, start, end) {
      const row = await one(client,
        `SELECT 1 FROM leave_requests
         WHERE user_id = $1 AND status IN ('Pending', 'Approved') AND start_date <= $3 AND end_date >= $2 LIMIT 1`,
        [userId, start, end]);
      return Boolean(row);
    },
    async insertRequest({ user_id, leave_type, start_date, end_date, total_days, reason }) {
      const { id } = await one(client,
        `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, total_days, reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user_id, leave_type, start_date, end_date, total_days, reason]);
      return one(client, `${REQUEST_SELECT} WHERE r.id = $1`, [id]);
    },
    getRequestForUpdate(id) {
      return one(client, 'SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [id]);
    },
    async setRequestStatus(id, status, deciderId) {
      await client.query('UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [id, status, deciderId]);
      return one(client, `${REQUEST_SELECT} WHERE r.id = $1`, [id]);
    },
    async addUsedDays(balanceId, days) {
      await client.query('UPDATE leave_balances SET used_days = used_days + $2 WHERE id = $1', [balanceId, days]);
    },
  });

  return {
    kind: 'postgres',
    pool,
    findUserByEmail(email) {
      return one(pool, 'SELECT id, email, name, role, active, password_hash FROM users WHERE email = $1', [email]);
    },
    getUserById(id) {
      return one(pool, 'SELECT id, email, name, role, active FROM users WHERE id = $1', [id]);
    },
    async getPasswordHash(id) {
      const row = await one(pool, 'SELECT password_hash FROM users WHERE id = $1', [id]);
      return row?.password_hash ?? null;
    },
    async updatePasswordHash(id, hash) {
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
    },
    async listBalances(userId) {
      const { rows } = await pool.query(
        `SELECT b.id, b.user_id, b.leave_type, b.total_days, b.used_days,
                COALESCE((SELECT SUM(r.total_days) FROM leave_requests r
                          WHERE r.user_id = b.user_id AND r.leave_type = b.leave_type AND r.status = 'Pending'), 0)::int AS pending_days
         FROM leave_balances b WHERE b.user_id = $1 ORDER BY b.leave_type`,
        [userId]);
      return rows;
    },
    async listRequests({ userId } = {}) {
      const { rows } = userId === undefined
        ? await pool.query(`${REQUEST_SELECT} ORDER BY r.created_at DESC, r.id DESC`)
        : await pool.query(`${REQUEST_SELECT} WHERE r.user_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [userId]);
      return rows;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(makeTx(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createPostgresStore };
