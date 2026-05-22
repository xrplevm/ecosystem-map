# XRPL EVM Ecosystem Map

A responsive, dark-themed dashboard that pins the XRPL EVM ecosystem
(Wallets, Bridges, dApps, Oracles, Indexers, DAOs, Explorers, Validators,
Core, Auditors, Providers) onto a single page of interactive cards. New
projects are submitted via a custom form, audited automatically, and
approved in batch from Slack.

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
     submission form, validates with Zod, uploads the logo to Slack,
     posts a "pending" message to the approval channel with structured
     `metadata`, and runs an Anthropic Claude Haiku audit in a thread
     reply.
   - `POST /api/slack/commands` handles the `/explorer-admin` slash
     command, opening a multi-mode modal (Pending / Existing / Seed).
   - `POST /api/slack/actions` handles every interactive payload that
     comes back from that modal — reading from S3, applying mutations
     (approve, edit, delete, seed apply) atomically with conditional
     PUT, and rolling back logos on failure.

Both halves share a typed registry shape (`src/lib/explorer-apps-types.ts`),
a Zod validator (`src/lib/schemas/explorer-app.ts`), and an env loader
(`src/lib/env.ts`).

---

## Architecture (post Phase 7)

```
                         ┌─────────────────────────────┐
   submitter (browser)   │   POST /api/submit          │
   ──────────────────▶   │   • Zod validate            │
                         │   • upload logo → Slack     │
                         │   • postMessage(channel) +  │
                         │     metadata { submission } │
                         │   • thread: Claude audit    │
                         └────────────┬────────────────┘
                                      │
                                      ▼
                       ┌────────────────────────────────┐
                       │  Slack channel = pending queue │
                       │  (metadata-tagged messages)    │
                       └────────────┬───────────────────┘
                                    │ /explorer-admin
                                    ▼
   maintainer ──▶  POST /api/slack/commands  ──▶  open modal
                         │                          (Pending | Existing | Seed)
                         │  modal submit
                         ▼
                   POST /api/slack/actions
                   ├─ pending    → withEtagRetry: read JSON → append → PUT (If-Match) → upload logos to S3
                   ├─ existing   → withEtagRetry: read JSON → edit/delete → PUT (If-Match)
                   └─ seed apply → withEtagRetry: read seed.json → overwrite explorer-apps.json
                         │
                         ▼
              ┌──────────────────────────────┐
              │  s3://peersyst-development/  │
              │    explorer-apps.json        │  ←── single source of truth
              │    explorer-dapp-<id>.<ext>  │
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
- **Atomic writes**: every mutation goes through `withEtagRetry` in
  `src/lib/s3-client.ts`. Concurrent approvals can't overwrite each
  other; on `412 Precondition Failed` the helper re-reads, re-applies
  the same diff, and retries (default 3 attempts). **Bucket versioning
  must be ON** for this to be safe.
- **Slack as pending queue**: pending submissions live as
  `chat.postMessage` calls carrying
  `metadata.event_type === "explorer_submission_pending"` and a full
  `event_payload`. Reading the queue means listing channel history and
  filtering on metadata + reaction state — no database.
- **Two surfaces, one row**: each row carries
  `surfaces?: ("explorer-apps" | "ecosystem-map")[]` (default
  `["explorer-apps"]`) and `ecosystemSection?: SectionId` (required
  when `surfaces` includes `"ecosystem-map"`). The frontend filters on
  `surfaces` so the registry can stay lean for the dApp explorer
  consumer.

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
      slack.ts                      # HMAC verify, postMessage, file upload
      slack-batch.ts                # /explorer-admin modal builder + handlers
      audit.ts                      # Anthropic Claude Haiku caller
      s3-client.ts                  # getJson / putJsonIfMatch / withEtagRetry / putLogo / deleteLogo
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
| `SLACK_APPROVAL_CHANNEL` | Slack | Channel ID (not name) where `/api/submit` posts pending messages and where `/explorer-admin` looks for the queue. Get it via right-click channel → "Copy link" — trailing path segment, starts with `C`. |
| `AWS_REGION` | AWS / S3 | Region of the bucket. Default `eu-west-1`. |
| `S3_BUCKET` | AWS / S3 | Bucket holding `explorer-apps.json` and dApp logos. Default `peersyst-development`. |
| `S3_JSON_KEY` | AWS / S3 | Object key of the canonical registry. Default `explorer-apps.json`. |
| `AWS_ACCESS_KEY_ID` | AWS / S3 | IAM access key. Required for the Slack approval handler (write paths). Read-only deploys can omit it. |
| `AWS_SECRET_ACCESS_KEY` | AWS / S3 | Matching IAM secret. Required only when `AWS_ACCESS_KEY_ID` is set. |
| `ANTHROPIC_API_KEY` | Anthropic | API key for the Claude Haiku audit run from `/api/submit`. Optional — when absent the audit returns a `warn` verdict so the human approver decides. |
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
   - `chat:write` — post pending / approval messages.
   - `chat:write.public` — post in channels the bot is not a member of (only needed if approvals land in such a channel; otherwise optional).
   - `views:open`, `views:update`, `views:publish` — open and update the `/explorer-admin` modal.
   - `reactions:write` — mark approved/rejected pending messages with ✅ / ❌.
   - `metadata.message:read` — read the `event_payload` attached to pending messages so the modal can list them.
   - `channels:history` (and/or `groups:history` for private channels) — list pending messages from the approval channel.
   - `files:write` — upload submitted logos to Slack as attachments.
   - `files:read` — fetch logo bytes back when approving (so they can be re-uploaded to S3).
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

## Anthropic (Claude Haiku audit)

`/api/submit` runs an integrity audit on every new submission and on
edits that touch `url`, `site`, or `github`. The caller lives in
`src/lib/audit.ts` and uses
`@anthropic-ai/sdk` with model `claude-3-5-haiku-latest` and an 8s
`AbortController` timeout. The response is parsed with a Zod schema
into `{ verdict, reasons, confidence, raw? }` and rendered in the
Slack thread of the pending message.

When `ANTHROPIC_API_KEY` is unset, the network call times out, or the
response fails to parse, the audit falls back to a `warn` verdict
(confidence `0`) and posts a "_audit unavailable — proceed with manual
review_" line in the thread. The intake never fails because of the
audit (R5 below): the human approver is the source of truth. There
is no client-side rate limiter — if the channel starts seeing audit
spam, mitigate at the Anthropic dashboard.

---

## Submission lifecycle

A single-flow walkthrough for maintainers:

1. **Submitter** opens the "Submit your project" modal in the footer
   and posts the form. The browser sends `multipart/form-data` to
   `/api/submit` with `name`, `section`, `url`, `submitterEmail`, the
   `logo` file (≤500KB, `image/png|jpeg|svg+xml|webp`), plus optional
   explorer-apps extras (`description`, `longDescription`,
   `categories[]`, `author`, `site`, `github`, `submitterName`).
2. **`/api/submit`** Zod-validates, slugifies the name (rejects on
   duplicate id), uploads the logo to Slack, and posts a pending
   message to `SLACK_APPROVAL_CHANNEL`. The message carries
   `metadata.event_type === "explorer_submission_pending"` and the
   full submission as `event_payload`. A thread reply renders the
   Claude audit verdict (or the fallback line).
3. **Maintainer** runs `/explorer-admin` in any Slack channel.
   `/api/slack/commands` verifies the HMAC, opens a modal with a
   mode-selector at the top:
   - **Pending submissions** — `conversations.history` filtered by
     metadata and absence of ✅ / ❌ reactions; up to 50 items per
     view. Each row offers Approve / Reject / Skip.
   - **Existing entries** — read from S3 via `getJson`; each row
     offers Keep / Edit / Delete. Edit pushes a sub-modal pre-filled
     with the entry. Delete requires "I understand this is permanent".
   - **Seed migration** — only visible when `s3://$S3_BUCKET/pending-seed.json`
     exists. One-shot "Apply seed" overwrites the canonical registry.
