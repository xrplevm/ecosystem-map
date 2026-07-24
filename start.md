# start.md — XRPL EVM Ecosystem Map

Operational runbook for getting this repo running locally and shipped to
production. Optimised for the first engineer who lands here on day one.
For architecture, invariants, contract details, deeper Slack/AWS notes,
and the full CORS JSON, read `README.md`.

---

## 1. TL;DR

- Public site is a Create React App; the submission/approval pipeline
  lives in `api/` as three Vercel serverless functions.
- Canonical data is one S3 object (`explorer-apps.json`); submissions
  queue in a Slack channel; a `/explorer-admin` modal approves them.
- Before pressing play you need: Node 18+, npm, a Slack app you can
  install in your workspace, an S3 bucket with versioning ON (or
  read-only access to the default one), and a Vercel project for
  deploy. Anthropic key is optional.
- Locally, `npm start` only renders the site; the form requires
  `vercel dev` plus filled-in envs to actually post a submission.

---

## 2. Prerequisites

- **Node** ≥ 18.18.0 (matches Peersyst standard). `npm` is fine — this
  repo predates the `pnpm`-everywhere rule.
- **Vercel CLI** (`npm i -g vercel`) if you want the serverless
  functions to run locally against `/api/*`.
- **Slack workspace** where you can create and install a custom app
  (workspace admin or an admin willing to approve the install).
- **AWS account** with permission to create an S3 bucket and an IAM
  user — or read-only access to the default `peersyst-development`
  bucket if you're forking inside Peersyst.
- **Vercel account** (free tier is enough) connected to the GitHub repo
  you'll deploy from.
- **Anthropic API key** (optional) for the automated submission audit.
- The exact React/TypeScript versions used by the build live in
  `package.json` — no need to install them by hand, `npm install`
  handles it.

---

## 3. Quickstart local (read-only)

1. `npm install`
2. `cp .env.example .env.local`
3. `npm start` — opens the site at `http://localhost:3000`.

In this mode the page fetches `explorer-apps.json` from the public S3
URL (or falls back to `public/explorer-apps.snapshot.json` if the
network/parse fails), so cards render without any envs filled in.

The submission form will appear, but `POST /api/submit` will not be
reachable — `react-scripts` does not serve the `api/` directory. To
exercise the full pipeline locally, stop `npm start` and run
`vercel dev` instead, after filling the envs in section 4. Without
Slack and AWS envs set, `vercel dev` will start the functions but
`/api/submit` will return 500 because `loadEnv()` in
`src/lib/env.ts` is fail-fast.

To verify the gate is green at any point:

```
npm run lint && npm run typecheck && CI=true npm test && npm run build
```

---

## 4. Missing envs — checklist

The schema of truth is `src/lib/env.ts`. The shape below mirrors it.

Frontend var (`REACT_APP_*`) is build-time and inlined into the bundle
by Create React App — changing it requires a redeploy. Everything else
is read at serverless invocation time.

