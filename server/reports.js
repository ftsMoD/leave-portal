// Admin reports + CSV exports.

const { REQUEST_SELECT } = require('./leave');
const { todayIso } = require('./dates');
const { toCsv } = require('./csv');
const { ROLE_LABELS } = require('./staff');

async function summary(db) {
  const today = todayIso();
  const [pending, onLeave, upcoming, activity] = await Promise.all([
    db.query("SELECT COUNT(*)::int AS n FROM leave_requests WHERE status = 'Pending'"),
    db.query(`${REQUEST_SELECT} WHERE r.status = 'Approved' AND r.start_date <= $1 AND r.end_date >= $1 ORDER BY u.name`, [today]),
    db.query(`${REQUEST_SELECT} WHERE r.status IN ('Approved', 'Pending') AND r.start_date > $1 AND r.start_date <= $1::date + 14
              ORDER BY r.start_date, u.name`, [today]),
    db.query('SELECT id, actor_name, action, summary, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 40'),
  ]);
  return {
    today,
    pending_count: pending.rows[0].n,
    on_leave_today: onLeave.rows,
    upcoming: upcoming.rows,
    activity: activity.rows,
    generated_at: new Date().toISOString(),
  };
}

function requestsCsv(rows, { withEmployee = true } = {}) {
  const headers = [
    ...(withEmployee ? ['Employee', 'Email', 'Location', 'Line manager'] : []),
    'Leave type', 'Details', 'Start date', 'End date', 'Working days', 'Reason', 'Status',
    'Decided by', 'Decided at', 'Decision comment', 'Submitted at',
  ];
  const data = rows.map((r) => [
    ...(withEmployee ? [r.employee_name, r.employee_email, r.employee_location, r.line_manager_name] : []),
    r.leave_type, r.details, r.start_date, r.end_date, r.total_days, r.reason, r.status,
    r.decided_by_name, r.decided_at, r.decision_note, r.created_at,
  ]);
  return toCsv(headers, data);
}

function balancesCsv(people, year, { withEmployee = true } = {}) {
  const headers = [
    ...(withEmployee ? ['Employee', 'Email', 'Location'] : []),
    'Year', 'Leave type', 'Entitlement', 'Adjustments', 'Used', 'Pending', 'Available',
  ];
  const data = [];
  for (const p of people) {
    for (const b of p.balances) {
      data.push([
        ...(withEmployee ? [p.name, p.email, p.location] : []),
        year, b.leave_type, b.unlimited ? 'Unlimited' : b.entitlement, b.adjustment, b.used, b.pending,
        b.unlimited ? 'Unlimited' : b.available,
      ]);
    }
  }
  return toCsv(headers, data);
}

async function activityCsv(db) {
  const { rows } = await db.query('SELECT created_at, actor_name, action, summary FROM audit_log ORDER BY created_at DESC, id DESC');
  return toCsv(['When (UTC)', 'By', 'Action', 'Details'], rows.map((r) => [r.created_at, r.actor_name, r.action, r.summary]));
}

function staffCsv(staff, types) {
  const headers = ['Name', 'Email', 'Location', 'Role', 'Line manager', 'Active', ...types.map((t) => t.name)];
  const data = staff.map((s) => [
    s.name, s.email, s.location, ROLE_LABELS[s.role], s.manager_name, s.active ? 'Yes' : 'No',
    ...types.map((t) => {
      const v = s.entitlements[t.name];
      return v === undefined ? 'N/A' : v === 'unlimited' ? 'Unlimited' : v;
    }),
  ]);
  return toCsv(headers, data);
}

module.exports = { summary, requestsCsv, balancesCsv, activityCsv, staffCsv };
