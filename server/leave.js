// Leave workflow: entitlements, balances, applying, approvals, admin edits.

const { parseISODate, countBusinessDays, rangeLengthDays, businessDaysInYear, yearsSpanned, MAX_RANGE_DAYS } = require('./dates');
const { describeRequest } = require('./format');
const { httpError } = require('./errors');
const { audit } = require('./audit');

const MAX_REASON = 500;
const MAX_DETAILS = 120;
const STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.name AS employee_name, u.email AS employee_email, u.location AS employee_location,
         u.manager_id, m.name AS line_manager_name, r.leave_type,
         to_char(r.start_date, 'YYYY-MM-DD') AS start_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date,
         r.total_days, r.details, r.reason, r.status, r.approver_id,
         r.decided_by, d.name AS decided_by_name, r.decided_at, r.decision_note,
         r.created_by, r.created_at, r.updated_at
  FROM leave_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users m ON m.id = u.manager_id
  LEFT JOIN users d ON d.id = r.decided_by`;

const one = async (q, text, params) => (await q(text, params)).rows[0] ?? null;

// --- Permissions ---
const isAdmin = (u) => u.role === 'admin';
const managesDirectly = (actor, employee) => ['approver', 'admin'].includes(actor.role) && employee.manager_id === actor.id;
// Line manager approves; HR admin can approve anyone. Nobody approves their own leave.
const canDecide = (actor, employee) => actor.id !== employee.id && (isAdmin(actor) || managesDirectly(actor, employee));
const canView = (actor, employee) => actor.id === employee.id || isAdmin(actor) || managesDirectly(actor, employee);

// --- Entitlements & balances ---

// Leave types a user may use: has an entitlement row (N/A = no row) and passes the location rule.
async function allowedTypes(q, userIds) {
  const { rows } = await q(
    `SELECT e.user_id, e.leave_type, e.days_per_year, t.sort_order
     FROM entitlements e
     JOIN leave_types t ON t.name = e.leave_type
     JOIN users u ON u.id = e.user_id
     WHERE e.user_id = ANY($1::int[]) AND (t.location_only IS NULL OR t.location_only = u.location)
     ORDER BY t.sort_order, e.leave_type`,
    [userIds]
  );
  return rows;
}

// Balances per user for a calendar year. Used/pending are derived from requests, so
// they can never drift out of sync; entitlements refresh every 1 Jan (no carry-forward).
async function computeBalances(q, userIds, year) {
  if (!userIds.length) return new Map();
  const [types, adjustments, requests] = await Promise.all([
    allowedTypes(q, userIds),
    q(`SELECT user_id, leave_type, SUM(days)::int AS days FROM balance_adjustments
       WHERE user_id = ANY($1::int[]) AND year = $2 GROUP BY user_id, leave_type`, [userIds, year]),
    q(`SELECT user_id, leave_type, status, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM leave_requests
       WHERE user_id = ANY($1::int[]) AND status IN ('Pending', 'Approved')
         AND start_date <= make_date($2, 12, 31) AND end_date >= make_date($2, 1, 1)`, [userIds, year]),
  ]);

  const key = (u, t) => `${u}|${t}`;
  const adj = new Map(adjustments.rows.map((r) => [key(r.user_id, r.leave_type), r.days]));
  const used = new Map();
  const pending = new Map();
  for (const r of requests.rows) {
    const bucket = r.status === 'Approved' ? used : pending;
    const k = key(r.user_id, r.leave_type);
    bucket.set(k, (bucket.get(k) || 0) + businessDaysInYear(r.start_date, r.end_date, year));
  }

  const result = new Map(userIds.map((id) => [id, []]));
  for (const t of types) {
    const k = key(t.user_id, t.leave_type);
    const unlimited = t.days_per_year === null;
    const row = {
      leave_type: t.leave_type,
      unlimited,
      entitlement: unlimited ? null : t.days_per_year,
      adjustment: adj.get(k) || 0,
      used: used.get(k) || 0,
      pending: pending.get(k) || 0,
    };
    row.available = unlimited ? null : row.entitlement + row.adjustment - row.used - row.pending;
    result.get(t.user_id).push(row);
  }
  return result;
}

// --- Validation ---

function parseRequestInput(body = {}) {
  const leaveType = typeof body.leave_type === 'string' ? body.leave_type.trim() : '';
  const startIso = body.start_date;
  const endIso = body.end_date;
  const start = parseISODate(startIso);
  const end = parseISODate(endIso);
  const details = typeof body.details === 'string' ? body.details.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!leaveType) throw httpError(400, 'Leave type is required.');
  if (!start || !end) throw httpError(400, 'Start and end dates must be valid dates.');
  if (end < start) throw httpError(400, 'End date cannot be before start date.');
  if (rangeLengthDays(start, end) > MAX_RANGE_DAYS) throw httpError(400, 'A single request cannot span more than a year.');
  if (details.length > MAX_DETAILS) throw httpError(400, `Leave details must be ${MAX_DETAILS} characters or fewer.`);
  if (reason.length > MAX_REASON) throw httpError(400, `Reason must be ${MAX_REASON} characters or fewer.`);

  const totalDays = countBusinessDays(start, end);
  if (totalDays === 0) throw httpError(400, 'The selected dates fall entirely on a weekend.');
  return { leaveType, startIso, endIso, details, reason, totalDays };
}

// Checks type is allowed, dates don't overlap, and (for limited types) every calendar year
// touched has enough balance. Locks the entitlement row so concurrent requests serialise.
async function assertCanBook(q, employee, input, { excludeRequestId = null, checkDetails = true } = {}) {
  const ent = await one(q,
    `SELECT e.days_per_year, t.location_only FROM entitlements e JOIN leave_types t ON t.name = e.leave_type
     WHERE e.user_id = $1 AND e.leave_type = $2 FOR UPDATE OF e`,
    [employee.id, input.leaveType]);
  if (!ent || (ent.location_only && ent.location_only !== employee.location)) {
    throw httpError(400, `${input.leaveType} is not available for ${employee.name}.`);
  }
  const unlimited = ent.days_per_year === null;
  if (unlimited && checkDetails && input.details.length < 2) {
    throw httpError(400, `Please describe what type of leave this is (e.g. Bereavement, Marriage) for ${input.leaveType}.`);
  }

  const overlap = await one(q,
    `SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('Pending', 'Approved')
       AND start_date <= $3 AND end_date >= $2 AND ($4::int IS NULL OR id <> $4) LIMIT 1`,
    [employee.id, input.startIso, input.endIso, excludeRequestId]);
  if (overlap) throw httpError(409, 'These dates overlap with another pending or approved request.');

  if (unlimited) return;
  for (const year of yearsSpanned(input.startIso, input.endIso)) {
    const need = businessDaysInYear(input.startIso, input.endIso, year);
    if (need === 0) continue;
    const adj = await one(q, 'SELECT COALESCE(SUM(days), 0)::int AS days FROM balance_adjustments WHERE user_id = $1 AND leave_type = $2 AND year = $3', [employee.id, input.leaveType, year]);
    const { rows } = await q(
      `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leave_requests
       WHERE user_id = $1 AND leave_type = $2 AND status IN ('Pending', 'Approved') AND ($4::int IS NULL OR id <> $4)
         AND start_date <= make_date($3, 12, 31) AND end_date >= make_date($3, 1, 1)`,
      [employee.id, input.leaveType, year, excludeRequestId]);
    const booked = rows.reduce((sum, r) => sum + businessDaysInYear(r.start_date, r.end_date, year), 0);
    const available = ent.days_per_year + adj.days - booked;
    if (need > available) {
      throw httpError(400, `Insufficient ${input.leaveType} balance for ${year}: requesting ${need} day${need === 1 ? '' : 's'}, ${Math.max(available, 0)} available (after pending requests).`);
    }
  }
}

const getEmployee = (q, id) => one(q, 'SELECT id, name, email, location, role, manager_id, active FROM users WHERE id = $1', [id]);
const getRequest = (q, id) => one(q, `${REQUEST_SELECT} WHERE r.id = $1`, [id]);

// --- Employee actions ---

async function applyForLeave(db, actor, body) {
  const input = parseRequestInput(body);
  const result = await db.transaction(async (q) => {
    await assertCanBook(q, actor, input);
    const { id } = await one(q,
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, total_days, details, reason, approver_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1) RETURNING id`,
      [actor.id, input.leaveType, input.startIso, input.endIso, input.totalDays, input.details, input.reason, actor.manager_id]);
    const request = await getRequest(q, id);
    await audit(q, actor, 'request.created', `${actor.name} requested ${describeRequest(request)}`);

    // Notify the line manager; if there isn't an active one, notify HR admins.
    let recipients = actor.manager_id
      ? (await q("SELECT id, name, email FROM users WHERE id = $1 AND active AND role IN ('approver', 'admin')", [actor.manager_id])).rows
      : [];
    if (!recipients.length) {
      recipients = (await q("SELECT id, name, email FROM users WHERE role = 'admin' AND active AND id <> $1", [actor.id])).rows;
    }
    return { request, recipients };
  });
  return result;
}