| Variable | Required? | Where to obtain | Where to set | Surface |
|---|---|---|---|---|
| `SLACK_BOT_TOKEN` | Required | Slack app → OAuth & Permissions → Bot User OAuth Token (starts with `xoxb-`) | `.env.local` (for `vercel dev`) and Vercel → Project Settings → Environment Variables | Backend (serverless) |
| `SLACK_SIGNING_SECRET` | Required (≥32 chars) | Slack app → Basic Information → App Credentials → Signing Secret | `.env.local` + Vercel env | Backend |
| `SLACK_APPROVAL_CHANNEL` | Required (channel ID, starts with `C` or `G`) | Slack → right-click the channel → Copy link → ID is the trailing path segment | `.env.local` + Vercel env | Backend |
| `AWS_REGION` | Has default (`eu-west-1`) | AWS console (bucket region) | `.env.local` + Vercel env | Backend |
| `S3_BUCKET` | Has default (`peersyst-development`) | AWS console (bucket name) | `.env.local` + Vercel env | Backend |
| `S3_JSON_KEY` | Has default (`explorer-apps.json`) | The object key under the bucket | `.env.local` + Vercel env | Backend |
| `SUBMISSION_LOGO_MAX_BYTES` | Has default (`500000`) | Your call — must match the client-side Zod limit if you change it | `.env.local` + Vercel env | Backend |
| `AWS_ACCESS_KEY_ID` | Optional in env, required for any write path (approve / edit / delete / seed apply) | AWS IAM → user → access keys | `.env.local` + Vercel env | Backend |
| `AWS_SECRET_ACCESS_KEY` | Optional in env, required for any write path | AWS IAM (created with the access key) | `.env.local` + Vercel env | Backend |
| `ANTHROPIC_API_KEY` | Optional (audit returns `warn` when missing) | `https://console.anthropic.com/` → API Keys | `.env.local` + Vercel env | Backend |
| `REACT_APP_EXPLORER_APPS_URL` | Optional (defaults to the public S3 URL of `peersyst-development`) | The public HTTPS URL of your `explorer-apps.json` object | `.env.local` + Vercel env (build-time) | Frontend (build-time) |

Notes:

- "Required" in the table maps to a `.min(1)` / non-`.optional()` field
  in `src/lib/env.ts`. The handler will throw `EnvValidationError` on
  cold start if any of these is missing.
- The two AWS credentials are `.optional()` in env validation so that
  read-only deploys (e.g. a public preview) start successfully. The
  S3 client itself asserts their presence the moment any write path is
  invoked.
- On Vercel, set envs per environment (Production / Preview /
  Development) — preview deploys usually need different Slack channel
  IDs and a non-production bucket.

---

## 5. Slack app setup

1. Go to `https://api.slack.com/apps` → **Create New App** → **From
   scratch** → pick the workspace.
2. **OAuth & Permissions** → add these bot scopes (mirror of
   `.env.example`): `commands`, `chat:write`, `chat:write.public`,
   `views:open`, `views:update`, `reactions:write`,
   `metadata.message:read`, `channels:history`, `files:write`,
   `files:read`.
3. **Install App** → install to workspace → copy the **Bot User OAuth
   Token** (`xoxb-...`) into `SLACK_BOT_TOKEN`.
4. **Basic Information** → copy **Signing Secret** into
   `SLACK_SIGNING_SECRET`.
5. **Slash Commands** → **Create New Command**:
   - Command: `/explorer-admin`
   - Request URL: `https://<your-domain>/api/slack/commands`
   - Short description and usage hint: free text.
   - Invite the bot to the approval channel (see step 7) before
     running the command, otherwise the slash will time out silently.
6. **Interactivity & Shortcuts** → toggle ON → Request URL:
   `https://<your-domain>/api/slack/actions`.
7. In the target Slack channel, run `/invite @<your-bot>` so it can
   post and read history. Copy the channel ID (right-click → Copy
   link → trailing path segment) into `SLACK_APPROVAL_CHANNEL`.

For local development with `vercel dev`, expose your tunnel (e.g.
`ngrok http 3000`) and point the Slack request URLs at the tunnel.
README has the deeper walkthrough.

---

## 6. AWS S3 setup

1. Create a bucket (or reuse `peersyst-development`). Record its name
   and region.
2. **Enable bucket versioning**. This is non-negotiable: the writer in
   `src/lib/s3-client.ts` does an atomic read-modify-write using
   conditional PUT with `If-Match` against the ETag. Without versioning
   the conditional PUT contract is unsafe under concurrency.
3. **CORS configuration**: allow `GET` and `HEAD` from the Vercel
   domain and from `http://localhost:3000`, expose the `ETag` header so
   the consumer fetch can use it. Full JSON example is in README.
4. **IAM user** with programmatic access keys, attached to a policy
   granting the minimum required actions, scoped to the bucket ARN:
   - `s3:GetObject`
   - `s3:GetObjectVersion`
   - `s3:PutObject`
   - `s3:DeleteObject`
   Resource: `arn:aws:s3:::<bucket-name>/*` (and the bucket ARN itself
   if you also need `s3:ListBucket`).
