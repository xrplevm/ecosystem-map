# Airtable-staged submissions with Slack approval — Design Spec

- **Date:** 2026-06-16
- **Branch:** `feat/submission-platform`
- **Status:** Approved design, pending spec review → implementation plan

## Goal & guiding principle

Move dApp submissions into the existing Airtable base so that **nothing is
written to S3 until a dApp is approved**. The custom React submission form
stays — it is the source of truth for which fields a submission must carry —
and Airtable is expanded to hold all of those fields. The logo lives as an
Airtable attachment until approval; only at approval is it normalised to a
250×250 PNG with 30px rounded corners and uploaded to S3 alongside a new
`explorer-apps.json` entry.

The Slack `/explorer-admin` approval surface is kept, but its pending queue is
re-sourced from Airtable instead of from Slack message metadata.

## Current state (what exists today on the branch)

- `api/submit.ts`: parses the multipart form, **uploads the logo to S3
  immediately** (`putLogo` → `explorer-dapp-<id>.<ext>`), runs a Claude audit,
  and posts a Slack message tagged `metadata.event_type=explorer_submission_pending`
  whose `event_payload` is the full `ExplorerApp` candidate.
- `src/lib/slack-batch.ts` `readPendingSubmissions`: reads `conversations.history`
  (`include_all_metadata=true`), keeping pending-tagged messages without a ✅/❌
  reaction. The Slack message **is** the pending queue.
- `api/slack/actions.ts`: `/explorer-admin` modal. Pending mode batch-approves
  selected submissions into `explorer-apps.json` via `withEtagRetry`, and marks
  messages with the ✅ reaction. Existing/Seed modes mutate the registry directly.
- Claude audit runs in two places: `api/submit.ts` (at submit) and
  `api/slack/actions.ts` (re-audit when an admin edits url/site/github).
- `normalizeLogo` (`src/lib/logo-image.ts`) exists and is currently called at
  submit time.

## Target architecture — data flow

