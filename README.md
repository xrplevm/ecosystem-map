# XRPL EVM Ecosystem Map

A responsive, dark-themed dashboard that pins the XRPL EVM ecosystem
(Wallets, Bridges, dApps, Oracles, Indexers, DAOs, Explorers, Validators,
Core, Auditors, Providers) onto a single page of interactive cards. New
projects are submitted via a custom form, staged in Airtable, and
approved per-surface in batch from Slack.

---

## Project overview

Two things live in this repo:

1. **Public site** (`src/`) — a Create React App that fetches the
   canonical `explorer-apps.json` registry from S3 at runtime, filters
   it to entries opted-in to the ecosystem-map surface, groups them by
   section, and renders a card per entry. A bundled snapshot in
   `public/explorer-apps.snapshot.json` keeps the page rendering when
   the live S3 read fails.
2. **Submission and approval pipeline** (`api/`) — three Vercel
   serverless endpoints:
   - `POST /api/submit` accepts `multipart/form-data` from the embedded
     submission form, validates with Zod, and stages the submission in
     **Airtable** as a `Status = Pending` row (the raw logo is attached
     to the row). **Nothing is written to S3 until approval.** It posts a
     lightweight Slack notice linking the Airtable record.
   - `POST /api/slack/commands` handles the `/explorer-admin` slash
     command, opening a multi-mode modal (Pending / Existing / Seed).
   - `POST /api/slack/actions` handles every interactive payload from
     that modal. In Pending mode the reviewer checks each row under the
     surface to publish it to — **Explorer dApps**, **Ecosystem map**, or
     **Both** — or **Reject**. On approve the logo is normalised to a
     250×250 PNG, uploaded to S3, and the entry is appended to
     `explorer-apps.json` (atomic conditional PUT) with the chosen
     `surfaces`; the row is set to `Approved`. Existing/Seed modes mutate
     the registry directly.

Both halves share a typed registry shape (`src/lib/explorer-apps-types.ts`),
a Zod validator (`src/lib/schemas/explorer-app.ts`), and an env loader
(`src/lib/env.ts`).

---

## Architecture

```
                         ┌─────────────────────────────┐
   submitter (browser)   │   POST /api/submit          │
   ──────────────────▶   │   • Zod validate            │
                         │   • create Airtable row      │
                         │     (Status = Pending)       │
                         │   • attach raw logo          │
                         │   • Slack notice (link)      │   ← NO S3 write
                         └────────────┬────────────────┘
                                      │
                                      ▼
                       ┌────────────────────────────────┐
                       │  Airtable = pending queue       │
                       │  (Status = Pending rows)        │
                       └────────────┬───────────────────┘
                                    │ /explorer-admin
                                    ▼
   maintainer ──▶  POST /api/slack/commands  ──▶  open modal
                         │                          (Pending | Existing | Seed)
                         │  modal submit
                         ▼
                   POST /api/slack/actions
                   ├─ pending  → per row: choose surface (dApps | map | both) or reject
                   │            approve → download logo → normalise 250×250 →
                   │            putLogo(S3) → withEtagRetry append explorer-apps.json →
                   │            Airtable Status=Approved ; reject → Status=Rejected
                   ├─ existing → withEtagRetry: read JSON → edit/delete → PUT (If-Match)
                   └─ seed     → withEtagRetry: read seed.json → overwrite explorer-apps.json
                         │
                         ▼
              ┌──────────────────────────────┐
              │  s3://peersyst-development/  │
              │    explorer-apps.json        │  ←── single source of truth
              │    explorer-dapp-<id>.png    │
              └──────────┬───────────────────┘
                         │ HTTPS GET (?ts=… cache-buster, no-store)
                         ▼
              src/App.tsx renders cards.
              On fetch/parse failure → public/explorer-apps.snapshot.json.
```

Key invariants:

- **One source of truth**: `s3://$S3_BUCKET/$S3_JSON_KEY`. No
  PR-to-self, no committed registry checked into the repo, no redeploy
  per entry.
- **Nothing in S3 until approval**: submissions live in Airtable (logo
  as an attachment); the S3 write happens only when a reviewer approves.