async function cancelRequest(db, actor, requestId) {
  return db.transaction(async (q) => {
    const r = await one(q, 'SELECT user_id, status FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (!r) throw httpError(404, 'Request not found.');
    if (r.user_id !== actor.id) throw httpError(403, 'You can only cancel your own requests.');
    if (r.status !== 'Pending') throw httpError(409, 'Only pending requests can be cancelled. Ask HR to change an approved request.');
    await q("UPDATE leave_requests SET status = 'Cancelled', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1", [requestId, actor.id]);
    const request = await getRequest(q, requestId);
    await audit(q, actor, 'request.cancelled', `${actor.name} cancelled ${describeRequest(request)}`);
    return request;
  });
}

// --- Approver / admin actions ---

async function decideRequest(db, actor, requestId, status, note = '') {
  if (!['Approved', 'Rejected'].includes(status)) throw httpError(400, 'Status must be Approved or Rejected.');
  const decisionNote = typeof note === 'string' ? note.trim().slice(0, MAX_REASON) : '';

  return db.transaction(async (q) => {
    const r = await one(q,
      `SELECT id, user_id, leave_type, status, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date, details
       FROM leave_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!r) throw httpError(404, 'Request not found.');
    const employee = await getEmployee(q, r.user_id);
    if (actor.id === employee.id) throw httpError(403, 'You cannot approve or reject your own request.');
    if (!canDecide(actor, employee)) throw httpError(403, 'Only this person\'s line manager or HR can decide this request.');
    if (r.status !== 'Pending') throw httpError(409, `This request is already ${r.status.toLowerCase()}.`);

    if (status === 'Approved') {
      // Re-check: balances or entitlements may have changed since submission.
      await assertCanBook(q, employee, { leaveType: r.leave_type, startIso: r.start_date, endIso: r.end_date, details: r.details },
        { excludeRequestId: r.id, checkDetails: false });
    }
    await q('UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1',
      [requestId, status, actor.id, decisionNote]);
    const request = await getRequest(q, requestId);
    await audit(q, actor, `request.${status.toLowerCase()}`, `${actor.name} ${status.toLowerCase()} ${employee.name}'s ${describeRequest(request)}`);
    return { request, employee };
  });
}

// Admin: create a leave record for anyone (e.g. sick leave reported by phone).
async function adminCreateRequest(db, actor, body = {}) {
  if (!isAdmin(actor)) throw httpError(403, 'Administrators only.');
  const input = parseRequestInput(body);
  const status = body.status === 'Approved' ? 'Approved' : 'Pending';

  return db.transaction(async (q) => {
    const employee = await getEmployee(q, Number(body.user_id));
    if (!employee) throw httpError(404, 'Staff member not found.');
    if (status === 'Approved' && employee.id === actor.id) throw httpError(403, 'You cannot approve your own leave. Submit it as Pending for your line manager.');
    await assertCanBook(q, employee, input);
    const { id } = await one(q,
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, total_days, details, reason, status,
                                   approver_id, decided_by, decided_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $9, $10, CASE WHEN $8::text = 'Approved' THEN now() END, $11) RETURNING id`,
      [employee.id, input.leaveType, input.startIso, input.endIso, input.totalDays, input.details, input.reason, status,
        employee.manager_id, status === 'Approved' ? actor.id : null, actor.id]);
    const request = await getRequest(q, id);
    await audit(q, actor, 'request.admin_created', `${actor.name} recorded ${status.toLowerCase()} leave for ${employee.name}: ${describeRequest(request)}`);
    return request;
  });
}

// Admin: edit any field of any request (dates, type, details, status). Re-validated.
async function adminUpdateRequest(db, actor, requestId, body = {}) {
  if (!isAdmin(actor)) throw httpError(403, 'Administrators only.');
  return db.transaction(async (q) => {
    const current = await one(q,
      `SELECT id, user_id, leave_type, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
              details, reason, status, decision_note FROM leave_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!current) throw httpError(404, 'Request not found.');
    const employee = await getEmployee(q, current.user_id);
    const before = await getRequest(q, requestId);

    const merged = {
      leave_type: body.leave_type ?? current.leave_type,
      start_date: body.start_date ?? current.start_date,
      end_date: body.end_date ?? current.end_date,
      details: body.details ?? current.details,
      reason: body.reason ?? current.reason,
    };
    const status = body.status ?? current.status;
    if (!STATUSES.includes(status)) throw httpError(400, 'Invalid status.');
    if (employee.id === actor.id && status === 'Approved' && current.status !== 'Approved') {
      throw httpError(403, 'You cannot approve your own leave.');
    }
    const input = parseRequestInput(merged);
    if (['Pending', 'Approved'].includes(status)) await assertCanBook(q, employee, input, { excludeRequestId: requestId });

    const statusChanged = status !== current.status;
    await q(
      `UPDATE leave_requests SET leave_type = $2, start_date = $3, end_date = $4, total_days = $5, details = $6, reason = $7,
              status = $8, decision_note = $9, updated_at = now(),
              decided_by = CASE WHEN $10 THEN $11 ELSE decided_by END,
              decided_at = CASE WHEN $10 THEN now() ELSE decided_at END
       WHERE id = $1`,
      [requestId, input.leaveType, input.startIso, input.endIso, input.totalDays, input.details, input.reason, status,
        typeof body.decision_note === 'string' ? body.decision_note.trim().slice(0, MAX_REASON) : current.decision_note,
        statusChanged && status !== 'Pending', actor.id]);
    const request = await getRequest(q, requestId);
    await audit(q, actor, 'request.admin_updated',
      `${actor.name} edited ${employee.name}'s request: ${describeRequest(before)} [${before.status}] → ${describeRequest(request)} [${request.status}]`);
    return { request, employee, statusChanged };
  });
}

async function adminDeleteRequest(db, actor, requestId) {
  if (!isAdmin(actor)) throw httpError(403, 'Administrators only.');
  return db.transaction(async (q) => {
    const request = await getRequest(q, requestId);
    if (!request) throw httpError(404, 'Request not found.');
    await q('DELETE FROM leave_requests WHERE id = $1', [requestId]);
    await audit(q, actor, 'request.deleted', `${actor.name} deleted ${request.employee_name}'s ${describeRequest(request)} [${request.status}]`);
    return request;
  });
}

// --- Queries for views ---

// scope: 'mine' (own), 'approvals' (what I can decide: direct reports; admins: everyone else), 'all' (admin)
async function listRequests(db, actor, { scope = 'mine', year, status } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (scope === 'mine') add('r.user_id = ?', actor.id);
  else if (scope === 'approvals') {
    if (isAdmin(actor)) add('r.user_id <> ?', actor.id);
    else if (actor.role === 'approver') add('u.manager_id = ?', actor.id);
    else throw httpError(403, 'Approvers only.');
  } else if (scope === 'all') {
    if (!isAdmin(actor)) throw httpError(403, 'Administrators only.');
  } else throw httpError(400, 'Invalid scope.');

  if (year) {
    add('r.start_date <= make_date(?, 12, 31)', year);
    add('r.end_date >= make_date(?, 1, 1)', year);
  }
  if (status && STATUSES.includes(status)) add('r.status = ?', status);

  const { rows } = await db.query(`${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.start_date DESC, r.id DESC`, params);
  return rows;
}

// scope: 'mine' | 'team' (direct reports) | 'all' (admin)
async function listBalances(db, actor, { scope = 'mine', year }) {
  let users;
  if (scope === 'mine') users = [actor];
  else if (scope === 'team') {
    if (!['approver', 'admin'].includes(actor.role)) throw httpError(403, 'Approvers only.');
    users = (await db.query('SELECT id, name, email, location FROM users WHERE manager_id = $1 AND active ORDER BY name', [actor.id])).rows;
  } else if (scope === 'all') {
    if (!isAdmin(actor)) throw httpError(403, 'Administrators only.');
    users = (await db.query('SELECT id, name, email, location FROM users WHERE active ORDER BY name')).rows;
  } else throw httpError(400, 'Invalid scope.');

  const balances = await computeBalances(db.query, users.map((u) => u.id), year);
  return users.map((u) => ({ user_id: u.id, name: u.name, email: u.email, location: u.location, balances: balances.get(u.id) || [] }));
}

module.exports = {
  applyForLeave, cancelRequest, decideRequest, adminCreateRequest, adminUpdateRequest, adminDeleteRequest,
  listRequests, listBalances, computeBalances, allowedTypes, canView, canDecide, getRequest, STATUSES, REQUEST_SELECT,
};
