-- Leave Portal schema. Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('employee', 'manager')),
  password_hash TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type  TEXT NOT NULL,
  total_days  INTEGER NOT NULL CHECK (total_days >= 0),
  used_days   INTEGER NOT NULL DEFAULT 0 CHECK (used_days >= 0),
  UNIQUE (user_id, leave_type)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type  TEXT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  total_days  INTEGER NOT NULL CHECK (total_days > 0),
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'Pending'
              CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  decided_by  INTEGER REFERENCES users(id),
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS leave_requests_user_idx   ON leave_requests (user_id);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx ON leave_requests (status);
