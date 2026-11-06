// Upserts users + leave entitlements from a JSON file.
// Usage: npm run db:seed            (reads db/seed.json)
//        npm run db:seed -- other.json
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { requireDatabaseUrl } = require('./env');

const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'db', 'seed.json'));

(async () => {
  if (!fs.existsSync(file)) throw new Error(`Seed file not found: ${file}\nCopy db/seed.example.json to db/seed.json first.`);
  const { users = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));

  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    for (const u of users) {
      const email = String(u.email || '').trim().toLowerCase();
      if (!email || !u.name || !['employee', 'manager'].includes(u.role)) {
        throw new Error(`Invalid user entry: ${JSON.stringify(u)}`);
      }

      const existing = (await client.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
      let userId;
      if (existing) {
        userId = existing.id;
        await client.query('UPDATE users SET name = $2, role = $3, active = $4 WHERE id = $1', [userId, u.name, u.role, u.active !== false]);
      } else {
        const password = u.password || crypto.randomBytes(9).toString('base64url');
        const hash = await bcrypt.hash(password, 10);
        userId = (await client.query(
          'INSERT INTO users (email, name, role, password_hash, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [email, u.name, u.role, hash, u.active !== false]
        )).rows[0].id;
        created.push({ email, password: u.password ? '(from seed file)' : password });
      }

      for (const [leaveType, totalDays] of Object.entries(u.balances || {})) {
        await client.query(
          `INSERT INTO leave_balances (user_id, leave_type, total_days) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, leave_type) DO UPDATE SET total_days = EXCLUDED.total_days`,
          [userId, leaveType, Number(totalDays)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }

  console.log(`Seeded ${users.length} user(s).`);
  if (created.length) {
    console.log('\nNew accounts — share temporary passwords securely and ask staff to change them after first login:');
    console.table(created);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
