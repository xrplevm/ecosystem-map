import type { VercelRequest, VercelResponse } from "@vercel/node";

import { auditSubmission, formatAuditForSlack } from "../../src/lib/audit";
import { loadEnv } from "../../src/lib/env";
import { EnvValidationError, SlackVerifyError } from "../../src/lib/errors";
import {
    assertUniqueIds as assertUniqueIdsTyped,
    DuplicateIdError,
    explorerAppSchema,
    explorerAppsArraySchema,
    safeParseExplorerApp,
} from "../../src/lib/schemas/explorer-app";
import type { ExplorerApp } from "../../src/lib/explorer-apps-types";
import {
    EtagRetryExhaustedError,
    getJson,
    withEtagRetry,
} from "../../src/lib/s3-client";
import { postMessage, verifySlackSignature } from "../../src/lib/slack";
import {
    buildExistingModalView,
    buildPendingModalView,
    buildSeedDiffView,
    buildSeedModalView,
    CALLBACK_ID,
    computeSeedDiff,
    markSubmissionApproved,
    postBatchSummary,
    readPendingSubmissions,
    type AdminMode,
    type BatchSummary,
} from "../../src/lib/slack-batch";

/**
 * POST /api/slack/actions — receives Slack interactive payloads:
 *   - `block_actions`: in-modal interactions (mode selection → views.update,
 *     legacy approval-button no-op kept for backwards compat with
 *     in-flight pre-7e messages).
 *   - `view_submission`: the modal Apply/Approve button. Dispatches by
 *     `private_metadata.mode` to the per-mode handler.
 *
 * Common envelope:
 *   1. Read raw body (body parser disabled — we need the bytes Slack
 *      signed).
 *   2. Verify HMAC reusing `verifySlackSignature` (timing-safe + replay
 *      window).
 *   3. Parse the URL-encoded `payload` JSON.
 *   4. Dispatch by `payload.type`.
 *
 * S3 mutations always go through `withEtagRetry` so concurrent maintainers
 * pressing Apply at the same time can't lose updates.
 */

export const config = {
    api: { bodyParser: false },
};

const SLACK_API_BASE = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 8_000;

// `assertUniqueIds` is typed against `ExplorerAppParsed[]` (post-default
// surfaces). The S3 reads/seed inputs surface as the looser `ExplorerApp[]`
// shape (surfaces optional). Both expose `id` identically, so we wrap with
// a structural adapter rather than casting at every call site.
function assertUniqueIds(apps: ReadonlyArray<{ id: string }>): void {
    assertUniqueIdsTyped(apps as Parameters<typeof assertUniqueIdsTyped>[0]);
}

type SlackResponseBody = Record<string, unknown> | "";



type AuditableField = "url" | "site" | "github";
const AUDITABLE_FIELDS: AuditableField[] = ["url", "site", "github"];

interface BlockActionsPayload {
    type: "block_actions";
    user: { id: string; name?: string };
    trigger_id?: string;
    view?: {
        id: string;
        callback_id?: string;
        private_metadata?: string;
    };
    actions: Array<{
        action_id: string;
        block_id?: string;
        type: string;
        value?: string;
        selected_option?: { value: string };
    }>;
    channel?: { id: string };
    message?: { ts: string };
}

interface ViewSubmissionPayload {
    type: "view_submission";
    user: { id: string; name?: string };
    view: {
        id: string;
        callback_id: string;
        private_metadata: string;
        state: { values: Record<string, Record<string, ViewStateField>> };
    };
}

interface ViewStateField {
    type: string;
    value?: string;
    selected_options?: Array<{ value: string }>;
}

