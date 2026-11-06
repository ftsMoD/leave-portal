import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Mounts the same Express app that Vercel runs at /api onto Vite's dev and
// preview servers, so `npm run dev` gives you frontend + backend on one port.
// (On Vercel, api/index.js is deployed as a serverless function instead.)
function apiMiddleware() {
  const mount = (server) => {
    const app = require('./api/index.js');
    server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith('/api')) return next();
      app(req, res, next);
    });
  };
  return {
    name: 'leave-portal-api',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig(({ mode }) => {
  // Make .env / .env.local values (DATABASE_URL, JWT_SECRET) visible to the API locally.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // Local convenience only: this config never runs inside Vercel's API function,
  // so production still refuses to start auth without a real JWT_SECRET.
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'local-dev-only-not-for-production';
  }
  return {
    plugins: [react(), apiMiddleware()],
  };
});
