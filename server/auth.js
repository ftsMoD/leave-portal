const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { httpError } = require('./errors');
const { audit } = require('./audit');
const mailer = require('./mailer');

const MIN_PASSWORD_LENGTH = 10;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_HOURS = 1;
const SETUP_HOURS = 72;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10); // keeps login timing even for unknown emails

const USER_COLUMNS = 'id, email, name, role, location, manager_id, active, must_change_password, token_version';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw httpError(500, 'Server misconfigured: JWT_SECRET is not set.');
  return secret;
}

const signToken = (user) =>
  jwt.sign({ sub: String(user.id), tv: user.token_version }, getJwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, location: u.location,
  manager_id: u.manager_id, must_change_password: u.must_change_password,
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normaliseEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

function validateNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (pw.length > 200) throw httpError(400, 'Password is too long.');
}

async function login(db, body = {}) {
  const email = normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw httpError(400, 'Email and password are required.');
  getJwtSecret();

  const { rows } = await db.query(`SELECT ${USER_COLUMNS}, password_hash, locked_until FROM users WHERE email = $1`, [email]);
  const user = rows[0];

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    throw httpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }

  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok || !user.active) {
    if (user) {
      // DB-backed lockout works across serverless instances (in-memory limiters don't).
      await db.query(
        `UPDATE users SET
           locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3::int * interval '1 minute') ELSE locked_until END,
           failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
         WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES]
      );
    }
    throw httpError(401, 'Invalid email or password.');
  }

  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  return { token: signToken(user), user: publicUser(user) };
}

// Re-loads the user on every request: deactivation, role changes and password
// resets (token_version bump) take effect immediately.
function requireAuth(getDb, { allowPasswordChangePending = false } = {}) {
  return async (req, res, next) => {
    try {
      const [scheme, token] = (req.headers.authorization || '').split(' ');
      if (scheme !== 'Bearer' || !token) throw httpError(401, 'Not signed in.');

      let payload;
      try {
        payload = jwt.verify(token, getJwtSecret());
      } catch (err) {
        if (err.status) throw err;
        throw httpError(401, 'Session expired. Please sign in again.');
      }

      const db = await getDb();
      const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [Number(payload.sub)]);
      const user = rows[0];
      if (!user || !user.active || user.token_version !== payload.tv) throw httpError(401, 'Session expired. Please sign in again.');
      if (user.must_change_password && !allowPasswordChangePending) {
        throw httpError(403, 'Please set a new password before continuing.');
      }
      req.user = user;
      req.db = db;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function changePassword(db, user, body = {}) {
  validateNewPassword(body.new_password);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  const hash = rows[0]?.password_hash;
  if (!hash || !(await bcrypt.compare(String(body.current_password ?? ''), hash))) {
    throw httpError(400, 'Current password is incorrect.');
  }
  if (body.current_password === body.new_password) throw httpError(400, 'Choose a password different from the current one.');

  const updated = (await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = FALSE, token_version = token_version + 1
     WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [user.id, await bcrypt.hash(body.new_password, 10)]
  )).rows[0];
  await audit(db.query, user, 'password.changed', `${user.name} changed their password`);
  // Old tokens are now invalid; hand back a fresh one so this session continues.
  return { token: signToken(updated), user: publicUser(updated) };
}

async function createPasswordToken(q, userId, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('DELETE FROM password_tokens WHERE user_id = $1', [userId]);
  await q(`INSERT INTO password_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 hour'))`, [sha256(token), userId, hours]);
  return token;
}

// Always responds the same way so it can't be used to discover which emails exist.
async function requestPasswordReset(db, body = {}) {
  const email = normaliseEmail(body.email);
  if (!email) throw httpError(400, 'Email is required.');
  if (!mailer.emailConfigured() || !mailer.appUrl()) {
    throw httpError(503, 'Password reset by email is not set up yet. Ask HR to reset your password.');
  }
  const user = (await db.query('SELECT id, email, name, active FROM users WHERE email = $1', [email])).rows[0];
  if (user?.active) {
    const token = await createPasswordToken(db.query, user.id, RESET_HOURS);
    await mailer.sendPasswordLink(user, token, 'reset');
  }
  return { message: 'If that email belongs to an active account, a reset link is on its way.' };
}

async function resetPassword(db, body = {}) {
  const token = typeof body.token === 'string' ? body.token : '';
  validateNewPassword(body.new_password);
  if (!token) throw httpError(400, 'Reset link is invalid.');

  return db.transaction(async (q) => {
    const row = (await q(
      `SELECT t.user_id, u.name FROM password_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.expires_at > now() AND u.active FOR UPDATE OF t`,
      [sha256(token)]
    )).rows[0];
    if (!row) throw httpError(400, 'This link is invalid or has expired. Request a new one.');
    await q(
      `UPDATE users SET password_hash = $2, must_change_password = FALSE, token_version = token_version + 1,
              failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [row.user_id, await bcrypt.hash(body.new_password, 10)]
    );
    await q('DELETE FROM password_tokens WHERE user_id = $1', [row.user_id]);
    await audit(q, { id: row.user_id, name: row.name }, 'password.reset', `${row.name} set a new password via email link`);
    return { message: 'Password updated. You can now sign in.' };
  });
}

// --- Admin helpers ---
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const generateTempPassword = (len = 12) => Array.from({ length: len }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]).join('');

async function setTemporaryPassword(db, actor, userId) {
  const password = generateTempPassword();
  const user = (await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = TRUE, token_version = token_version + 1,
            failed_logins = 0, locked_until = NULL
     WHERE id = $1 RETURNING id, name, email`,
    [userId, await bcrypt.hash(password, 10)]
  )).rows[0];
  if (!user) throw httpError(404, 'Staff member not found.');
  await db.query('DELETE FROM password_tokens WHERE user_id = $1', [userId]);
  await audit(db.query, actor, 'staff.temp_password', `${actor.name} issued a temporary password for ${user.name}`);
  return { password, user };
}

async function sendSetupEmail(db, actor, userId) {
  if (!mailer.emailConfigured()) throw httpError(400, 'Email is not configured (SMTP settings missing). Use "Set temporary password" instead.');
  if (!mailer.appUrl()) throw httpError(400, 'APP_URL is not set, so the email link would not work.');
  const user = (await db.query('SELECT id, name, email, active FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) throw httpError(404, 'Staff member not found.');
  if (!user.active) throw httpError(400, 'Reactivate this account first.');
  const token = await createPasswordToken(db.query, user.id, SETUP_HOURS);
  const sent = await mailer.sendPasswordLink(user, token, 'setup');
  if (!sent) throw httpError(502, 'The email could not be sent. Check the SMTP settings.');
  await audit(db.query, actor, 'staff.setup_email', `${actor.name} sent a password set-up email to ${user.name}`);
  return { message: `Set-up email sent to ${user.email}.` };
}

module.exports = {
  login, requireAuth, changePassword, requestPasswordReset, resetPassword,
  setTemporaryPassword, sendSetupEmail, publicUser, MIN_PASSWORD_LENGTH,
};
