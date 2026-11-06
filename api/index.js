// Express backend, deployed by Vercel as a single serverless function.
// vercel.json rewrites /api/* here; Express routes on the original path.

const express = require('express');
const { getStore } = require('../server/store');
const { login, requireAuth, changePassword } = require('../server/auth');
const { applyForLeave, decideRequest, cancelRequest } = require('../server/leave');
const { httpError, asyncHandler } = require('../server/errors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
// No CORS middleware: frontend and API share one origin on Vercel.

const auth = requireAuth(getStore);

const parseId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid id.');
  return id;
};

// --- HEALTH ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, storage: getStore().kind });
});

// --- AUTH ROUTES ---
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { token, user } = await login(getStore(), req.body);
  res.json({ token, user });
}));

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/password', auth, asyncHandler(async (req, res) => {
  await changePassword(getStore(), req.user, req.body);
  res.json({ message: 'Password updated.' });
}));

// --- LEAVE ROUTES ---
// :userId may be "me". Employees can only read their own balances.
app.get('/api/balances/:userId', auth, asyncHandler(async (req, res) => {
  const userId = req.params.userId === 'me' ? req.user.id : parseId(req.params.userId);
  if (userId !== req.user.id && req.user.role !== 'manager') throw httpError(403, 'Not allowed.');
  res.json(await getStore().listBalances(userId));
}));

// Employees always get their own requests. Managers get everyone's unless ?scope=mine.
app.get('/api/leave/requests', auth, asyncHandler(async (req, res) => {
  const ownOnly = req.user.role !== 'manager' || req.query.scope === 'mine';
  res.json(await getStore().listRequests(ownOnly ? { userId: req.user.id } : {}));
}));

// The applicant is always the signed-in user; any user_id in the body is ignored.
app.post('/api/leave/apply', auth, asyncHandler(async (req, res) => {
  const request = await applyForLeave(getStore(), req.user, req.body);
  res.status(201).json({ message: 'Leave request submitted successfully.', request });
}));

// Managers: { status: "Approved" | "Rejected" }. Owners: { status: "Cancelled" } while pending.
app.patch('/api/leave/requests/:id', auth, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const status = req.body?.status;
  const request = status === 'Cancelled'
    ? await cancelRequest(getStore(), req.user, id)
    : await decideRequest(getStore(), req.user, id, status);
  res.json({ message: `Request ${status.toLowerCase()}.`, request });
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