type SlackPayload = BlockActionsPayload | ViewSubmissionPayload;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED" });
        return;
    }

    let env: ReturnType<typeof loadEnv>;
    try {
        env = loadEnv();
    } catch (err) {
        if (err instanceof EnvValidationError) {
            console.error("[slack/actions] env invalid", err.issues);
        } else {
            console.error("[slack/actions] env load failed", err);
        }
        res.status(500).json({ ok: false, code: "ENV_INVALID" });
        return;
    }

    let rawBody: string;
    try {
        rawBody = await readRawBody(req);
    } catch (err) {
        console.error("[slack/actions] failed to read body", err);
        res.status(400).json({ ok: false, code: "BAD_BODY" });
        return;
    }

    try {
        verifySlackSignature({
            rawBody,
            timestamp: pickHeader(req, "x-slack-request-timestamp"),
            signature: pickHeader(req, "x-slack-signature"),
            signingSecret: env.SLACK_SIGNING_SECRET,
        });
    } catch (err) {
        if (err instanceof SlackVerifyError) {
            console.warn("[slack/actions] signature rejected", err.code);
        } else {
            console.error("[slack/actions] signature verify error", err);
        }
        res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
        return;
    }

    let payload: SlackPayload;
    try {
        payload = parsePayload(rawBody);
    } catch (err) {
        console.error("[slack/actions] payload parse failed", err);
        res.status(400).json({ ok: false, code: "BAD_PAYLOAD" });
        return;
    }

    try {
        if (payload.type === "block_actions") {
            const body = await handleBlockActions({ env, payload });
            res.status(200).json(body ?? {});
            return;
        }
        if (payload.type === "view_submission") {
            const body = await handleViewSubmission({ env, payload });
            res.status(200).json(body ?? {});
            return;
        }
        res.status(400).json({ ok: false, code: "UNKNOWN_TYPE" });
    } catch (err) {
        // Slack expects 200 to avoid retry storms. Log and surface a
        // best-effort modal error so the operator sees the failure.
        console.error("[slack/actions] handler failed", describeForLog(err));
        res.status(200).json(modalError("Something went wrong — check Vercel logs."));
    }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function handleBlockActions(args: {
    env: ReturnType<typeof loadEnv>;
    payload: BlockActionsPayload;
}): Promise<SlackResponseBody | undefined> {
    const action = args.payload.actions[0];
    if (action === undefined) return {};

    // Mode-selector inside the admin modal: swap the view to the per-mode body.
    if (action.action_id === "mode_select" && args.payload.view !== undefined) {
        const mode = action.selected_option?.value as AdminMode | undefined;
        if (mode === undefined) return {};
        await routeModeSelect({
            env: args.env,
            viewId: args.payload.view.id,
            mode,
        });
        return {};
    }

    return {};
}

async function routeModeSelect(args: {
    env: ReturnType<typeof loadEnv>;
    viewId: string;
    mode: AdminMode;
}): Promise<void> {
    if (args.mode === "pending") {
        const submissions = await readPendingSubmissions({
            token: args.env.SLACK_BOT_TOKEN,
            channel: args.env.SLACK_APPROVAL_CHANNEL,
        });
        await updateView({
            token: args.env.SLACK_BOT_TOKEN,
            viewId: args.viewId,
            view: buildPendingModalView(submissions),
        });
        return;
    }
    if (args.mode === "existing") {
        await updateView({
            token: args.env.SLACK_BOT_TOKEN,
            viewId: args.viewId,
            view: buildExistingModalView(),
        });
        return;
    }
    await updateView({
        token: args.env.SLACK_BOT_TOKEN,
        viewId: args.viewId,
        view: buildSeedModalView(),
    });
}

async function handleViewSubmission(args: {
    env: ReturnType<typeof loadEnv>;
    payload: ViewSubmissionPayload;
}): Promise<SlackResponseBody | undefined> {
    if (args.payload.view.callback_id !== CALLBACK_ID) {
        return modalError("Unexpected modal — please re-open `/explorer-admin`.");
    }
    const meta = parsePrivateMetadata(args.payload.view.private_metadata);
    if (meta === null) {
        return modalError("Modal metadata corrupted — please re-open `/explorer-admin`.");
    }
    if (meta.mode === "pending") {
        return await handleApprove({ env: args.env, payload: args.payload, meta });
    }
    if (meta.mode === "existing") {
        return await handleEditExisting({ env: args.env, payload: args.payload });
    }
    if (meta.mode === "seed") {
        return await handleSeedMigration({ env: args.env, payload: args.payload, meta });
    }
    return modalError("Unknown mode.");
}

// ---------------------------------------------------------------------------
// pending → approve batch
// ---------------------------------------------------------------------------