- **Atomic writes**: every registry mutation goes through `withEtagRetry`
  in `src/lib/s3-client.ts`. Concurrent approvals can't overwrite each
  other; on `412 Precondition Failed` the helper re-reads, re-applies the
  same diff, and retries (default 3 attempts). **Bucket versioning must
  be ON** for this to be safe.
- **Airtable as pending queue**: the modal lists rows where
  `Status = Pending` (live `filterByFormula` query) — no Slack-history
  scan, no metadata tagging. Status transitions (`Approved` / `Rejected`)
  are written back to the row.
- **Two surfaces, one row, chosen at approval**: each row carries
  `surfaces?: ("explorer-apps" | "ecosystem-map")[]` (default
  `["explorer-apps"]`) and `ecosystemSection?: SectionId` (required when
  `surfaces` includes `"ecosystem-map"`). The submission does not bake in
  `surfaces` — the reviewer picks the target surface(s) at approval, and
  `ecosystemSection` is dropped for dApps-only targets. The frontend
  filters on `surfaces` so the registry stays lean for the dApp explorer.

---

## Repository layout

```
ecosystem-map-xrplevm/
  api/
    submit.ts                       # POST /api/submit (multipart intake)
    slack/
      commands.ts                   # POST /api/slack/commands (/explorer-admin)
      actions.ts                    # POST /api/slack/actions (modal submit + block actions)
  public/
    explorer-apps.snapshot.json     # degraded-mode fallback for the frontend
    assets/                         # logos, brand lines, etc.
  scripts/
    generate-seed.ts                # offline merge of legacy ecosystem.json + S3 registry
    lib/seed-builder.ts             # pure merge logic (tested)
  src/
    App.tsx                         # fetch → filter (surfaces) → group → render
    components/                     # SectionCard, SubmitProjectForm, modal, etc.
    data/sections.ts                # SectionId → display title
    lib/
      env.ts                        # Zod-validated process.env
      errors.ts                     # typed errors with stable codes
      multipart.ts                  # busboy streaming parser with byte cap
      slug.ts                       # kebab-case slugify
      slack.ts                      # HMAC verify, postMessage
      slack-batch.ts                # /explorer-admin modal builder + handlers + approval artifacts
      airtable.ts                   # Airtable client: create / upload icon / list pending / set status
      logo-image.ts                 # normalizeLogo → 250×250 PNG, 30px rounded (sharp)
      s3-client.ts                  # getJson / putJsonIfMatch / withEtagRetry / putLogo
      explorer-apps-types.ts        # canonical row shape
      explorer-apps-source.ts       # browser loader: fetch S3 → fallback to snapshot
      schemas/
        explorer-app.ts             # Zod schema for the registry row (used by api/ + scripts/)
        explorer-apps.ts            # CATEGORY_OPTIONS vocab + ExplorerCategory
        ecosystem.ts                # legacy schema retained for SectionId / form types
        submission.ts               # shared frontend ↔ backend payload schema
        submission-form.ts          # extends submission with File-based logo
  .env.example
  package.json
  tsconfig.json
```

---

## Local development

### Prerequisites

- Node 20+ (Vercel runtime target).
- npm 9+ (`pnpm`/`yarn` work too — lockfile is npm).

### Install and run

```bash
npm install
npm start                  # frontend only at http://localhost:3000
npx vercel dev             # frontend + serverless functions
```

