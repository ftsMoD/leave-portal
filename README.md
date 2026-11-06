# Leave Portal — Vercel monorepo

React (Vite + Tailwind) frontend and an Express API deployed together on Vercel. The API runs as one serverless function (`api/index.js`). Data lives in Postgres, or in memory when no database is configured (demo mode).

## Project structure

```
leave-portal/
├── api/
│   └── index.js            # Express backend (Vercel serverless function)
├── server/                 # Backend modules, bundled into the function
│   ├── auth.js             # login, JWT, password change
│   ├── leave.js            # leave workflow rules
│   ├── dates.js            # working-day calculation
│   └── store/              # storage: postgres.js | memory.js (demo)
├── src/
│   ├── App.jsx             # shell, login, tabs
│   ├── views/              # EmployeeView.jsx, ManagerView.jsx
│   ├── components.jsx
│   ├── lib/                # api.js, dates.js
│   ├── main.jsx            # React entry point
│   └── index.css           # Tailwind imports
├── db/
│   ├── schema.sql
│   └── seed.example.json   # copy to db/seed.json (git-ignored)
├── scripts/                # db-init.js, db-seed.js
├── tests/api.test.js
├── index.html
├── package.json
├── tailwind.config.js
├── postcss.config.js
├── vite.config.mjs
└── vercel.json
```

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173 (frontend and /api on one port)
```

If `DATABASE_URL` isn't set, the app runs in **demo mode**. You can sign in as `employee@company.com` or `manager@company.com`, both with the password `password123`. Restart `npm run dev` after you change any file under `api/` or `server/`.

```bash
npm test             # API tests (in-memory)
TEST_DATABASE_URL=postgres://... npm test   # same tests against Postgres. This DROPS the app tables in that DB.
```

## Deploy to Vercel

1. **Push to GitHub**
   ```bash
   git init && git add . && git commit -m "Leave portal"
   git branch -M main
   git remote add origin <YOUR_GITHUB_REPO_URL>
   git push -u origin main
   ```
2. **Import in Vercel.** Go to Add New → Project and pick the repo. The settings come from `vercel.json` (framework Vite, output `dist`, `/api/*` goes to the function).
3. **Set `JWT_SECRET`** under Project → Settings → Environment Variables. Generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
   Without it, login returns HTTP 500 on purpose. There is no built-in fallback secret.
4. **Add a database.** Go to Project → Storage and add Postgres from the Marketplace (Neon or Supabase). It should inject `DATABASE_URL` or `POSTGRES_URL`, and the API accepts either. Use the **pooled** connection string.
5. **Create tables and load staff** from your machine:
   ```bash
   npm i -g vercel && vercel link
   vercel env pull .env.local          # pulls DATABASE_URL locally
   npm run db:init
   cp db/seed.example.json db/seed.json   # edit: real staff and entitlements
   npm run db:seed                      # prints temporary passwords for new users
   ```
6. **Redeploy** so the function picks up the env vars. Then check that `https://<app>.vercel.app/api/health` returns `"storage":"postgres"`.

To make changes later, edit `db/seed.json` and run `npm run db:seed` again. It updates names, roles, `active` and entitlements. It never overwrites existing passwords or `used_days`. To offboard someone, set `"active": false`.

## What changed from the blueprint

| Blueprint issue | Fix |
|---|---|
| In-memory data on serverless is lost on cold starts and differs between instances | Postgres store. Memory remains only as a labelled demo mode |
| Plain-text passwords | bcrypt hashes. Users can change their password in the app |
| Hard-coded JWT fallback secret (`super_secret_leave_portal_key`) lets anyone forge a manager token | `JWT_SECRET` is required on Vercel |
| Any logged-in user could approve requests, including their own | Only managers can approve or reject, and never their own requests |
| `user_id` came from the request body, so anyone could file leave for anyone | The applicant is always the signed-in user |
| `total_days: 2` hard-coded in the UI | The server counts working days (Mon–Fri). The UI shows a preview |
| Every employee could see everyone's requests and balances | Employees see only their own. Managers see the whole team |
| Approving the same request twice deducted the balance twice | Only `Pending` requests can be decided. Updates use row locks inside a transaction |
| Pending requests weren't counted, so staff could over-apply | Available = total − used − pending, checked on apply and again on approve |
| No overlap check | Overlapping pending or approved requests are rejected |
| `react-scripts` (Create React App) is deprecated | Vite |
| Open `cors()` | Removed. The frontend and API share one origin |
| JSX was lost in the PDF export | Rebuilt the frontend. Added cancel, filters, a balance breakdown and inline errors instead of `alert()` |

## API

All routes except login and health need `Authorization: Bearer <token>`.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/health` | anyone | `{ storage: "postgres" \| "memory" }` |
| POST | `/api/auth/login` | anyone | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | signed in | current user |
| POST | `/api/auth/password` | signed in | `{ current_password, new_password }` |
| GET | `/api/balances/:userId` | own / manager | `me` allowed. Includes `pending_days` |
| GET | `/api/leave/requests` | signed in | Employees get their own. Managers get all (`?scope=mine` returns only theirs) |
| POST | `/api/leave/apply` | signed in | `{ leave_type, start_date, end_date, reason }` |
| PATCH | `/api/leave/requests/:id` | manager / owner | `{ status: "Approved" \| "Rejected" }` (manager) or `"Cancelled"` (owner, while pending) |

## Known limitations (not built yet)

- **Public holidays aren't excluded** from day counts. Only weekends are. Singapore PH would need a holiday table.
- **No half-days.** Days are whole numbers.
- **No annual reset or carry-forward.** Change entitlements with the seed script for now.
- **Single approval tier.** Any manager can approve any non-manager. A manager's own leave needs a *different* manager, so if there is only one manager, their requests can't be approved in the app.
- **No email or Slack notifications** for new or decided requests.
- **Auth is email and password.** Google Workspace SSO would remove password handling entirely and is the recommended next step for internal use.
- **No login rate limiting.** An in-memory limiter doesn't work across serverless instances. Use Vercel Firewall rules or an Upstash-backed limiter.
- **The token is stored in `localStorage`** (same as the blueprint). An httpOnly cookie would be stronger against XSS.
- **No HR/admin UI** for adding users or adjusting balances. It's script-based for now.

## Things to verify on your first preview deploy

These were tested locally (API tests on memory and Postgres 16, plus a browser walkthrough), but not on Vercel itself:

- `/api/health` responds, which confirms the rewrite reaches Express with the original path.
- Node `22.x` (from `engines`) is accepted by your Vercel project settings.
- Your Postgres integration's env var name (`DATABASE_URL` or `POSTGRES_URL`) and SSL settings work with the pooled URL.
