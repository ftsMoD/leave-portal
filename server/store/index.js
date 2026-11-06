// Picks the storage backend once per function instance.
//   DATABASE_URL / POSTGRES_URL set  -> Postgres (persistent)
//   neither set                      -> in-memory demo data (resets on cold start)

let store;

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

function getStore() {
  if (store) return store;
  const connectionString = getConnectionString();
  if (connectionString) {
    const { createPostgresStore } = require('./postgres');
    store = createPostgresStore(connectionString);
  } else {
    const { createMemoryStore } = require('./memory');
    store = createMemoryStore();
  }
  return store;
}

// Test helper: swap in a specific store.
function setStore(next) {
  store = next;
}

module.exports = { getStore, setStore, getConnectionString };
