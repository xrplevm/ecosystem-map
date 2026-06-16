# Setup guide

Short quickstart for the XRPL EVM Ecosystem Map. For the full runbook see
[`start.md`](./start.md); for architecture and contracts see [`README.md`](./README.md).

## Prerequisites

- **Node ≥ 18.18.0** and **npm**.
- Only for the submission/approval pipeline (not needed to view the map):
  the **Vercel CLI** (`npm i -g vercel`), a **Slack app**, and an **S3 bucket**
  (versioning ON). An **Anthropic API key** is optional.

## 1. Run the map locally (read-only)

```bash
npm install
cp .env.example .env.local   # optional for read-only; leave values blank
npm start                    # http://localhost:3000
```

This renders the ecosystem map and the explorer-apps registry. No env vars or
cloud access are required.

## 2. Where the data comes from

Both surfaces are driven by the explorer-apps registry, resolved by
`src/lib/explorer-apps-source.ts`:

- **`REACT_APP_EXPLORER_APPS_URL` unset** → the bundled local snapshot
  `public/explorer-apps.snapshot.json` is served directly. This is the source
  of truth for local dev and any deploy that doesn't set the var.
- **`REACT_APP_EXPLORER_APPS_URL` set** (e.g. the live S3 `explorer-apps.json`)
  → that URL is fetched, falling back to the local snapshot on network/parse
  failure (the UI shows a "showing bundled snapshot" notice).

> This var is build-time (CRA inlines it), so changing it requires a rebuild.

## 3. Edit ecosystem-map entries

Edit `public/explorer-apps.snapshot.json`. Each entry is an `ExplorerApp`
(`src/lib/explorer-apps-types.ts`). To make an entry appear on the **ecosystem
map**, it must have:

```jsonc
{
  "id": "example-validators",          // unique, lowercase-with-dashes
  "title": "Example",
  "url": "https://example.com",
  "logo": "/assets/sections/validators/example.png", // local path OR an https S3 URL
  "surfaces": ["ecosystem-map"],
  "ecosystemSection": "validators"     // wallets|bridges|dapps|oracles|indexers|
                                        // daos|explorers|validators|core|auditors|providers
}
```

- Local logos live under `public/assets/sections/<section>/`; remote logos use
  the S3 URL. Entries without `surfaces` default to `["explorer-apps"]` (registry
  view only, not the map).
- `id`s must be unique across the whole file.

## 4. Submission pipeline (optional)

The submit form + Slack approval flow run as Vercel functions in `api/`, which
`npm start` does **not** serve. To exercise them:

```bash
cp .env.example .env.local   # fill in Slack + AWS (+ optional Anthropic)
vercel dev                   # serves the site and /api/*
```

Required env vars are documented in `.env.example` and validated fail-fast by
`src/lib/env.ts`. The canonical S3 registry is updated via
`npm run generate-seed` → review → Slack `/explorer-admin → Apply seed`
(see the "Seed migration" section of `README.md`). The repo tooling is
read-only against S3.

**Submitted logos** are normalised before storage: `api/submit.ts` runs every
upload through `normalizeLogo` (`src/lib/logo-image.ts`, using `sharp`) to a
**250×250 PNG with 30px rounded corners**, then saves it to S3 as
`explorer-dapp-<id>.png` (same bucket as the registry). This keeps the
ecosystem-map grid visually uniform regardless of the uploaded size/format
(PNG/JPEG/SVG/WebP).

## 5. Verify

```bash
npm run lint && npm run typecheck && CI=true npm test && npm run build
```