1. React form → `POST /api/submit` (multipart, incl. logo).
2. `/api/submit` validates the fields with the existing `SubmissionSchema`, then:
   - creates an Airtable record with `Status = Pending` and all submission fields;
   - uploads the logo bytes to that record's `Icon` attachment via Airtable's
     content-upload API (no intermediate hosting, no S3);
   - posts a lightweight Slack notice ("New submission: `<name>` — review via
     `/explorer-admin`") linking the Airtable record.
   - **No S3 write. No Claude audit.**
3. Reviewer runs `/explorer-admin` → Pending. The modal lists Airtable rows where
   `Status = Pending` (live query).
4. The reviewer checks rows under **Approve** and/or **Reject**, then submits:
   - **Approve** per row: fetch the logo from the Airtable attachment →
     `normalizeLogo` (250×250 / 30px) → `putLogo` → S3 (`explorer-dapp-<id>.png`)
     → build & validate the `ExplorerApp` (`surfaces: ["ecosystem-map"]`,
     `ecosystemSection` = row's Section) → `withEtagRetry` append to
     `explorer-apps.json` → set the row `Status = Approved` (+ store the S3 logo
     URL and registry id). **This is the only S3 write.**
   - **Reject** per row: set `Status = Rejected`. No S3.
   - Results roll up into the existing batch summary message. **After a
     successful batch, the updated `explorer-apps.json` (as a file) and each
     newly added logo (the normalised 250×250 PNG) are uploaded to the approval
     channel, threaded under the summary** — a Slack-side record of exactly what
     was added. Nothing is uploaded when zero rows were approved.

## Airtable schema

Base `appDFL9N9MDWj0Ywd`, table `tblSXGty3mcKj7F62`. The new fields are created
**via the Airtable metadata API** by a provisioning script (see Provisioning).

Reused existing fields:

| Airtable field | Type | Submission field |
|---|---|---|
| Name | single line text | `name` |
| Website | url | `url` |
| Description | long text | `description` (short tagline → `shortDescription`) |
| Icon | attachment (`fldind6amgF8zBmR6`) | `logo` (uploaded bytes) |
| Contact email | email | `submitterEmail` |
| Contract address | text | *(unused by the map; left as-is)* |

New fields to create:

| Airtable field | Type | Submission field / purpose |
|---|---|---|
| Section | single select (11 section ids) | `section` → `ecosystemSection` |
| Long description | long text | `longDescription` → `description` |
| Categories | multiple select (from `ExplorerCategory` enum) | `categories` |
| Author | single line text | `author` |
| Site | url | `site` |
| GitHub | url | `github` |
| Submitter name | single line text | `submitterName` |
| Status | single select: `Pending` / `Approved` / `Rejected` | pipeline state |
| Registry id | single line text | set on approval (the entry `id`) |
| Logo URL | url | set on approval (the S3 logo URL) |

Section choices: `wallets, bridges, dapps, oracles, indexers, daos, explorers,
validators, core, auditors, providers`. Category choices: the values of
`ExplorerCategorySchema` (`src/lib/schemas/explorer-apps.ts`).

## Components

**New — `src/lib/airtable.ts`:** a typed `fetch` client (single I/O seam for
tests), centralising field-name constants and the Submission↔Airtable mapping:
- `createSubmissionRecord(fields)` → record id
- `uploadIcon(recordId, bytes, contentType, filename)` (content-upload endpoint)
- `listPendingSubmissions()` → `[{ recordId, candidate, logoUrl }]`
- `setStatus(recordId, status, extra?)` (approve/reject + registry id / logo URL)

**Changed — `api/submit.ts`:** replace `putLogo`+Slack-metadata+audit with
Airtable create + icon upload + lightweight Slack notice. `normalizeLogo` is no
longer called here.

**Changed — `src/lib/slack-batch.ts`:** `readPendingSubmissions` queries Airtable
(`Status = Pending`) instead of `conversations.history`. `PendingSubmission`
carries the Airtable `recordId` (modal option value = record id) instead of a
Slack `ts`. The ✅/❌ reaction markers are no longer the source of truth — status
lives in Airtable — though a notice/summary message is still posted.

**Changed — `src/lib/slack-batch.ts` view builder:** the Pending modal gains a
second checkbox group. Two groups, both built from the pending list:
**Approve** and **Reject**. (A row checked in both Approve and Reject is refused
with an inline modal error.)

**Changed — `api/slack/actions.ts` `handleApprove` → `handlePendingDecision`:**
process the approve set (fetch logo → `normalizeLogo` → `putLogo` → registry
write → `setStatus(Approved)`) and the reject set (`setStatus(Rejected)`). On a
successful batch, call a new `postApprovalArtifacts` helper that uploads the
updated `explorer-apps.json` and each added logo PNG to the channel (Slack
`files.uploadV2`, threaded under the summary). Remove the edit-flow re-audit.

**New — `src/lib/slack-batch.ts` `postApprovalArtifacts`:** upload the final
registry JSON (re-read after the `withEtagRetry` write) plus the in-memory added
logo bytes as Slack file attachments. Requires the bot's `files:write` scope
(already listed). Skipped when the approved set is empty.

**Removed (Claude audit):** `src/lib/audit.ts`, `src/lib/__tests__/audit.test.ts`,
the audit calls in `api/submit.ts` and `api/slack/actions.ts`, the
`ANTHROPIC_API_KEY` entry in `src/lib/env.ts` + `.env.example`, the
`@anthropic-ai/sdk` dependency, and Anthropic stubbing in
`src/lib/__tests__/slack-actions.test.ts`.

**Unchanged:** the React form, the Existing/Seed modal modes, the registry
`withEtagRetry` write path, the explorer-app Zod schema, `normalizeLogo` itself.

## Config / env

Add to `src/lib/env.ts` (fail-fast Zod) and `.env.example`:
- `AIRTABLE_API_KEY` — Airtable Personal Access Token. Scopes:
  `data.records:read`, `data.records:write`, plus `schema.bases:read` and
  `schema.bases:write` (the two schema scopes only needed for the one-time
  field-provisioning script — write resolves the table via the schema surface,
  which also requires read).
- `AIRTABLE_BASE_ID` — `appDFL9N9MDWj0Ywd`.
- `AIRTABLE_TABLE_ID` — `tblSXGty3mcKj7F62`.

Remove `ANTHROPIC_API_KEY`. The S3 env vars are unchanged (still used at
approval). Airtable field names are constants in `airtable.ts`.

## Logo lifecycle

Submit: bytes → Airtable `Icon` attachment (raw, untouched). Approve: download
the attachment → `normalizeLogo` (250×250 / 30px PNG) → `putLogo` → S3. Airtable
attachment URLs are short-lived, so the approve path re-reads the record to get a
fresh URL immediately before download.

## Error handling

- **Submit:** if the record is created but the icon upload fails, best-effort
  delete the record and return 5xx — no orphan Pending row without a logo, and S3
  stays untouched throughout.
- **Approve:** per-row `try/catch` into the existing batch summary; a failed row
  stays `Pending` (idempotent retry). A row whose `id` already exists in the
  registry is skipped with a reason.
- **Reject:** `setStatus(Rejected)` failures roll into the summary's errors.

## Testing

- `airtable.ts`: unit tests stubbing `fetch` — create, upload, list (filter +
  mapping), setStatus.
- `readPendingSubmissions` (Airtable variant): stub `fetch`; assert `Status =
  Pending` filtering and mapping to `PendingSubmission`.
- `handlePendingDecision`: stub `airtable` + `s3-client` + `normalizeLogo`;
  assert S3 is written only for approved rows, rows are marked Approved/Rejected,
  and overlap is rejected.
- `postApprovalArtifacts`: stub `fetch`; assert the updated `explorer-apps.json`
  and one file per added logo are uploaded, and that nothing uploads when zero
  rows were approved.
- Delete `audit.test.ts`; update `slack-actions.test.ts` to drop audit.
- `normalizeLogo` is already verified via a Node/`tsx` run (sharp does not load
  under `react-scripts` jest).

## Provisioning

`scripts/airtable-setup.ts` (npm script `airtable:setup`, run with `tsx`):
idempotent — lists current fields via the metadata API and `POST`s the missing
ones (`/v0/meta/bases/{baseId}/tables/{tableId}/fields`). Run once with a PAT
that has `schema.bases:read` + `schema.bases:write`. **Prerequisite for
implementation:** the user provides the PAT so this script (and the Airtable
integration tests) can run.

## Out of scope / future

- Migrating the historical Airtable rows already in the table.
- Editing a pending submission from Slack (reviewers edit in Airtable).
- Re-using "Contract address" anywhere in the map.

## Risks

- Airtable rate limits (5 req/s/base) — submit does ≤2 calls; approval batches
  are small.
- Attachment-upload endpoint size cap is well above the 500 KB form limit.
- Removing the audit drops the only automated integrity signal; approval is now
  purely human.