`/api/*` endpoints 404 in plain `npm start`; use `vercel dev` to
exercise them locally. `vercel dev` requires `.env.local` populated
(see [Environment variables](#environment-variables)).

### Verify gate

```bash
npm run lint               # ESLint with the CRA react-app config
npm run typecheck          # tsc --noEmit, covers src + api + scripts
CI=true npm test           # Jest, single pass, exits on completion
npm run build              # static build to ./build
```

---

## Environment variables

Copy `.env.example` to `.env.local` and fill it in. `src/lib/env.ts`
validates the process environment with Zod at module load and fails
fast with a structured `EnvValidationError` if anything is missing or
malformed (secret values are never interpolated into the error
message).

| Variable | Group | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack | Bot token (`xoxb-…`). Scopes below. |
| `SLACK_SIGNING_SECRET` | Slack | Signing secret used for HMAC verify on every Slack-bound request. ≥32 chars. |
| `SLACK_APPROVAL_CHANNEL` | Slack | Channel ID (not name) where `/api/submit` posts the submission notice and where the batch summary + approval artifacts land. Get it via right-click channel → "Copy link" — trailing path segment, starts with `C`. |
| `AIRTABLE_API_KEY` | Airtable | Personal Access Token. Runtime needs `data.records:read` + `data.records:write`. The one-time field provisioner (`npm run airtable:setup`) additionally needs `schema.bases:read` + `schema.bases:write` **and Creator access to the base**. |
| `AIRTABLE_BASE_ID` | Airtable | Base holding the submission queue. Default `appDFL9N9MDWj0Ywd`. |
| `AIRTABLE_TABLE_ID` | Airtable | Table holding the submission queue. Default `tblSXGty3mcKj7F62`. |
| `AWS_REGION` | AWS / S3 | Region of the bucket. Default `eu-west-1`. |
| `S3_BUCKET` | AWS / S3 | Bucket holding `explorer-apps.json` and dApp logos. Default `peersyst-development`. |
| `S3_JSON_KEY` | AWS / S3 | Object key of the canonical registry. Default `explorer-apps.json`. |
| `AWS_ACCESS_KEY_ID` | AWS / S3 | IAM access key. Required for the Slack approval handler (write paths). Read-only deploys can omit it. |
| `AWS_SECRET_ACCESS_KEY` | AWS / S3 | Matching IAM secret. Required only when `AWS_ACCESS_KEY_ID` is set. |
| `REACT_APP_EXPLORER_APPS_URL` | Frontend (CRA) | Public URL of `explorer-apps.json` the browser should fetch. Inlined into the bundle at build time. Defaults to `https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-apps.json`. |
| `SUBMISSION_LOGO_MAX_BYTES` | Logo limits | Max logo size accepted by `/api/submit`, in bytes. Default `500000` (~500KB). |

In Vercel, set these under **Project Settings → Environment Variables**
with the appropriate scopes (Production / Preview / Development). All
non-`REACT_APP_*` variables are read at function-cold-start; the
`REACT_APP_EXPLORER_APPS_URL` value is inlined at build time, so a
change requires a redeploy.

---

## Slack app setup

1. Create an app at <https://api.slack.com/apps> from scratch.
2. **OAuth & Permissions → Bot Token Scopes** (minimum):
   - `commands` — register `/explorer-admin`.
   - `chat:write` — post the submission notice and batch summary.
   - `chat:write.public` — post in channels the bot is not a member of (only needed if approvals land in such a channel; otherwise optional).
   - `views:open`, `views:update` — open and update the `/explorer-admin` modal.
   - `files:write` — upload the updated `explorer-apps.json` and added logos to the channel after an approval batch.

   > The pending queue lives in **Airtable**, not Slack — so the older
   > `metadata.message:read`, `channels:history`, and `reactions:write`
   > scopes are no longer needed.
3. Install the app to the workspace; copy the resulting **Bot User
   OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`.
4. The **Signing Secret** lives under **Basic Information → App
   Credentials** — copy into `SLACK_SIGNING_SECRET`.
5. **Slash Commands → Create New Command**:
   - Command: `/explorer-admin`
   - Request URL: `https://<your-deploy>.vercel.app/api/slack/commands`
   - Short description: "Manage ecosystem submissions"
6. **Interactivity & Shortcuts → Interactivity ON**:
   - Request URL: `https://<your-deploy>.vercel.app/api/slack/actions`
7. Invite the bot into the approval channel (`/invite @your-bot-name`)
   and copy that channel's ID into `SLACK_APPROVAL_CHANNEL`.

Both `/api/slack/commands` and `/api/slack/actions` verify the Slack
signature on every request (timing-safe HMAC + ±5 minute replay
window). `bodyParser: false` is set on each handler so the raw bytes
match what Slack signed — do not introduce middleware that rewrites
the body.

---

## AWS S3 setup

The bucket is the only persistent state in the system. Configure it
once per environment:

1. **Create the bucket** (default: `peersyst-development`,
   `eu-west-1`).
2. **Enable versioning** (Properties → Bucket Versioning → Enable).
   This is **mandatory** — `withEtagRetry` relies on stable, returnable
   ETags. With versioning OFF the conditional PUT degrades to
   last-write-wins and concurrent approvals will lose entries (R1
   below).
3. **Public read** of the JSON and logos: either grant `s3:GetObject`
   on the bucket via a bucket policy scoped to the relevant keys, or
   front the bucket with a CDN that does. The frontend fetches the
   JSON over plain HTTPS with `cache: "no-store"` and a `?ts=…`
   cache-buster — no signed URLs.
4. **CORS** (R2 below). The bucket must allow `GET` from the Vercel
   origin so the browser can fetch `explorer-apps.json`. Minimum
   policy:

   ```json
   [
     {
       "AllowedOrigins": ["https://<your-deploy>.vercel.app", "http://localhost:3000"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 60
     }
   ]
   ```
5. **IAM policy** for the credentials in
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (write paths only):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:GetObject",
           "s3:GetObjectVersion",
           "s3:PutObject",
           "s3:DeleteObject"
         ],
         "Resource": "arn:aws:s3:::peersyst-development/*"
       }
     ]
   }
   ```

   `s3:GetObjectVersion` is what makes ETag-based concurrency work on a
   versioned bucket; `s3:DeleteObject` is needed to clean up logos on
   delete and to remove `pending-seed.json` after a seed apply.

---

## Airtable setup (submission queue)

Submissions are staged in an Airtable base (`AIRTABLE_BASE_ID` /
`AIRTABLE_TABLE_ID`). The **table already exists** — what the pipeline
needs is a fixed set of fields on it.

**Reused (already on the table):** `Name`, `Website`, `Description`
(short tagline), `Contact email`, and the attachment field for the logo
(stored by id `fldind6amgF8zBmR6`; in the Airtable UI it is the
template-leftover field literally named **"Assignee"**).

**Provisioned by the setup script** (10 fields): `Section`,
`Long description`, `Categories`, `Author`, `Site`, `GitHub`,
`Submitter name`, `Status` (`Pending`/`Approved`/`Rejected`),
`Registry id`, `Logo URL`.

### Bootstrap the fields (one-time)

```bash
# Requires AIRTABLE_API_KEY with schema.bases:read + schema.bases:write
# AND Creator access to the base (Editor returns 403 on field creation).
AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… AIRTABLE_TABLE_ID=… npm run airtable:setup
```

`scripts/airtable-setup.ts` is **idempotent** — it lists current fields
and `POST`s only the missing ones (a duplicate-name error is treated as
"already there"), so it is safe to re-run. Field choice lists (sections,
categories) are imported from the app schemas so Airtable stays in sync
with the code. Alternatively, create the 10 fields by hand in the
Airtable UI with the names/types above.

> **Why not run this on every deploy?** It mutates external schema, so a
> transient Airtable/API error would fail the deploy; the build would
> need a PAT with broad `schema.bases:write` scope (the runtime only
> needs `data.records:*`); and field creation is a one-time bootstrap,
> not a per-deploy concern. Keep it a manual step (or a CI job gated to
> run once), not part of the build command.

---

## Submission lifecycle

A single-flow walkthrough for maintainers:

1. **Submitter** opens the "Submit your project" modal in the footer
   and posts the form. The browser sends `multipart/form-data` to
   `/api/submit` with `name`, `section`, `url`, `submitterEmail`, the
   `logo` file (≤500KB, `image/png|jpeg|svg+xml|webp`), plus optional
   explorer-apps extras (`description`, `longDescription`,
   `categories[]`, `author`, `site`, `github`, `submitterName`).
2. **`/api/submit`** Zod-validates, slugifies the name, and runs a
   logo-less `explorerAppSchema` pre-flight (so a row that could never
   become a valid entry is rejected now, not at approval). It then
   creates an Airtable row with `Status = Pending` and attaches the raw
   logo; if the attachment upload fails the row is rolled back. A
   lightweight Slack notice linking the record is posted. **No S3 write,
   no audit.**
3. **Maintainer** runs `/explorer-admin` in any Slack channel.
   `/api/slack/commands` verifies the HMAC, opens a modal with a
   mode-selector at the top:
   - **Pending submissions** — a live Airtable `Status = Pending` query.
     Each row appears under four checkbox groups: **Approve → Explorer
     dApps**, **Approve → Ecosystem map**, **Approve → Both**, and
     **Reject**. A row checked in more than one group is refused.
   - **Existing entries** — edit/delete a registry entry by `id`
     (read from S3 via `getJson`).
   - **Seed migration** — paste an `ExplorerApp[]` seed; a diff preview
     gates a replace/merge apply.
4. **Maintainer submits the modal**. `/api/slack/actions` dispatches on
   the mode in `private_metadata`:
   - **Pending mode**: re-reads the live Airtable rows. For each approved
     row — download the logo attachment → normalise to a 250×250 PNG
     with 30px rounded corners → `putLogo` to S3 as
     `explorer-dapp-<id>.png` → `withEtagRetry` append to
     `explorer-apps.json` with the chosen `surfaces` (dropping
     `ecosystemSection` for dApps-only) → set Airtable `Status = Approved`
     (storing the registry id + S3 logo URL). Rejected rows get
     `Status = Rejected` (no S3). After the batch, the updated
     `explorer-apps.json` and each added logo are posted to the channel,
     threaded under a summary that breaks the approved count down by
     surface.
   - **Existing mode**: edit revalidates the row; delete removes it. One
     read-modify-write via `withEtagRetry`.
   - **Seed apply**: validate the seed, `withEtagRetry` replace/merge
     into `explorer-apps.json`.
5. The frontend serves the new shape on next fetch (no redeploy).

---

## Seed migration

The legacy hand-curated ecosystem JSON (~166 entries) was removed at
Phase 7f. The one-shot merge into the S3 registry is performed offline
by the maintainer with `npm run generate-seed`, then applied via Slack:

```bash
# Default: fetches the live registry over HTTPS and reads the local
# legacy ecosystem.json (which you must check out from a pre-7f tag).
npm run generate-seed

