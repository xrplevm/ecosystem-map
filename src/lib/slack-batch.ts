import type { ExplorerApp } from "./explorer-apps-types";

/**
 * Slack helpers + view builders that back the `/explorer-admin` slash
 * command (sub-task phase-7e).
 *
 * Why this lives outside `slack.ts`:
 *   - `slack.ts` is the legacy intake/approval surface (button-driven).
 *     This module is the modal/batch surface and uses Slack APIs (views.*,
 *     conversations.history, reactions.add) the legacy module never
 *     touched. Keeping them apart lets us evolve the modal without
 *     destabilising the v1 intake path.
 *   - All HTTP I/O is done with `fetch` so tests stub a single seam
 *     (`globalThis.fetch`) without pulling in `@slack/web-api`.
 *
 * Slack API surface used by this module:
 *   - `views.open`, `views.update` — modal lifecycle.
 *   - `conversations.history` (`include_all_metadata=true`) — Slack is
 *     the source-of-truth for pending submissions; we filter messages
 *     bearing `metadata.event_type === "explorer_submission_pending"`
 *     that have not yet been resolved (no ✅/❌ reaction from us).
 *   - `reactions.add` — terminal-state markers.
 *   - `chat.postMessage` (already in `slack.ts`) — batch summary.
 */

const SLACK_API_BASE = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 8_000;
const PENDING_HISTORY_LIMIT = 50;

export const PENDING_EVENT_TYPE = "explorer_submission_pending";
export const APPROVED_REACTION = "white_check_mark";
export const REJECTED_REACTION = "x";

export class SlackBatchError extends Error {
    public readonly code: string;
    public readonly cause?: unknown;
    constructor(code: string, message: string, cause?: unknown) {
        super(message);
        this.name = "SlackBatchError";
        this.code = code;
        this.cause = cause;
    }
}

interface SlackOk { ok: true }
interface SlackErr { ok: false; error: string }

async function slackCall<T>(
    method: string,
    token: string,
    body: Record<string, unknown> | undefined,
    httpMethod: "GET" | "POST" = "POST",
): Promise<T & SlackOk> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (httpMethod === "POST") headers["Content-Type"] = "application/json; charset=utf-8";
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: httpMethod,
        headers,
        body: httpMethod === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new SlackBatchError("HTTP", `Slack ${method} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as (T & SlackOk) | SlackErr;
    if (!json.ok) {
        throw new SlackBatchError("SLACK_API", `Slack ${method} failed: ${json.error}`);
    }
    return json;
}

export interface PendingSubmission {
    ts: string;
    /** The structured payload originally attached as message metadata. */
    payload: ExplorerApp;
    /** Reactions already on the message (used to filter out resolved ones). */
    reactions: string[];
}

interface HistoryMessage {
    ts: string;
    metadata?: {
        event_type?: string;
        event_payload?: Record<string, unknown>;
    };
    reactions?: Array<{ name: string; users?: string[]; count?: number }>;
}

interface ConversationsHistoryResponse {
    messages: HistoryMessage[];
}

/**
 * List unresolved submissions in the channel — messages we tagged with the
 * `explorer_submission_pending` metadata that don't yet carry our terminal
 * reaction. Truncated at PENDING_HISTORY_LIMIT (Slack modal can't fit more
 * than ~50 checkboxes anyway).
 */
export async function readPendingSubmissions(args: {
    token: string;
    channel: string;
    limit?: number;
}): Promise<PendingSubmission[]> {
    const limit = args.limit ?? PENDING_HISTORY_LIMIT;
    // `include_all_metadata=true` is the documented opt-in to receive the
    // `metadata` field on history messages. Without it, Slack omits the
    // structured payload we wrote at intake time.
    const data = await slackCall<ConversationsHistoryResponse>(
        `conversations.history?channel=${encodeURIComponent(args.channel)}&include_all_metadata=true&limit=${limit}`,
        args.token,
        undefined,
        "GET",
    );
    const out: PendingSubmission[] = [];
    for (const msg of data.messages) {
        if (msg.metadata?.event_type !== PENDING_EVENT_TYPE) continue;
        const reactions = (msg.reactions ?? []).map((r) => r.name);
        if (reactions.includes(APPROVED_REACTION) || reactions.includes(REJECTED_REACTION)) continue;
        const payload = msg.metadata.event_payload;
        if (payload === undefined || payload === null) continue;
        // Defensive: the payload is opaque at this layer — the modal handler
        // re-validates with the explorer-app Zod schema before mutating S3.
        out.push({ ts: msg.ts, payload: payload as unknown as ExplorerApp, reactions });
    }
    return out;
}

export async function markSubmissionApproved(args: {
    token: string;
    channel: string;
    ts: string;
}): Promise<void> {
    await slackCall<unknown>("reactions.add", args.token, {
        channel: args.channel,
        timestamp: args.ts,
        name: APPROVED_REACTION,
    });
}

export async function markSubmissionRejected(args: {
    token: string;
    channel: string;
    ts: string;
}): Promise<void> {
    await slackCall<unknown>("reactions.add", args.token, {
        channel: args.channel,
        timestamp: args.ts,
        name: REJECTED_REACTION,
    });
}

export interface BatchSummary {
    approved: number;
    skipped: Array<{ id?: string; ts?: string; reason: string }>;
    errors: Array<{ id?: string; ts?: string; reason: string }>;
}

export async function postBatchSummary(args: {
    token: string;
    channel: string;
    summary: BatchSummary;
    threadTs?: string;
}): Promise<void> {
    const { approved } = args.summary;
    const lines = [
        `*Batch summary*`,
        `• Approved: ${approved}`,
        `• Skipped: ${args.summary.skipped.length}`,
        `• Errors: ${args.summary.errors.length}`,
    ];
    if (args.summary.skipped.length > 0) {
        lines.push("", "*Skipped*");
        for (const s of args.summary.skipped) {
            lines.push(`• \`${s.id ?? s.ts ?? "?"}\` — ${s.reason}`);
        }
    }
    if (args.summary.errors.length > 0) {
        lines.push("", "*Errors*");
        for (const e of args.summary.errors) {
            lines.push(`• \`${e.id ?? e.ts ?? "?"}\` — ${e.reason}`);
        }
    }
    const body: Record<string, unknown> = {
        channel: args.channel,
        text: lines.join("\n"),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
    };
    if (args.threadTs !== undefined) body.thread_ts = args.threadTs;
    await slackCall<unknown>("chat.postMessage", args.token, body);
}