async function handleApprove(args: {
    env: ReturnType<typeof loadEnv>;
    payload: ViewSubmissionPayload;
    meta: PrivateMetadata;
}): Promise<SlackResponseBody | undefined> {
    const selectedTs = readSelectedOptions(args.payload, "pending_selection", "selected");
    if (selectedTs.length === 0) {
        return modalError("Nothing selected — pick at least one entry to approve.");
    }

    // Re-read pending submissions (rather than trusting just the ts list
    // baked into private_metadata) so we get the freshest payloads.
    const pending = await readPendingSubmissions({
        token: args.env.SLACK_BOT_TOKEN,
        channel: args.env.SLACK_APPROVAL_CHANNEL,
    });
    const byTs = new Map(pending.map((p) => [p.ts, p]));

    const summary: BatchSummary = { approved: 0, skipped: [], errors: [] };
    const validEntries: ExplorerApp[] = [];
    const validTs: string[] = [];

    for (const ts of selectedTs) {
        const sub = byTs.get(ts);
        if (sub === undefined) {
            summary.skipped.push({ ts, reason: "submission no longer pending (resolved or expired)" });
            continue;
        }
        const parsed = safeParseExplorerApp(sub.payload);
        if (!parsed.ok) {
            summary.skipped.push({ ts, id: tryReadId(sub.payload), reason: `validation: ${parsed.error}` });
            continue;
        }
        validEntries.push(parsed.value);
        validTs.push(ts);
    }

    if (validEntries.length === 0) {
        await postBatchSummary({
            token: args.env.SLACK_BOT_TOKEN,
            channel: args.env.SLACK_APPROVAL_CHANNEL,
            summary,
        });
        return {};
    }

    try {
        await withEtagRetry(async ({ data }) => {
            const existingIds = new Set(data.map((e) => e.id));
            const merged = [...data];
            for (const entry of validEntries) {
                if (existingIds.has(entry.id)) {
                    // Replace in-place (re-approval / late edit semantics).
                    const idx = merged.findIndex((e) => e.id === entry.id);
                    merged[idx] = entry;
                } else {
                    merged.push(entry);
                }
            }
            assertUniqueIds(merged);
            return { data: merged };
        });
        summary.approved = validEntries.length;
        // Reactions are best-effort — a successful S3 write is the canonical
        // truth; a missed reaction just means the row stays "visible" in the
        // next /explorer-admin pending view, which is recoverable.
        for (const ts of validTs) {
            try {
                await markSubmissionApproved({
                    token: args.env.SLACK_BOT_TOKEN,
                    channel: args.env.SLACK_APPROVAL_CHANNEL,
                    ts,
                });
            } catch (err) {
                console.warn("[slack/actions] reactions.add failed", ts, describeForLog(err));
            }
        }
    } catch (err) {
        const reason =
            err instanceof EtagRetryExhaustedError
                ? "S3 ETag conflict (concurrent writers) — retry later"
                : err instanceof DuplicateIdError
                    ? `duplicate ids: ${err.duplicates.join(", ")}`
                    : describeForLog(err);
        for (const ts of validTs) {
            summary.errors.push({ ts, id: byTs.get(ts)?.payload.id, reason });
        }
    }

    await postBatchSummary({
        token: args.env.SLACK_BOT_TOKEN,
        channel: args.env.SLACK_APPROVAL_CHANNEL,
        summary,
    });
    return {};
}

// ---------------------------------------------------------------------------
// existing → edit / delete
// ---------------------------------------------------------------------------

