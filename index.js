// Express backend, deployed by Vercel as a single serverless function.
// vercel.json rewrites /api/* here; Express routes on the original path.

const express = require('express');
const { getDb, databaseStatus } = require('../server/db');
const auth = require('../server/auth');
const leave = require('../server/leave');
const staff = require('../server/staff');
const reports = require('../server/reports');
const mailer = require('../server/mailer');
const { currentYear } = require('../server/dates');
const { httpError, asyncHandler } = require('../server/errors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const signedIn = auth.requireAuth(getDb);
const signedInAllowPending = auth.requireAuth(getDb, { allowPasswordChangePending: true });
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : next(httpError(403, 'Administrators only.')));
const withDb = asyncHandler(async (req, res, next) => { req.db = await getDb(); next(); });

const parseId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid id.');
  return id;
};
const parseYear = (value) => {
  const y = Number(value);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : currentYear();
};
const sendCsv = (res, filename, csv) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
};

// --- HEALTH ---
app.get('/api/health', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    database: await databaseStatus(),
    email: mailer.emailConfigured(),
    app_url: Boolean(mailer.appUrl()),
    year: currentYear(),
  });
}));

// --- AUTH ---
app.post('/api/auth/login', withDb, asyncHandler(async (req, res) => {
  res.json(await auth.login(req.db, req.body));
}));
app.post('/api/auth/forgot', withDb, asyncHandler(async (req, res) => {
  res.json(await auth.requestPasswordReset(req.db, req.body));
}));
app.post('/api/auth/reset', withDb, asyncHandler(async (req, res) => {
  res.json(await auth.resetPassword(req.db, req.body));
}));
app.get('/api/auth/me', signedInAllowPending, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});
app.post('/api/auth/password', signedInAllowPending, asyncHandler(async (req, res) => {
  res.json(await auth.changePassword(req.db, req.user, req.body));
}));

// --- LEAVE ---
app.get('/api/leave-types', signedIn, asyncHandler(async (req, res) => {
  res.json(await staff.listLeaveTypes(req.db.query));
}));

// Leave types this user can request (N/A and location rules applied).
app.get('/api/my/leave-options', signedIn, asyncHandler(async (req, res) => {
  const rows = await leave.allowedTypes(req.db.query, [req.user.id]);
  res.json(rows.map((r) => ({ leave_type: r.leave_type, unlimited: r.days_per_year === null })));
}));

app.get('/api/balances', signedIn, asyncHandler(async (req, res) => {
  res.json(await leave.listBalances(req.db, req.user, { scope: req.query.scope || 'mine', year: parseYear(req.query.year) }));
}));

app.get('/api/requests', signedIn, asyncHandler(async (req, res) => {
  res.json(await leave.listRequests(req.db, req.user, {
    scope: req.query.scope || 'mine',
    year: req.query.year ? parseYear(req.query.year) : undefined,
    status: req.query.status,
  }));
}));

app.post('/api/requests', signedIn, asyncHandler(async (req, res) => {
  const { request, recipients } = await leave.applyForLeave(req.db, req.user, req.body);
  const email = await mailer.sendNewRequest(recipients, request);
  res.status(201).json({
    message: `Request submitted to ${recipients.map((r) => r.name).join(', ') || 'HR'} for approval.`,
    request,
    email,
  });
}));

// { status: "Cancelled" } by the owner, or { status: "Approved" | "Rejected", note } by line manager / HR.
app.patch('/api/requests/:id', signedIn, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { status, note } = req.body || {};
  if (status === 'Cancelled') {
    return res.json({ message: 'Request cancelled.', request: await leave.cancelRequest(req.db, req.user, id) });
  }
  const { request, employee } = await leave.decideRequest(req.db, req.user, id, status, note);
  const email = await mailer.sendDecision(employee, request);
  res.json({ message: `${employee.name}'s request ${status.toLowerCase()}.`, request, email });
}));

// --- ADMIN: requests ---
app.post('/api/admin/requests', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.status(201).json({ message: 'Leave recorded.', request: await leave.adminCreateRequest(req.db, req.user, req.body) });
}));
app.put('/api/admin/requests/:id', signedIn, adminOnly, asyncHandler(async (req, res) => {
  const { request, employee, statusChanged } = await leave.adminUpdateRequest(req.db, req.user, parseId(req.params.id), req.body);
  const email = statusChanged && ['Approved', 'Rejected'].includes(request.status) ? await mailer.sendDecision(employee, request) : null;
  res.json({ message: 'Request updated.', request, email });
}));
app.delete('/api/admin/requests/:id', signedIn, adminOnly, asyncHandler(async (req, res) => {
  await leave.adminDeleteRequest(req.db, req.user, parseId(req.params.id));
  res.json({ message: 'Request deleted.' });
}));