// ---------------------------------------------------------------------------
// view builders
// ---------------------------------------------------------------------------

export type AdminMode = "pending" | "existing" | "seed";
export const CALLBACK_ID = "explorer_admin_v1";

interface SlackBlock {
    type: string;
    [key: string]: unknown;
}

interface SlackView {
    type: "modal";
    callback_id?: string;
    title: { type: "plain_text"; text: string };
    submit?: { type: "plain_text"; text: string };
    close?: { type: "plain_text"; text: string };
    private_metadata?: string;
    blocks: SlackBlock[];
}

const MODE_OPTIONS: Array<{ value: AdminMode; label: string }> = [
    { value: "pending", label: "Pending submissions" },
    { value: "existing", label: "Existing entries (edit / delete)" },
    { value: "seed", label: "Seed migration" },
];

/**
 * Initial view shown when the slash command opens the modal — a single
 * mode picker with `dispatch_action`. When the user picks a mode, Slack
 * sends a `block_actions` event and the handler swaps the view via
 * `views.update` to the per-mode body. No submit until a mode is chosen.
 */
export function buildModeSelectorView(): SlackView {
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Explorer admin" },
        close: { type: "plain_text", text: "Close" },
        blocks: [
            {
                type: "section",
                block_id: "intro",
                text: {
                    type: "mrkdwn",
                    text: "Pick a mode to load the corresponding form.",
                },
            },
            {
                type: "actions",
                block_id: "mode_block",
                elements: [
                    {
                        type: "static_select",
                        action_id: "mode_select",
                        placeholder: { type: "plain_text", text: "Choose mode" },
                        options: MODE_OPTIONS.map((o) => ({
                            text: { type: "plain_text", text: o.label },
                            value: o.value,
                        })),
                    },
                ],
            },
        ],
    };
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
}