async function handleEditExisting(args: {
    env: ReturnType<typeof loadEnv>;
    payload: ViewSubmissionPayload;
}): Promise<SlackResponseBody | undefined> {
    const id = readInputValue(args.payload, "id", "value")?.trim() ?? "";
    if (id === "") {
        return modalErrorOnBlock("id", "ID is required");
    }
    const deleteSelected =
        readSelectedOptions(args.payload, "delete_confirm", "value").includes("delete");

    if (deleteSelected) {
        try {
            await withEtagRetry(async ({ data }) => {
                const filtered = data.filter((e) => e.id !== id);
                if (filtered.length === data.length) {
                    throw new SlackBatchValidationError(`No entry with id '${id}'`);
                }
                assertUniqueIds(filtered);
                return { data: filtered };
            });
        } catch (err) {
            if (err instanceof SlackBatchValidationError) {
                return modalErrorOnBlock("id", err.message);
            }
            throw err;
        }
        await postMessage({
            token: args.env.SLACK_BOT_TOKEN,
            channel: args.env.SLACK_APPROVAL_CHANNEL,
            blocks: [
                {
                    type: "section",
                    text: { type: "mrkdwn", text: `:wastebasket: Hard-deleted entry \`${id}\` by <@${args.payload.user.id}>` },
                },
            ],
            text: `Deleted ${id}`,
        });
        return {};
    }

    // Edit path: collect non-empty patch fields.
    const patch = collectPatch(args.payload);
    if (Object.keys(patch).length === 0) {
        return modalError("No fields filled — nothing to edit. Check Delete to remove the entry instead.");
    }

    let before: ExplorerApp | undefined;
    let after: ExplorerApp | undefined;

    try {
        await withEtagRetry(async ({ data }) => {
            const idx = data.findIndex((e) => e.id === id);
            if (idx === -1) {
                throw new SlackBatchValidationError(`No entry with id '${id}'`);
            }
            const current = data[idx];
            const candidate = { ...current, ...patch };
            // Defensive guard against a future bug in collectPatch — the id
            // is immutable and must not appear in the patch object.
            if (candidate.id !== current.id) {
                throw new SlackBatchValidationError("id is immutable and cannot change");
            }
            const parsed = explorerAppSchema.safeParse(candidate);
            if (!parsed.success) {
                const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
                throw new SlackBatchValidationError(`Invalid edit: ${detail}`);
            }
            before = current;
            after = parsed.data;
            const next = data.slice();
            next[idx] = parsed.data;
            assertUniqueIds(next);
            return { data: next };
        });
    } catch (err) {
        if (err instanceof SlackBatchValidationError) {
            return modalErrorOnBlock("id", err.message);
        }
        throw err;
    }

    if (before !== undefined && after !== undefined && touchesAuditableField(before, after)) {
        // Best-effort — auditSubmission never throws (returns 'warn' on
        // failure) but we wrap defensively so a Slack post failure can't
        // bubble out of the success path.
        try {
            const verdict = await auditSubmission({
                title: after.title,
                url: after.url,
                site: after.site,
                github: after.github,
                shortDescription: after.shortDescription,
                description: after.description,
                categories: after.categories,
                author: after.author,
            });
            const formatted = formatAuditForSlack(verdict);
            await postMessage({
                token: args.env.SLACK_BOT_TOKEN,
                channel: args.env.SLACK_APPROVAL_CHANNEL,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `:pencil2: Edit on \`${id}\` by <@${args.payload.user.id}> touched ${listChangedAuditFields(before, after)}.\n${formatted.mrkdwn}`,
                        },
                    },
                ],
                text: `Edit audit: ${id}`,
            });
        } catch (err) {
            console.warn("[slack/actions] audit/post failed", describeForLog(err));
        }
    } else {
        await postMessage({
            token: args.env.SLACK_BOT_TOKEN,
            channel: args.env.SLACK_APPROVAL_CHANNEL,
            blocks: [
                {
                    type: "section",
                    text: { type: "mrkdwn", text: `:pencil2: Edited entry \`${id}\` by <@${args.payload.user.id}>` },
                },
            ],
            text: `Edited ${id}`,
        });
    }
    return {};
}

class SlackBatchValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SlackBatchValidationError";
    }
}

function touchesAuditableField(before: ExplorerApp, after: ExplorerApp): boolean {
    return AUDITABLE_FIELDS.some((f) => (before[f] ?? "") !== (after[f] ?? ""));
}

function listChangedAuditFields(before: ExplorerApp, after: ExplorerApp): string {
    return AUDITABLE_FIELDS.filter((f) => (before[f] ?? "") !== (after[f] ?? ""))
        .map((f) => `\`${f}\``)
        .join(", ");
}

function collectPatch(payload: ViewSubmissionPayload): Partial<ExplorerApp> {
    const patch: Partial<ExplorerApp> = {};
    const fields: Array<keyof ExplorerApp> = [
        "title",
        "logo",
        "shortDescription",
        "url",
        "site",
        "github",
        "ecosystemSection",
    ];
    for (const f of fields) {
        const v = readInputValue(payload, f, "value");
        if (v !== undefined && v.trim() !== "") {
            // The schema re-validates on the server-side merge; we just
            // copy the user's text verbatim here.
            (patch as Record<string, string>)[f] = v.trim();
        }
    }
    return patch;
}

// ---------------------------------------------------------------------------
// seed migration — 2-step (input → diff confirm → apply)
// ---------------------------------------------------------------------------

/**
 * Phase 1 (input): parse + validate + compute diff against current S3
 * snapshot, then `response_action: "update"` swaps the view to the diff
 * preview. NO S3 mutation happens in this phase. If the diff is empty
 * the modal is closed with a no-op (no destructive call ever issued).
 *
 * Phase 2 (confirm): the seed JSON travels back from phase-1 inside
 * `private_metadata` (Slack returns it intact in the second submit).
 * We re-parse + re-validate defensively — `private_metadata` is opaque
 * but operator-supplied — and only then run `withEtagRetry`.
 */