5. Drop the access keys into `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`. Public read of the JSON is what the
   frontend uses — confirm the object (or a CloudFront in front of it)
   is publicly readable.

---

## 7. Anthropic (optional)

1. `https://console.anthropic.com/` → API Keys → create.
2. Paste into `ANTHROPIC_API_KEY` (local `.env.local` and Vercel env).
3. Without the key, `/api/submit` still works — the audit returns a
   `warn` verdict and the human approver decides in the Slack modal.

---

## 8. Deploy to Vercel

1. Push your branch to GitHub.
2. In Vercel, **Add New… → Project**, import the repo.
3. Build command: leave the default (`react-scripts build`).
4. **Environment Variables**: paste every env from section 4 that
   applies. Use the per-environment scoping (Production / Preview /
   Development) when the values differ. `REACT_APP_EXPLORER_APPS_URL`
   is build-time, so it must be set before the build runs.
5. Deploy.
6. After the first deploy, copy the production domain and update the
   Slack app:
   - Slash command request URL → `https://<domain>/api/slack/commands`
   - Interactivity request URL → `https://<domain>/api/slack/actions`
   If you changed bot scopes between the first install and now,
   reinstall the app to the workspace.

---

## 9. Smoke test post-deploy

1. Open the production URL — cards render (registry fetched from S3).
2. Submit the form with a throwaway payload (a placeholder logo and a
   nonsense URL is fine for the dry run). The approval channel
   receives a **pending** message, and a thread reply carries the
   audit verdict.
3. In Slack, run `/explorer-admin` — the modal opens with Pending /
   Existing / Seed tabs.
4. Approve the test submission from the Pending tab. The modal closes
   without error.
5. Verify the registry was actually updated:
   `aws s3 cp s3://$S3_BUCKET/$S3_JSON_KEY -` — your new entry is in
   the JSON. Hard-refresh the site; the card appears.

---

## 10. Troubleshooting cheatsheet

- **`/api/submit` returns 500 with `EnvValidationError`** — one of
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVAL_CHANNEL`
  is missing or malformed. Bot token must start with `xoxb-`; channel
  ID must start with `C` or `G` (not a `#name`).
- **`/explorer-admin` modal never opens, command times out** — the bot
  is not a member of `SLACK_APPROVAL_CHANNEL`, or the interactivity
  request URL points at the wrong domain. `/invite @<bot>` in the
  channel, then re-test.
- **Site shows the snapshot fallback banner / cards are stale** —
  S3 CORS does not expose `ETag`, or `REACT_APP_EXPLORER_APPS_URL`
  points at a non-public object. Check the browser network tab.
- **Slack approval errors with `412 Precondition Failed — retries
  exhausted`** — bucket versioning is OFF, or two approvers are racing
  on the same row at a rate higher than the retry budget. Turn
  versioning ON; if both did, serialise approvals.
- **Audit thread always returns `warn`** — `ANTHROPIC_API_KEY` is
  missing or invalid. Set it and redeploy. Without it, the pipeline is
  intentionally degraded, not broken.
- **`POST /api/submit` 413 / "logo too large"** — submission exceeded
  `SUBMISSION_LOGO_MAX_BYTES` (default 500000). Lower the file or
  raise the env (and the client-side Zod limit to match).
- **AWS write paths fail with `AccessDenied`** — IAM policy is missing
  one of `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, or
  `s3:DeleteObject`, or the resource ARN doesn't match the bucket.
- **Slack signature invalid / `TIMESTAMP_EXPIRED`** — the signing
  window is ±5 minutes. Either the local dev clock has drifted (check
  `ntpdate` / system time, especially behind a slow `ngrok` tunnel) or
  `bodyParser: false` was removed from one of `api/slack/*.ts` and the
  raw-body HMAC no longer matches. Restore `bodyParser: false` and
  resync the clock.

---

For anything beyond this page — architecture diagrams, full CORS JSON,
schema details, contributing flow — read `README.md`.
