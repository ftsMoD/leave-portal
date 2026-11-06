// Loads .env.local / .env for CLI scripts (Node 20.12+ / 22).
const fs = require('node:fs');
const path = require('node:path');

for (const file of ['.env.local', '.env']) {
  const full = path.join(__dirname, '..', file);
  if (fs.existsSync(full)) process.loadEnvFile(full);
}

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('DATABASE_URL (or POSTGRES_URL) is not set. Add it to .env.local or run `vercel env pull .env.local`.');
    process.exit(1);
  }
  return url;
}

module.exports = { requireDatabaseUrl };
