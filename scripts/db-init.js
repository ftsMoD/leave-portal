// Creates tables. Usage: npm run db:init
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { requireDatabaseUrl } = require('./env');

(async () => {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    console.log('Schema applied.');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