# Or pin both inputs to local snapshots for reproducibility:
npm run generate-seed -- \
  --explorer-apps ./snapshots/explorer-apps.json \
  --ecosystem ./snapshots/ecosystem.json \
  --out ./progress/seed-merged-explorer-apps.json \
  --report ./progress/seed-migration-report.md
```

The script is read-only; it never writes to S3. It produces:

- `progress/seed-merged-explorer-apps.json` — the proposed canonical
  state.
- `progress/seed-migration-report.md` — counts, mismatches between
  registry and legacy ecosystem entries, and a "Skipped" section for
  rows that lack required fields.

Runbook:

1. Read the report end-to-end. Resolve every "Skipped" row.
2. Spot-check "Mismatches". The registry value wins by default; if it
   is wrong, fix the registry first and re-run.
3. Hand-edit the merged JSON for any remaining gaps (logos on
   synthesised entries, missing categories, etc.).
4. Upload the merged JSON as `s3://$S3_BUCKET/pending-seed.json`.
5. In Slack, run `/explorer-admin` → **Seed migration** → tick "I
   reviewed the seed" → **Apply seed**. The handler validates against
   the schema before overwriting; on success it deletes the seed
   object best-effort.

The implementation lives in `scripts/generate-seed.ts` (CLI shell) and
`scripts/lib/seed-builder.ts` (pure merge logic, fully tested). See
the Phase 7h report for the matching strategy and edge cases.