// --- ADMIN: staff ---
app.get('/api/admin/staff', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.json(await staff.listStaff(req.db));
}));
app.post('/api/admin/staff', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.status(201).json({ message: 'Staff member added.', ...(await staff.createStaff(req.db, req.user, req.body)) });
}));
app.put('/api/admin/staff/:id', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.json({ message: 'Staff member updated.', ...(await staff.updateStaff(req.db, req.user, parseId(req.params.id), req.body)) });
}));
app.delete('/api/admin/staff/:id', signedIn, adminOnly, asyncHandler(async (req, res) => {
  await staff.deleteStaff(req.db, req.user, parseId(req.params.id));
  res.json({ message: 'Staff member deleted.' });
}));
app.post('/api/admin/staff/:id/temp-password', signedIn, adminOnly, asyncHandler(async (req, res) => {
  const { password, user } = await auth.setTemporaryPassword(req.db, req.user, parseId(req.params.id));
  res.json({ password, message: `Temporary password set for ${user.name}. They must change it at first sign-in.` });
}));
app.post('/api/admin/staff/:id/setup-email', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.json(await auth.sendSetupEmail(req.db, req.user, parseId(req.params.id)));
}));

// --- ADMIN: balance adjustments ---
app.get('/api/admin/adjustments', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.json(await staff.listAdjustments(req.db, {
    userId: req.query.user_id ? parseId(req.query.user_id) : null,
    year: req.query.year ? parseYear(req.query.year) : null,
  }));
}));
app.post('/api/admin/adjustments', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.status(201).json({ message: 'Balance adjusted.', ...(await staff.createAdjustment(req.db, req.user, req.body)) });
}));
app.delete('/api/admin/adjustments/:id', signedIn, adminOnly, asyncHandler(async (req, res) => {
  await staff.deleteAdjustment(req.db, req.user, parseId(req.params.id));
  res.json({ message: 'Adjustment removed.' });
}));

// --- ADMIN: reports ---
app.get('/api/admin/reports/summary', signedIn, adminOnly, asyncHandler(async (req, res) => {
  res.json(await reports.summary(req.db));
}));

// --- EXPORTS (CSV) ---
app.get('/api/export/my-requests.csv', signedIn, asyncHandler(async (req, res) => {
  const year = parseYear(req.query.year);
  const rows = await leave.listRequests(req.db, req.user, { scope: 'mine', year });
  sendCsv(res, `my-leave-history-${year}.csv`, reports.requestsCsv(rows, { withEmployee: false }));
}));
app.get('/api/export/my-balances.csv', signedIn, asyncHandler(async (req, res) => {
  const year = parseYear(req.query.year);
  const people = await leave.listBalances(req.db, req.user, { scope: 'mine', year });
  sendCsv(res, `my-leave-balances-${year}.csv`, reports.balancesCsv(people, year, { withEmployee: false }));
}));
app.get('/api/export/requests.csv', signedIn, adminOnly, asyncHandler(async (req, res) => {
  const year = parseYear(req.query.year);
  const rows = await leave.listRequests(req.db, req.user, { scope: 'all', year, status: req.query.status });
  sendCsv(res, `leave-requests-${year}.csv`, reports.requestsCsv(rows));
}));
app.get('/api/export/balances.csv', signedIn, adminOnly, asyncHandler(async (req, res) => {
  const year = parseYear(req.query.year);
  const people = await leave.listBalances(req.db, req.user, { scope: 'all', year });
  sendCsv(res, `leave-balances-${year}.csv`, reports.balancesCsv(people, year));
}));
app.get('/api/export/staff.csv', signedIn, adminOnly, asyncHandler(async (req, res) => {
  const [list, types] = await Promise.all([staff.listStaff(req.db), staff.listLeaveTypes(req.db.query)]);
  sendCsv(res, 'staff-entitlements.csv', reports.staffCsv(list, types));
}));
app.get('/api/export/activity.csv', signedIn, adminOnly, asyncHandler(async (req, res) => {
  sendCsv(res, 'leave-activity-log.csv', await reports.activityCsv(req.db));
}));

// --- FALLTHROUGH + ERRORS ---
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Internal server error.' : err.message });
});

module.exports = app;
