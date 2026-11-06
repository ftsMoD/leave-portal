const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { httpError } = require('./errors');

const MIN_PASSWORD_LENGTH = 8;
// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  // No hard-coded fallback: a guessable secret lets anyone mint a manager token.
  if (!secret) throw httpError(500, 'Server misconfigured: JWT_SECRET is not set.');
  return secret;
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
}

async function login(store, body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw httpError(400, 'Email and password are required.');

  getJwtSecret(); // fail fast on misconfiguration before touching credentials
  const user = await store.findUserByEmail(email);
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok || !user.active) throw httpError(401, 'Invalid email or password.');

  const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  return { token: signToken(publicUser), user: publicUser };
}

// Express middleware factory. Re-loads the user on every request so that
// deactivations and role changes take effect immediately.
function requireAuth(getStore) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw httpError(401, 'Not signed in.');

      let payload;
      try {
        payload = jwt.verify(token, getJwtSecret());
      } catch (err) {
        if (err.status) throw err;
        throw httpError(401, 'Session expired. Please sign in again.');
      }

      const user = await getStore().getUserById(Number(payload.sub));
      if (!user || !user.active) throw httpError(401, 'Account not found or disabled.');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function changePassword(store, user, body = {}) {
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (next.length < MIN_PASSWORD_LENGTH) throw httpError(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  const hash = await store.getPasswordHash(user.id);
  if (!hash || !(await bcrypt.compare(current, hash))) throw httpError(400, 'Current password is incorrect.');

  await store.updatePasswordHash(user.id, await bcrypt.hash(next, 10));
}

module.exports = { login, requireAuth, changePassword, signToken, MIN_PASSWORD_LENGTH };
