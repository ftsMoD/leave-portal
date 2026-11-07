-- Leave Portal schema. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS leave_types (
  name          TEXT PRIMARY KEY,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  location_only TEXT            -- e.g. 'Singapore': hidden for staff in other locations
);

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name                 TEXT NOT NULL,
  location             TEXT NOT NULL DEFAULT '',
  role                 TEXT NOT NULL CHECK (role IN ('user', 'approver', 'admin')),
  manager_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  password_hash        TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  token_version        INTEGER NOT NULL DEFAULT 0,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (manager_id IS NULL OR manager_id <> id)
);

-- One row per user per leave type they can use. No row = "N/A" (type hidden).
-- days_per_year NULL = "Unlimited".
CREATE TABLE IF NOT EXISTS entitlements (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type    TEXT NOT NULL REFERENCES leave_types(name) ON UPDATE CASCADE,
  days_per_year INTEGER CHECK (days_per_year IS NULL OR days_per_year >= 0),
  PRIMARY KEY (user_id, leave_type)
);

-- Manual +/- days for a given calendar year (e.g. leave taken before go-live).
CREATE TABLE IF NOT EXISTS balance_adjustments (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type  TEXT NOT NULL REFERENCES leave_types(name) ON UPDATE CASCADE,
  year        INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  days        INTEGER NOT NULL CHECK (days <> 0),
  reason      TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type     TEXT NOT NULL REFERENCES leave_types(name) ON UPDATE CASCADE,
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  total_days     INTEGER NOT NULL CHECK (total_days > 0),
  details        TEXT NOT NULL DEFAULT '',   -- "what type of leave" for Unlimited types
  reason         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Pending'
                 CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  approver_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- line manager notified at submission
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL,
  action      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_manager_idx          ON users (manager_id);
CREATE INDEX IF NOT EXISTS leave_requests_user_idx    ON leave_requests (user_id);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx  ON leave_requests (status);
CREATE INDEX IF NOT EXISTS leave_requests_dates_idx   ON leave_requests (start_date, end_date);
CREATE INDEX IF NOT EXISTS adjustments_user_year_idx  ON balance_adjustments (user_id, year);
CREATE INDEX IF NOT EXISTS audit_log_created_idx      ON audit_log (created_at DESC);
