// Admin: staff accounts, entitlements and balance adjustments.

const { httpError } = require('./errors');
const { audit } = require('./audit');

const ROLES = ['user', 'approver', 'admin'];
const ROLE_LABELS = { user: 'User', approver: 'Approver', admin: 'Administrator' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const one = async (q, text, params) => (await q(text, params)).rows[0] ?? null;

async function listLeaveTypes(q) {
  return (await q('SELECT name, sort_order, location_only FROM leave_types ORDER BY sort_order, name')).rows;
}

async function listStaff(db) {
  const [users, ents] = await Promise.all([
    db.query(`SELECT u.id, u.email, u.name, u.location, u.role, u.manager_id, m.name AS manager_name, u.active,
                     (u.password_hash IS NOT NULL) AS has_password, u.must_change_password,
                     COALESCE(u.locked_until > now(), FALSE) AS locked,
                     (SELECT COUNT(*)::int FROM leave_requests r WHERE r.user_id = u.id) AS request_count
              FROM users u LEFT JOIN users m ON m.id = u.manager_id
              ORDER BY u.active DESC, u.name`),
    db.query('SELECT user_id, leave_type, days_per_year FROM entitlements'),
  ]);
  const byUser = new Map();
  for (const e of ents.rows) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, {});
    byUser.get(e.user_id)[e.leave_type] = e.days_per_year === null ? 'unlimited' : e.days_per_year;
  }
  return users.rows.map((u) => ({ ...u, entitlements: byUser.get(u.id) || {} }));
}

// entitlements: { "Annual Leave": 12, "Unpaid Leave": "unlimited", "Childcare Leave": "na" }
function parseEntitlements(raw, typeNames) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw httpError(400, 'Invalid entitlements.');
  const out = {};
  for (const [type, value] of Object.entries(raw)) {
    if (!typeNames.includes(type)) throw httpError(400, `Unknown leave type: ${type}`);
    if (value === 'na' || value === null || value === '') continue;
    if (value === 'unlimited') { out[type] = null; continue; }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 366) throw httpError(400, `${type}: days must be a whole number between 0 and 366.`);
    out[type] = n;
  }
  return out;
}

function parseStaffInput(body = {}, typeNames, { partial = false } = {}) {
  const out = {};
  const need = (field) => !partial || body[field] !== undefined;

  if (need('name')) {
    out.name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!out.name || out.name.length > 100) throw httpError(400, 'Name is required (max 100 characters).');
  }
  if (need('email')) {
    out.email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(out.email) || out.email.length > 200) throw httpError(400, 'A valid email is required.');
  }
  if (need('location')) {
    out.location = typeof body.location === 'string' ? body.location.trim() : '';
    if (!out.location || out.location.length > 60) throw httpError(400, 'Location is required.');
  }
  if (need('role')) {
    if (!ROLES.includes(body.role)) throw httpError(400, 'Role must be User, Approver or Administrator.');
    out.role = body.role;
  }
  if (body.manager_id !== undefined) {
    out.manager_id = body.manager_id === null || body.manager_id === '' ? null : Number(body.manager_id);
    if (out.manager_id !== null && !Number.isInteger(out.manager_id)) throw httpError(400, 'Invalid line manager.');
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  out.entitlements = parseEntitlements(body.entitlements, typeNames);
  return out;
}

async function assertValidManager(q, managerId, selfId) {
  if (managerId === null || managerId === undefined) return null;
  if (managerId === selfId) throw httpError(400, 'Someone cannot be their own line manager.');
  const m = await one(q, 'SELECT id, name, role, active FROM users WHERE id = $1', [managerId]);
  if (!m || !m.active) throw httpError(400, 'Line manager not found or inactive.');
  if (!['approver', 'admin'].includes(m.role)) {
    throw httpError(400, `${m.name} needs the Approver or Administrator role to be a line manager.`);
  }
  return m;
}

async function writeEntitlements(q, userId, entitlements) {
  await q('DELETE FROM entitlements WHERE user_id = $1', [userId]);
  for (const [type, days] of Object.entries(entitlements)) {
    await q('INSERT INTO entitlements (user_id, leave_type, days_per_year) VALUES ($1, $2, $3)', [userId, type, days]);
  }
}