async function handleSeedMigration(args: {
    env: ReturnType<typeof loadEnv>;
    payload: ViewSubmissionPayload;
    meta: PrivateMetadata;
}): Promise<SlackResponseBody | undefined> {
    if (args.meta.phase === "confirm") {
        return await applySeedMigration({
            env: args.env,
            user: args.payload.user.id,
            seedJsonRaw: args.meta.seedJson ?? "",
            replace: args.meta.replace === true,
        });
    }
    // phase 1 — input form submitted
    const reviewed = readSelectedOptions(args.payload, "reviewed", "value").includes("ack");
    if (!reviewed) {
        return modalErrorOnBlock("reviewed", "You must confirm you have reviewed the seed JSON.");
    }
    const replace = readSelectedOptions(args.payload, "replace", "value").includes("replace");
    const raw = readInputValue(args.payload, "seed_json", "value")?.trim() ?? "";
    if (raw === "") {
        return modalErrorOnBlock("seed_json", "Seed JSON is required");
    }
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch (err) {
        return modalErrorOnBlock("seed_json", `Invalid JSON: ${(err as Error).message}`);
    }
    const seedResult = explorerAppsArraySchema.safeParse(parsedJson);
    if (!seedResult.success) {
        const detail = seedResult.error.issues.slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
        return modalErrorOnBlock("seed_json", `Schema validation failed: ${detail}`);
    }
    const seed = seedResult.data;
    try {
        assertUniqueIds(seed);
    } catch (err) {
        if (err instanceof DuplicateIdError) {
            return modalErrorOnBlock("seed_json", `Duplicate ids in seed: ${err.duplicates.join(", ")}`);
        }
        throw err;
    }

    // Read the current canonical snapshot (no mutation) to compute the diff.
    let current: ExplorerApp[] = [];
    try {
        const snap = await getJson({ bypassCache: true });
        current = snap.data;
    } catch (err) {
        console.error("[slack/actions] failed to read current seed for diff", describeForLog(err));
        return modalErrorOnBlock("seed_json", "Could not read current canonical JSON to compute diff. Try again.");
    }
    const diff = computeSeedDiff(current, seed, replace ? "replace" : "merge");
    if (diff.added.length === 0 && diff.updated.length === 0 && diff.removed.length === 0) {
        // Nothing would change — close the modal stack and notify the channel.
        await postMessage({
            token: args.env.SLACK_BOT_TOKEN,
            channel: args.env.SLACK_APPROVAL_CHANNEL,
            text: `:information_source: Seed migration submitted by <@${args.payload.user.id}> produced no changes (${replace ? "replace" : "merge"} mode).`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `:information_source: Seed migration submitted by <@${args.payload.user.id}> produced no changes (${replace ? "replace" : "merge"} mode).`,
                    },
                },
            ],
        });
        return { response_action: "clear" };
    }

    // We re-serialise the validated seed so the phase-2 payload matches
    // exactly what we'll re-validate, even if the operator's input had
    // whitespace or comments stripped during parse/serialise.
    const seedJsonNormalised = JSON.stringify(seed);
    const confirmView = buildSeedDiffView({
        diff,
        seedJson: seedJsonNormalised,
        mode: replace ? "replace" : "merge",
    });
    if (confirmView === null) {
        return modalErrorOnBlock(
            "seed_json",
            "Seed too large for in-modal confirmation (>2800 chars after normalisation). Split the change or use a CLI workflow.",
        );
    }
    return { response_action: "update", view: confirmView };
}

async function applySeedMigration(args: {
    env: ReturnType<typeof loadEnv>;
    user: string;
    seedJsonRaw: string;
    replace: boolean;
}): Promise<SlackResponseBody | undefined> {
    if (args.seedJsonRaw === "") {
        return modalError("Seed payload missing from confirmation step — please re-open `/explorer-admin`.");
    }
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(args.seedJsonRaw);
    } catch {
        return modalError("Seed payload corrupted between steps — please re-open `/explorer-admin`.");
    }
    const seedResult = explorerAppsArraySchema.safeParse(parsedJson);
    if (!seedResult.success) {
        return modalError("Seed payload failed re-validation — please re-open `/explorer-admin`.");
    }
    const seed = seedResult.data;
    try {
        assertUniqueIds(seed);
    } catch (err) {
        if (err instanceof DuplicateIdError) {
            return modalError(`Duplicate ids in seed: ${err.duplicates.join(", ")}`);
        }
        throw err;
    }

    let diff = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
    await withEtagRetry(async ({ data }) => {
        diff = computeSeedDiff(data, seed, args.replace ? "replace" : "merge");
        if (args.replace) {
            return { data: seed };
        }
        const byId = new Map(data.map((e) => [e.id, e]));
        for (const entry of seed) {
            byId.set(entry.id, entry);
        }
        const merged = Array.from(byId.values());
        assertUniqueIds(merged);
        return { data: merged };
    });

    await postMessage({
        token: args.env.SLACK_BOT_TOKEN,
        channel: args.env.SLACK_APPROVAL_CHANNEL,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: [
                        `:seedling: Seed migration applied by <@${args.user}> (${args.replace ? "replace" : "merge"} mode).`,
                        `• Added: ${diff.added.length}`,
                        `• Updated: ${diff.updated.length}`,
                        `• Removed: ${diff.removed.length}`,
                    ].join("\n"),
                },
            },
        ],
        text: `Seed applied (${args.replace ? "replace" : "merge"})`,
    });
    return {};
}