export function buildPendingModalView(submissions: PendingSubmission[]): SlackView {
    const baseBlocks: SlackBlock[] = [
        {
            type: "section",
            block_id: "pending_intro",
            text: {
                type: "mrkdwn",
                text: `*Pending submissions*: ${submissions.length}\nCheck the entries you want to approve and submit. Unchecked entries stay pending.`,
            },
        },
    ];
    if (submissions.length === 0) {
        return {
            type: "modal",
            callback_id: CALLBACK_ID,
            title: { type: "plain_text", text: "Explorer admin" },
            close: { type: "plain_text", text: "Close" },
            private_metadata: JSON.stringify({ mode: "pending", tsList: [] }),
            blocks: [
                ...baseBlocks,
                {
                    type: "section",
                    text: { type: "mrkdwn", text: "_No pending submissions._" },
                },
            ],
        };
    }
    const options = submissions.map((s) => ({
        text: {
            type: "plain_text" as const,
            text: truncate(`${s.payload.title} (${s.payload.id})`, 75),
        },
        description: {
            type: "plain_text" as const,
            text: truncate(s.payload.url, 75),
        },
        value: s.ts,
    }));
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Explorer admin" },
        submit: { type: "plain_text", text: "Approve selected" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({
            mode: "pending",
            tsList: submissions.map((s) => s.ts),
        }),
        blocks: [
            ...baseBlocks,
            {
                type: "input",
                block_id: "pending_selection",
                optional: true,
                label: { type: "plain_text", text: "Approve" },
                element: {
                    type: "checkboxes",
                    action_id: "selected",
                    options,
                },
            },
        ],
    };
}

export function buildExistingModalView(): SlackView {
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Explorer admin" },
        submit: { type: "plain_text", text: "Apply" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ mode: "existing" }),
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "*Edit / delete an existing entry*\nFill the `id` of the entry to mutate. Optional fields below override the current value when non-empty. Check *Delete* to hard-delete instead.",
                },
            },
            {
                type: "input",
                block_id: "id",
                label: { type: "plain_text", text: "ID (immutable)" },
                element: { type: "plain_text_input", action_id: "value" },
            },
            {
                type: "input",
                block_id: "delete_confirm",
                optional: true,
                label: { type: "plain_text", text: "Hard delete" },
                element: {
                    type: "checkboxes",
                    action_id: "value",
                    options: [
                        {
                            text: { type: "plain_text", text: "I confirm hard deletion of this entry" },
                            value: "delete",
                        },
                    ],
                },
            },
            ...inputBlock("title", "Title", false),
            ...inputBlock("logo", "Logo URL (https://...)", false),
            ...inputBlock("shortDescription", "Short description (≤160 chars)", false),
            ...inputBlock("url", "Primary URL", false),
            ...inputBlock("site", "Site URL", false),
            ...inputBlock("github", "GitHub URL", false),
            ...inputBlock("ecosystemSection", "Ecosystem section (slug)", false),
        ],
    };
}

function inputBlock(blockId: string, label: string, required: boolean): SlackBlock[] {
    return [
        {
            type: "input",
            block_id: blockId,
            optional: !required,
            label: { type: "plain_text", text: label },
            element: { type: "plain_text_input", action_id: "value" },
        },
    ];
}

export function buildSeedModalView(): SlackView {
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Explorer admin" },
        submit: { type: "plain_text", text: "Apply seed" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ mode: "seed" }),
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "*Seed migration*\nPaste the seed array (`ExplorerApp[]`). Choose Replace to overwrite the canonical JSON, or leave unchecked to merge by `id`.",
                },
            },
            {
                type: "input",
                block_id: "seed_json",
                label: { type: "plain_text", text: "Seed JSON" },
                element: {
                    type: "plain_text_input",
                    action_id: "value",
                    multiline: true,
                },
            },
            {
                type: "input",
                block_id: "replace",
                optional: true,
                label: { type: "plain_text", text: "Replace mode" },
                element: {
                    type: "checkboxes",
                    action_id: "value",
                    options: [
                        {
                            text: { type: "plain_text", text: "Replace entire JSON (default: merge by id)" },
                            value: "replace",
                        },
                    ],
                },
            },
            {
                type: "input",
                block_id: "reviewed",
                label: { type: "plain_text", text: "Confirmation" },
                element: {
                    type: "checkboxes",
                    action_id: "value",
                    options: [
                        {
                            text: { type: "plain_text", text: "I have reviewed the seed JSON and accept this mutation" },
                            value: "ack",
                        },
                    ],
                },
            },
        ],
    };
}