---

## Customisation

### Adding or editing entries

Use `/explorer-admin` in Slack. There is no other path — committing
to `main` does not change the live data.

### Adding a section

1. Append `{ id, title }` to `src/data/sections.ts`.
2. Add the new id to `SECTION_IDS` in `src/lib/schemas/ecosystem.ts`
   (also referenced by `src/lib/schemas/explorer-app.ts` via the same
   union — keep the two in sync).
3. Add a CSS rule in `src/components/SectionCard.css` if the section
   needs custom styling.

### Surface model

- `surfaces?: ("explorer-apps" | "ecosystem-map")[]` — defaults to
  `["explorer-apps"]` when omitted, so legacy registry entries stay
  out of the ecosystem-map view until they opt in.
- `ecosystemSection?: SectionId` — required whenever `surfaces`
  includes `"ecosystem-map"` (enforced by `superRefine` in
  `src/lib/schemas/explorer-app.ts`).

---

## Deployment (Vercel)

1. Connect this repo to Vercel.
2. Framework preset: **Create React App** (auto-detected). The `api/`
   directory deploys as serverless functions automatically; the
   static React build is served from `build/`.
3. Populate every variable in [Environment variables](#environment-variables)
   under Project Settings → Environment Variables. `REACT_APP_*` must
   exist at the **build** scope; the rest at the **runtime** scope.
4. After the first deploy, update the Slack app's
   - **Slash Commands → /explorer-admin → Request URL** to
     `https://<deploy>.vercel.app/api/slack/commands`,
   - **Interactivity & Shortcuts → Request URL** to
     `https://<deploy>.vercel.app/api/slack/actions`.
5. **Secret rotation**. `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
   `AWS_*`, and `AIRTABLE_API_KEY` are all swappable in place via the
   Vercel UI; redeploy to pick the new values up at function cold
   start. The bucket itself does not need to be touched. After
   rotating Slack credentials, refresh the Bot Token in the Slack app
   manager (it changes on reinstall).

---

## Troubleshooting

- **Slack signature invalid.** Confirm `SLACK_SIGNING_SECRET` matches
  the value under Basic Information; check `bodyParser: false` is
  still set on `api/slack/*.ts`. The signing window is ±5 minutes —
  inspect the function's clock skew on `TIMESTAMP_EXPIRED`.
- **Modal hits a blank or 500.** `/api/slack/commands` and
  `/api/slack/actions` always best-effort post a "Something went
  wrong" notice on error; the exact cause is in Vercel function logs
  (`[slack/actions]`, `[slack/commands]` prefixes).
- **`If-Match` keeps failing (`ETAG_MISMATCH`).** Two writers are
  racing past `withEtagRetry`'s default 3-attempt budget. Re-run the
  modal; if it persists, confirm bucket versioning is **ON**.
- **Logo too large.** Default cap is 500_000 bytes (~500KB). Either
  compress the asset or raise `SUBMISSION_LOGO_MAX_BYTES`.
- **`/api/submit` returns 415.** Logo MIME isn't on the allowlist
  (`image/png`, `image/jpeg`, `image/svg+xml`, `image/webp`).
- **`/api/submit` returns 502 (`UPSTREAM_AIRTABLE`).** Airtable rejected
  the create/attachment — most often the pipeline fields aren't
  provisioned yet (run `npm run airtable:setup`) or the PAT lacks
  `data.records:write`.
- **`/explorer-admin` Pending list is empty / a row won't list.** The
  modal only shows Airtable rows with `Status = Pending` and the required
  fields filled (Name, Website, Description, Section); incomplete drafts
  are skipped.
- **Frontend renders the snapshot banner.** The live S3 fetch failed —
  check CORS (R2), bucket public-read on the JSON object, and that
  `REACT_APP_EXPLORER_APPS_URL` matches the actual key.

---

## Open questions and risks

| Id | Concern | Status |
| --- | --- | --- |
| L7 | XRPL EVM Explorer dApp registry consumer point. Confirm it reads `https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-apps.json` (the same S3 object this repo writes). If it points elsewhere, a parallel migration is required in that repo — out of scope for Phase 7. | **Open**, leader to confirm with the Explorer team. |
| R1 | S3 bucket versioning **must** be ON for the conditional-PUT contract to be safe. Off → silent last-write-wins on concurrent approvals. | Documented in [AWS S3 setup](#aws-s3-setup). Verify in the AWS console before going live. |
| R2 | CORS on the bucket must allow `GET`/`HEAD` from the deploy origin and expose `ETag`. A misconfig surfaces as the snapshot fallback banner on the frontend. | Documented in [AWS S3 setup](#aws-s3-setup). |
| R3 | The `/explorer-admin` Pending mode lists the first 50 Airtable `Status = Pending` rows — Slack modal block-limit. Pagination is a follow-up; until then, drain the queue regularly. | Tracked as a nice-to-have. |
| R5 | The Airtable pipeline fields must be provisioned before submissions can be staged (`npm run airtable:setup`, Creator-level PAT). Until then `/api/submit` returns 502. | Documented in [Airtable setup](#airtable-setup-submission-queue). One-time bootstrap. |

---

## Contributing

For new ecosystem entries, use the submission form. For code changes,
fork, branch (`feat/...`, `fix/...`), and open a PR against `main`.
Every PR must keep the verify gate (`lint`, `typecheck`, `test`,
`build`) green.

---

## License

[MIT](LICENSE)