async function createStaff(db, actor, body) {
  const typeNames = (await listLeaveTypes(db.query)).map((t) => t.name);
  const input = parseStaffInput(body, typeNames);
  return db.transaction(async (q) => {
    if (await one(q, 'SELECT 1 FROM users WHERE email = $1', [input.email])) throw httpError(409, 'A staff member with this email already exists.');
    await assertValidManager(q, input.manager_id ?? null, null);
    const { id } = await one(q,
      'INSERT INTO users (email, name, location, role, manager_id, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [input.email, input.name, input.location, input.role, input.manager_id ?? null, input.active ?? true]);
    await writeEntitlements(q, id, input.entitlements || {});
    await audit(q, actor, 'staff.created', `${actor.name} added ${input.name} (${ROLE_LABELS[input.role]}, ${input.location})`);
    return { id };
  });
}

async function updateStaff(db, actor, id, body) {
  const typeNames = (await listLeaveTypes(db.query)).map((t) => t.name);
  const input = parseStaffInput(body, typeNames, { partial: true });
  return db.transaction(async (q) => {
    const current = await one(q, 'SELECT id, email, name, location, role, manager_id, active FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!current) throw httpError(404, 'Staff member not found.');
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'entitlements' && v !== undefined)) };

    if (id === actor.id && next.role !== 'admin') throw httpError(400, 'You cannot remove your own Administrator role.');
    if (id === actor.id && !next.active) throw httpError(400, 'You cannot deactivate your own account.');
    if (current.role === 'admin' && current.active && (next.role !== 'admin' || !next.active)) {
      const others = await one(q, "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
      if (others.n === 0) throw httpError(400, 'At least one active Administrator is required.');
    }
    if (next.email !== current.email && await one(q, 'SELECT 1 FROM users WHERE email = $1 AND id <> $2', [next.email, id])) {
      throw httpError(409, 'Another staff member already uses this email.');
    }
    if (next.manager_id !== current.manager_id) await assertValidManager(q, next.manager_id, id);

    await q(
      `UPDATE users SET email = $2, name = $3, location = $4, role = $5, manager_id = $6, active = $7,
              token_version = token_version + CASE WHEN $7 THEN 0 ELSE 1 END
       WHERE id = $1`,
      [id, next.email, next.name, next.location, next.role, next.manager_id, next.active]);
    if (input.entitlements) await writeEntitlements(q, id, input.entitlements);

    const changes = ['email', 'name', 'location', 'role', 'manager_id', 'active']
      .filter((k) => next[k] !== current[k])
      .map((k) => (k === 'manager_id' ? 'line manager' : k));
    if (input.entitlements) changes.push('entitlements');
    await audit(q, actor, 'staff.updated', `${actor.name} updated ${next.name}${changes.length ? ` (${changes.join(', ')})` : ''}`);
    return { id };
  });
}

async function deleteStaff(db, actor, id) {
  if (id === actor.id) throw httpError(400, 'You cannot delete your own account.');
  return db.transaction(async (q) => {
    const user = await one(q, `SELECT id, name, role, active, (SELECT COUNT(*)::int FROM leave_requests WHERE user_id = $1) AS requests
                               FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!user) throw httpError(404, 'Staff member not found.');
    if (user.requests > 0) {
      throw httpError(409, `${user.name} has ${user.requests} leave record(s). Deactivate the account instead so their history is kept.`);
    }
    if (user.role === 'admin' && user.active) {
      const others = await one(q, "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
      if (others.n === 0) throw httpError(400, 'At least one active Administrator is required.');
    }
    await q('DELETE FROM users WHERE id = $1', [id]);
    await audit(q, actor, 'staff.deleted', `${actor.name} deleted the account of ${user.name}`);
  });
}

// --- Balance adjustments ---

async function listAdjustments(db, { userId, year }) {
  const { rows } = await db.query(
    `SELECT a.id, a.user_id, u.name AS employee_name, a.leave_type, a.year, a.days, a.reason, c.name AS created_by_name, a.created_at
     FROM balance_adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.created_by
     WHERE ($1::int IS NULL OR a.user_id = $1) AND ($2::int IS NULL OR a.year = $2)
     ORDER BY a.created_at DESC, a.id DESC`,
    [userId ?? null, year ?? null]);
  return rows;
}

async function createAdjustment(db, actor, body = {}) {
  const userId = Number(body.user_id);
  const year = Number(body.year);
  const days = Number(body.days);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const leaveType = typeof body.leave_type === 'string' ? body.leave_type : '';
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw httpError(400, 'Invalid year.');
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 366) throw httpError(400, 'Days must be a whole number, positive to add or negative to deduct.');
  if (reason.length < 3 || reason.length > 300) throw httpError(400, 'Please give a reason (3–300 characters).');

  return db.transaction(async (q) => {
    const ent = await one(q,
      `SELECT e.days_per_year, u.name FROM entitlements e JOIN users u ON u.id = e.user_id
       WHERE e.user_id = $1 AND e.leave_type = $2`, [userId, leaveType]);
    if (!ent) throw httpError(400, 'This person has no entitlement for that leave type.');
    if (ent.days_per_year === null) throw httpError(400, 'Unlimited leave types do not need adjustments.');
    const { id } = await one(q,
      'INSERT INTO balance_adjustments (user_id, leave_type, year, days, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [userId, leaveType, year, days, reason, actor.id]);
    await audit(q, actor, 'balance.adjusted',
      `${actor.name} ${days > 0 ? 'added' : 'deducted'} ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'to' : 'from'} ${ent.name}'s ${leaveType} for ${year}: ${reason}`);
    return { id };
  });
}

async function deleteAdjustment(db, actor, id) {
  return db.transaction(async (q) => {
    const a = await one(q, `SELECT a.days, a.leave_type, a.year, u.name FROM balance_adjustments a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [id]);
    if (!a) throw httpError(404, 'Adjustment not found.');
    await q('DELETE FROM balance_adjustments WHERE id = $1', [id]);
    await audit(q, actor, 'balance.adjustment_removed', `${actor.name} removed a ${a.days > 0 ? '+' : ''}${a.days} day adjustment on ${a.name}'s ${a.leave_type} (${a.year})`);
  });
}

module.exports = {
  listLeaveTypes, listStaff, createStaff, updateStaff, deleteStaff,
  listAdjustments, createAdjustment, deleteAdjustment, ROLES, ROLE_LABELS,
};
