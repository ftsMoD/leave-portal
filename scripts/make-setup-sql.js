// Generates a one-paste SQL file (schema + leave types + staff + entitlements) for a
// database SQL editor such as Neon's — no Node.js needed on the person running it.
//
// Usage: node scripts/make-setup-sql.js staff.json > setup.sql
// The admin's temporary password is printed to stderr (they must change it at first sign-in).
// Re-running the output is safe: it updates staff/entitlements and never resets an existing password.
//
// staff.json:
// {
//   "admin_email": "hr@company.com",
//   "leave_types": [{ "name": "Annual Leave" }, { "name": "Childcare Leave", "location_only": "Singapore" }],
//   "staff": [{ "name": "…", "email": "…", "location": "…", "role": "user|approver|admin",
//               "manager_email": "…", "entitlements": { "Annual Leave": 12, "Childcare Leave": "N/A", "Unpaid Leave": "Unlimited" } }]
// }

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/make-setup-sql.js staff.json > setup.sql');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const userId = (email) => `(SELECT id FROM users WHERE email = ${lit(email)})`;

const ROLES = ['user', 'approver', 'admin'];
const typeNames = cfg.leave_types.map((t) => t.name);
const emails = new Set();
for (const s of cfg.staff) {
  s.email = s.email.trim().toLowerCase();
  s.name = s.name.trim();
  if (!ROLES.includes(s.role)) throw new Error(`Bad role for ${s.name}: ${s.role}`);
  if (emails.has(s.email)) throw new Error(`Duplicate email ${s.email}`);
  emails.add(s.email);
  for (const t of Object.keys(s.entitlements)) if (!typeNames.includes(t)) throw new Error(`Unknown leave type "${t}" for ${s.name}`);
}
for (const s of cfg.staff) {
  if (s.manager_email && !emails.has(s.manager_email.toLowerCase())) throw new Error(`${s.name}: manager ${s.manager_email} not in staff list`);
  const m = cfg.staff.find((x) => x.email === s.manager_email?.toLowerCase());
  if (m && m.role === 'user') throw new Error(`${s.name}'s manager ${m.name} must be an approver or admin`);
}
const admin = cfg.staff.find((s) => s.email === cfg.admin_email.toLowerCase());
if (!admin || admin.role !== 'admin') throw new Error('admin_email must belong to a staff member with role "admin"');

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const tempPassword = Array.from({ length: 14 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
const hash = bcrypt.hashSync(tempPassword, 10);

const out = [];
out.push(`-- Leave Portal setup — generated ${new Date().toISOString().slice(0, 10)}`);
out.push('-- Paste this whole file into your database SQL editor and run it once. Safe to re-run.');
out.push('', '-- 1. Tables', fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8').trim(), '');

out.push('-- 2. Leave types');
cfg.leave_types.forEach((t, i) => {
  out.push(`INSERT INTO leave_types (name, sort_order, location_only) VALUES (${lit(t.name)}, ${i + 1}, ${lit(t.location_only ?? null)})
  ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order, location_only = EXCLUDED.location_only;`);
});

out.push('', '-- 3. Staff');
for (const s of cfg.staff) {
  out.push(`INSERT INTO users (email, name, location, role) VALUES (${lit(s.email)}, ${lit(s.name)}, ${lit(s.location)}, ${lit(s.role)})
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, location = EXCLUDED.location, role = EXCLUDED.role;`);
}

out.push('', '-- 4. Line managers (leave approvers)');
for (const s of cfg.staff) {
  out.push(`UPDATE users SET manager_id = ${s.manager_email ? userId(s.manager_email.toLowerCase()) : 'NULL'} WHERE email = ${lit(s.email)};`);
}

out.push('', '-- 5. Entitlements (days per calendar year; NULL = Unlimited; N/A = no row)');
for (const s of cfg.staff) {
  const na = [];
  for (const t of typeNames) {
    const v = s.entitlements[t];
    if (v === undefined || v === null || String(v).toUpperCase() === 'N/A') { na.push(t); continue; }
    const days = String(v).toLowerCase() === 'unlimited' ? null : Number(v);
    if (days !== null && (!Number.isInteger(days) || days < 0)) throw new Error(`${s.name} ${t}: ${v}`);
    out.push(`INSERT INTO entitlements (user_id, leave_type, days_per_year) VALUES (${userId(s.email)}, ${lit(t)}, ${lit(days)})
  ON CONFLICT (user_id, leave_type) DO UPDATE SET days_per_year = EXCLUDED.days_per_year;`);
  }
  if (na.length) out.push(`DELETE FROM entitlements WHERE user_id = ${userId(s.email)} AND leave_type IN (${na.map(lit).join(', ')});`);
}

out.push('', `-- 6. First sign-in for the administrator (${admin.email}). Only applies if no password is set yet.`);
out.push(`UPDATE users SET password_hash = ${lit(hash)}, must_change_password = TRUE WHERE email = ${lit(admin.email)} AND password_hash IS NULL;`);
out.push(`INSERT INTO audit_log (actor_name, action, summary) VALUES ('System', 'setup', ${lit(`Staff list loaded (${cfg.staff.length} people)`)});`);

out.push('', '-- 7. Check: should list everyone with their line manager');
out.push(`SELECT u.name, u.email, u.location, u.role, m.name AS line_manager, (u.password_hash IS NOT NULL) AS can_sign_in
FROM users u LEFT JOIN users m ON m.id = u.manager_id ORDER BY u.name;`);

process.stdout.write(`${out.join('\n')}\n`);
console.error(`Temporary password for ${admin.email}: ${tempPassword}`);