4. **Maintainer submits the modal**. `/api/slack/actions` dispatches
   on the mode in `private_metadata`:
   - **Pending mode**: per-item — Reject reacts ❌ on the parent
     message and is done; Approve `withEtagRetry`s a read-modify-write
     of the JSON, uploads the logo to S3 under `explorer-dapp-<id>.<ext>`,
     and reacts ✅ on success. A duplicate id inside the batch
     fails the whole batch fast (atomicity > convenience); orphaned
     S3 logos are best-effort cleaned up.
   - **Existing mode**: per-item — Edit revalidates the row, runs
     `auditEdit` if `url`/`site`/`github` changed, and stages it;
     Delete stages the deletion plus the logo-cleanup. The whole
     batch is a single read-modify-write; logos are deleted post-PUT.
   - **Seed apply**: read `pending-seed.json`, validate against the
     schema, `putJsonIfMatch` over `explorer-apps.json`, best-effort
     `deleteObject(pending-seed.json)`.
5. The frontend serves the new shape on next fetch (no redeploy).

`/api/slack/actions` returns `200` to Slack within 3 seconds; the
heavy work runs in `waitUntil`-style background after the ack.

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
   `AWS_*`, and `ANTHROPIC_API_KEY` are all swappable in place via the
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
- **`/api/submit` returns 409.** Slug derived from `name` collides
  with an existing entry. The response body includes a `suggestion`
  slug.
- **Audit always reads "audit unavailable".** Either
  `ANTHROPIC_API_KEY` is missing/invalid, the call timed out (8s), or
  the response failed schema parsing. Fall back to manual review.
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
| R3 | The `/explorer-admin` Pending mode is capped at the first 50 messages — Slack modal block-limit. The "Show next" pagination is a follow-up; until then, drain the queue regularly. | Tracked as Phase 8 nice-to-have. |
| R5 | No client-side rate limiter on the Anthropic caller. A flood of submissions translates to a flood of audit calls (and cost). v1 mitigation: Zod validation gates obvious junk before the audit fires. | Monitor on the Anthropic dashboard; add a token-bucket if needed. |

---

## Contributing

For new ecosystem entries, use the submission form. For code changes,
fork, branch (`feat/...`, `fix/...`), and open a PR against `main`.
Every PR must keep the verify gate (`lint`, `typecheck`, `test`,
`build`) green.

---

## License

[MIT](LICENSE)
