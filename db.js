// Database access. Production: Postgres via DATABASE_URL / POSTGRES_URL (Neon, Supabase…).
// Local dev & tests without a URL: PGlite (Postgres compiled to WASM, in memory),
// seeded with fictional demo data.
//
// Every driver exposes:
//   query(text, params)  -> { rows }
//   transaction(fn)      -> fn(q) where q(text, params) runs inside the transaction

const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./errors');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
let dbPromise;

// DATABASE_URL / POSTGRES_URL, or a prefixed variant (e.g. STORAGE_DATABASE_URL) if the
// Vercel integration was connected with a custom prefix. Pooled URLs only.
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const key = Object.keys(process.env).sort().find((k) => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && !/UNPOOLED|NON_POOLING|^TEST_/.test(k));
  return key ? process.env[key] : '';
}

function createPgDriver(connectionString) {
  const { Pool } = require('pg');
  // Small pool: each serverless instance only needs a couple of connections.
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  return {
    kind: 'postgres',
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

async function createPgliteDriver({ demo = true } = {}) {
  const pkg = '@electric-sql/pglite'; // dev dependency; not bundled into the Vercel function
  const { PGlite } = await import(pkg);
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  // PGlite has a single connection: serialise everything so a transaction is never interleaved.
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  const driver = {
    kind: 'pglite',
    query: (text, params) => exclusive(() => pg.query(text, params)),
    transaction: (fn) => exclusive(() => pg.transaction((tx) => fn((text, params) => tx.query(text, params)))),
    end: () => pg.close(),
  };
  if (demo) await require('./demo').seedDemo(driver);
  return driver;
}

function getDb() {
  if (!dbPromise) {
    const url = databaseUrl();
    if (url) dbPromise = Promise.resolve(createPgDriver(url));
    else if (process.env.VERCEL) dbPromise = Promise.reject(httpError(503, 'Database not configured. Connect a Postgres database in Vercel → Storage, then redeploy.'));
    else dbPromise = createPgliteDriver();
    dbPromise.catch(() => { dbPromise = undefined; });
  }
  return dbPromise;
}

// Tests: inject a driver.
function setDb(driver) {
  dbPromise = Promise.resolve(driver);
}

async function databaseStatus() {
  try {
    return (await getDb()).kind;
  } catch {
    return 'missing';
  }
}

module.exports = { getDb, setDb, databaseStatus, createPgDriver, createPgliteDriver, SCHEMA_PATH };