export interface SeedDiff {
    added: string[];
    updated: string[];
    removed: string[];
}

/**
 * Maximum bytes Slack accepts for `view.private_metadata` (3000 chars).
 * We leave headroom for the JSON envelope keys (`mode`, `phase`, …) so the
 * effective payload budget for the seed body is ~2800 chars.
 */
export const PRIVATE_METADATA_LIMIT = 3000;
const SEED_PAYLOAD_BUDGET = 2800;

/**
 * Truncate a list of ids for human-readable preview, capping at `max` items.
 * Returns `<list joined> + ", … (+N more)"` when truncated.
 */
function previewIds(ids: readonly string[], max = 20): string {
    if (ids.length === 0) return "_(none)_";
    if (ids.length <= max) return ids.map((i) => `\`${i}\``).join(", ");
    const head = ids.slice(0, max).map((i) => `\`${i}\``).join(", ");
    return `${head}, … (+${ids.length - max} more)`;
}

/**
 * Phase-2 confirmation view for seed migration. Renders the diff produced
 * by `computeSeedDiff` (added/updated/removed) so the maintainer reviews
 * exactly what will change before the apply.
 *
 * The seed JSON itself travels in `private_metadata` between phase-1
 * (input) and phase-2 (confirm) — Slack returns it intact in the second
 * `view_submission`. We pick `private_metadata` over an in-memory map
 * because Vercel/Lambda containers are ephemeral and a follow-up submit
 * can land on a different cold-started instance; round-tripping through
 * Slack is the only stateless option that survives that.
 *
 * If the seed exceeds Slack's 3000-char private_metadata budget the caller
 * gets back `null` and is expected to surface an inline error directing
 * the maintainer to use a smaller seed (or run via a CLI for bulk ops).
 */
export function buildSeedDiffView(args: {
    diff: SeedDiff;
    seedJson: string;
    mode: "replace" | "merge";
}): SlackView | null {
    const meta = JSON.stringify({
        mode: "seed" as const,
        phase: "confirm" as const,
        seedJson: args.seedJson,
        replace: args.mode === "replace",
    });
    if (meta.length > PRIVATE_METADATA_LIMIT || args.seedJson.length > SEED_PAYLOAD_BUDGET) {
        return null;
    }
    const total = args.diff.added.length + args.diff.updated.length + args.diff.removed.length;
    const summary = [
        `*Confirm seed migration* (${args.mode === "replace" ? "replace" : "merge"} mode)`,
        `Total changes: *${total}*`,
        `• Added: *${args.diff.added.length}*`,
        `• Updated: *${args.diff.updated.length}*`,
        ...(args.mode === "replace" ? [`• Removed: *${args.diff.removed.length}*`] : []),
    ].join("\n");
    const blocks: SlackBlock[] = [
        { type: "section", block_id: "diff_summary", text: { type: "mrkdwn", text: summary } },
        { type: "divider" },
        {
            type: "section",
            block_id: "diff_added",
            text: { type: "mrkdwn", text: `*Added (${args.diff.added.length}):* ${previewIds(args.diff.added)}` },
        },
        {
            type: "section",
            block_id: "diff_updated",
            text: { type: "mrkdwn", text: `*Updated (${args.diff.updated.length}):* ${previewIds(args.diff.updated)}` },
        },
    ];
    if (args.mode === "replace") {
        blocks.push({
            type: "section",
            block_id: "diff_removed",
            text: { type: "mrkdwn", text: `*Removed (${args.diff.removed.length}):* ${previewIds(args.diff.removed)}` },
        });
    }
    blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "_Submit again to apply. Cancel to abort._" }],
    });
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Confirm seed" },
        submit: { type: "plain_text", text: "Apply" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: meta,
        blocks,
    };
}

export function computeSeedDiff(
    current: ReadonlyArray<{ id: string }>,
    next: ReadonlyArray<{ id: string }>,
    mode: "replace" | "merge",
): SeedDiff {
    const currentIds = new Set(current.map((e) => e.id));
    const nextIds = new Set(next.map((e) => e.id));
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const id of Array.from(nextIds)) {
        if (currentIds.has(id)) updated.push(id);
        else added.push(id);
    }
    if (mode === "replace") {
        for (const id of Array.from(currentIds)) {
            if (!nextIds.has(id)) removed.push(id);
        }
    }
    return { added, updated, removed };
}
