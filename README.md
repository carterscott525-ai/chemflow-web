# ChemFlow Web — owned multi-tenant app (Phase 1)

The owned replacement for the AppSheet prototype: one web app that serves many
pool businesses (tenants), free to them, hosted on free/cheap tiers. Spec:
`../goals/pool-service-software-and-auto-chlorination-system/files/chemflow-web-build-spec.md`.

## Stack

- **Front end:** static PWA (`index.html`, `app.js`, `sw.js`, `manifest.json`) —
  hosted on GitHub Pages. Offline: service worker caches the shell; the day's
  route is cached in localStorage; check-ins made with no signal queue in
  IndexedDB and auto-sync when connectivity returns.
- **Back end:** Supabase (Postgres + Auth + Storage). All tenant isolation is
  enforced by Row Level Security in `schema.sql` — every tenant table carries
  `business_id`, and policies resolve the caller's business from their profile.
  The anon key in `config.js` is safe to publish *because* RLS guards the data.
- **Device layer:** unchanged — per-business Google Sheet + Apps Script
  (sync, dosing, alerts, customer dashboards). Live-reading prefill in the
  check-in form is Phase 3; Phase 1 prefills from the customer's last visit.

## Phase 1 scope

Accounts (owner creates a business; technicians join by email invite),
customers (+ auto "Main Pool" body), today's route by service day,
check-in/out with chemistry, Standard Visit checklist (owner-editable),
photos (compressed client-side, stored per-business in the `visit-photos`
bucket), notes, offline queue.

Check-in is one tap (Carter's rule): tapping Check In records the time and,
if the phone offers it within ~3.5s, the GPS location — nothing else is
required. Chemistry, checklist, photos and notes are optional details that
can be added any time before Check Out; each stage (check-in, details,
check-out) queues offline independently and syncs in order.

Known Phase 1 simplifications: techs can see all in-business visits
(route context); email confirmation is OFF in the Supabase project for the
pilot (turn ON before public launch); no password-reset email flow yet.

## Setup (already done once — repeat for a fresh project)

1. Create a Supabase project; in the SQL editor, run `schema.sql` top to bottom.
2. Authentication → Providers → Email: enable; disable "Confirm email" (pilot).
3. Put the project URL + anon key in `config.js`.
4. Push this folder to the `chemflow-web` GitHub repo; enable Pages (main, root).

## Files

- `schema.sql` — tables, RLS policies, storage bucket + policies.
- `index.html` — markup + styles (single page, mobile-first).
- `app.js` — all logic (auth, route, check-in, customers, team, settings, queue).
- `config.js` — backend URL + anon key (the only environment-specific file).
- `sw.js`, `manifest.json` — PWA shell.
