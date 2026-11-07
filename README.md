# Leave Portal

Leave requests, line-manager approvals, balances, email notifications, exports and live reports. It's a React (Vite + Tailwind) frontend and an Express API, deployed together on Vercel, with data in Postgres (Neon).

> **Keep staff data out of this repo.** The generated `setup.sql` and any staff list stay off GitHub. The demo data in `server/demo.js` is fictional.

## Roles

| Role | Can do |
|---|---|
| **User** | Request leave, cancel their own pending requests, see their own balances and history, download their own CSVs |
| **Approver** | Everything a User can do, plus approve or reject requests from **direct reports** and see their balances (My team) |
| **Administrator** | Everything an Approver can do, plus approve any request (the backup when a line manager can't), add, edit or delete any leave record, manage staff, roles, entitlements and balance adjustments, see live reports and download reports |

Nobody can approve their own leave, including the Administrator.

## Leave rules

- **Entitlement "N/A"** means the leave type is hidden from that person's dropdown.
- **"Unlimited"** types (Unpaid and Other) have no balance limit. A *Type of leave* note is required, for example "Bereavement". Admins can edit it later.
- **Childcare Leave is Singapore-only.** It's hidden for anyone whose location isn't Singapore, even if an entitlement exists.
- **Working days** are Monday to Friday. Public holidays are booked as their own leave type, with 11 days a year.
- **Leave year** is the calendar year. Entitlements reset on 1 January and unused days don't carry forward. A request that spans New Year is split across both years.
- **Available** = entitlement + adjustments − approved − pending. It's checked when someone submits a request and checked again on approval.
- **Overlapping** pending or approved requests are rejected.

## Notifications

- When someone submits a request, their **line manager** gets an email with a link that opens the request. If they have no line manager, the email goes to the Administrators.
- When a request is approved or rejected, the **employee** gets an email with the approver's comment.
- If the Administrator issues a set-up email or someone uses "Forgot password", they get a link that expires after 72 hours (set-up) or 1 hour (reset).

If SMTP isn't configured, the portal works without email and shows the Administrator a banner.

## Security

- Passwords are hashed with bcrypt and must be at least 10 characters. Temporary passwords must be changed at first sign-in.
- An account locks for 15 minutes after 5 failed sign-ins. The lock is stored in the database, so it works across serverless instances.
- Sessions use JWTs that expire after 8 hours. Changing or resetting a password, or deactivating the account, signs the user out everywhere.
- Every change is written to an audit log, which appears under Reports → Recent activity and can be exported.
- CSV exports are protected against formula injection.

## Deploy (Vercel + Neon)

1. Import this repo into Vercel. The framework (Vite) and the `/api` rewrite are set in `vercel.json`.
2. Add a database under **Storage**: Neon (Postgres), connected to the project for all environments. This sets `DATABASE_URL`.
3. Create the tables and staff. Run `npm run setup-sql -- staff.json > setup.sql` (format documented in `scripts/make-setup-sql.js`), paste `setup.sql` into Neon's SQL Editor and run it. This prints the Administrator's temporary password.
4. Add environment variables (see `.env.example`): `JWT_SECRET`, `APP_URL`, and the `SMTP_*` and `MAIL_FROM` settings.
5. Redeploy. `/api/health` should show `"database":"postgres","email":true`.

### Email with Google Workspace

Use a mailbox such as `leave@yourcompany.com`. That account needs 2-Step Verification turned on so you can create an **App Password** (Google Account → Security → App passwords). Then set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=leave@yourcompany.com
SMTP_PASS=<16-character app password, no spaces>
MAIL_FROM=Leave Portal <leave@yourcompany.com>
```

Your Workspace admin may need to allow app passwords. `MAIL_FROM` must be that mailbox or one of its "Send mail as" aliases. Any other SMTP provider (Resend, SendGrid, Microsoft 365) also works.

## Local development

```bash
npm install
npm run dev     # http://localhost:5173 — demo data in memory (PGlite), no setup needed
npm test        # API tests on PGlite
TEST_DATABASE_URL=postgres://... npm test   # same tests on real Postgres (DROPS the app tables there)
```

Demo sign-ins use the password `password123`: `admin@example.com` (Administrator), `ceo@example.com` (Approver) and `employee@example.com` (User).

## API overview

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` · `/forgot` · `/reset` | anyone |
| GET/POST | `/api/auth/me` · `/api/auth/password` | signed in |
| GET | `/api/my/leave-options` | signed in |
| GET | `/api/balances?scope=mine\|team\|all&year=` | own / approver / admin |
| GET | `/api/requests?scope=mine\|approvals\|all&year=&status=` | own / approver / admin |
| POST | `/api/requests` | signed in (apply) |
| PATCH | `/api/requests/:id` | owner (`Cancelled`), line manager or admin (`Approved`/`Rejected`) |
| POST/PUT/DELETE | `/api/admin/requests[/:id]` | admin |
| GET/POST/PUT/DELETE | `/api/admin/staff[/:id]`, `/temp-password`, `/setup-email` | admin |
| GET/POST/DELETE | `/api/admin/adjustments[/:id]` | admin |
| GET | `/api/admin/reports/summary` | admin |
| GET | `/api/export/my-requests.csv` · `my-balances.csv` | signed in |
| GET | `/api/export/requests.csv` · `balances.csv` · `staff.csv` · `activity.csv` | admin |

## Not built yet

- Half-day leave
- Carry-forward or anniversary-based leave years
- Multi-step approvals
- Reminder or escalation emails when a request sits pending
- Team calendar view
- SSO