// ---------------------------------------------------------------------------
// view_submission helpers
// ---------------------------------------------------------------------------

interface PrivateMetadata {
    mode: AdminMode;
    tsList?: string[];
    /** Seed flow: which step we're on. Absent or "input" = phase 1; "confirm" = phase 2. */
    phase?: "input" | "confirm";
    /** Seed flow phase-2: the validated+normalised seed array, JSON-stringified. */
    seedJson?: string;
    /** Seed flow phase-2: replace (true) vs merge (false). */
    replace?: boolean;
}

function parsePrivateMetadata(raw: string): PrivateMetadata | null {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const mode = parsed.mode;
        if (mode !== "pending" && mode !== "existing" && mode !== "seed") return null;
        const out: PrivateMetadata = { mode };
        if (Array.isArray(parsed.tsList)) {
            out.tsList = parsed.tsList.filter((t): t is string => typeof t === "string");
        }
        if (parsed.phase === "input" || parsed.phase === "confirm") out.phase = parsed.phase;
        if (typeof parsed.seedJson === "string") out.seedJson = parsed.seedJson;
        if (typeof parsed.replace === "boolean") out.replace = parsed.replace;
        return out;
    } catch {
        return null;
    }
}

function readInputValue(payload: ViewSubmissionPayload, blockId: string, actionId: string): string | undefined {
    return payload.view.state.values[blockId]?.[actionId]?.value;
}

function readSelectedOptions(payload: ViewSubmissionPayload, blockId: string, actionId: string): string[] {
    const opts = payload.view.state.values[blockId]?.[actionId]?.selected_options;
    if (opts === undefined) return [];
    return opts.map((o) => o.value);
}

function tryReadId(payload: unknown): string | undefined {
    if (payload !== null && typeof payload === "object" && "id" in payload) {
        const id = (payload as { id: unknown }).id;
        if (typeof id === "string") return id;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Slack response helpers
// ---------------------------------------------------------------------------

function modalError(message: string): SlackResponseBody {
    // `errors` keyed by a known block id surfaces inline; otherwise we fall
    // back to a global response_action=clear (replace modal). For unknown-key
    // errors we use response_action=errors with the intro block as a stand-in
    // so Slack still shows the message.
    return {
        response_action: "errors",
        errors: { intro: message },
    };
}

function modalErrorOnBlock(blockId: string, message: string): SlackResponseBody {
    return {
        response_action: "errors",
        errors: { [blockId]: message },
    };
}

async function updateView(args: {
    token: string;
    viewId: string;
    view: object;
}): Promise<void> {
    const res = await fetch(`${SLACK_API_BASE}/views.update`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${args.token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ view_id: args.viewId, view: args.view }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`views.update HTTP ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
        throw new Error(`views.update error: ${json.error ?? "unknown"}`);
    }
}

// ---------------------------------------------------------------------------
// shared infra
// ---------------------------------------------------------------------------

function parsePayload(rawBody: string): SlackPayload {
    const params = new URLSearchParams(rawBody);
    const raw = params.get("payload");
    if (raw === null) throw new Error("Slack payload field missing from body");
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type !== "block_actions" && parsed.type !== "view_submission") {
        throw new Error(`Unsupported Slack payload type: ${String(parsed.type)}`);
    }
    return parsed as unknown as SlackPayload;
}

function pickHeader(req: VercelRequest, name: string): string {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0] ?? "";
    return v ?? "";
}

async function readRawBody(req: VercelRequest): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", (err: Error) => reject(err));
    });
}

function describeForLog(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
}
