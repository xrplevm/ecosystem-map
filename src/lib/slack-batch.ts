import { listPendingSubmissions, type PendingSubmission } from "./airtable";

export type { PendingSubmission } from "./airtable";

/**
 * Slack helpers + view builders that back the `/explorer-admin` slash
 * command.
 *
 * Why this lives outside `slack.ts`:
 *   - `slack.ts` is the legacy intake surface. This module is the
 *     modal/batch surface and uses Slack APIs (views.*, files.*) the legacy
 *     module never touched. Keeping them apart lets us evolve the modal
 *     without destabilising the intake path.
 *   - All HTTP I/O is done with `fetch` so tests stub a single seam
 *     (`globalThis.fetch`) without pulling in `@slack/web-api`.
 *
 * The pending queue is sourced from **Airtable** (`Status = Pending`), not
 * from Slack message metadata — see `airtable.ts`. Status transitions live in
 * Airtable; Slack only carries the notice + batch summary + approval artifacts.
 *
 * Slack API surface used by this module:
 *   - `views.open`, `views.update` — modal lifecycle.
 *   - `chat.postMessage` (also in `slack.ts`) — batch summary.
 *   - `files.getUploadURLExternal` + `files.completeUploadExternal` —
 *     post the updated registry JSON + added logos after a batch.
 */

const SLACK_API_BASE = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 8_000;

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

/**
 * List the Airtable rows awaiting review (`Status = Pending`), mapped to
 * registry candidates. Thin wrapper over `airtable.listPendingSubmissions`
 * so the modal handler imports a single batch surface.
 */
export async function readPendingSubmissions(): Promise<PendingSubmission[]> {
    return listPendingSubmissions();
}

export interface BatchSummary {
    approved: number;
    /** Per-target breakdown of the `approved` total. */
    approvedExplorer: number;
    approvedMap: number;
    approvedBoth: number;
    rejected: number;
    skipped: Array<{ id?: string; recordId?: string; reason: string }>;
    errors: Array<{ id?: string; recordId?: string; reason: string }>;
}

/**
 * Post the batch summary and return its `ts` so approval artifacts can be
 * threaded underneath it.
 */
export async function postBatchSummary(args: {
    token: string;
    channel: string;
    summary: BatchSummary;
    threadTs?: string;
}): Promise<string> {
    const { approved, approvedExplorer, approvedMap, approvedBoth, rejected } = args.summary;
    const approvedLine =
        approved > 0
            ? `• Approved: ${approved} (Explorer dApps: ${approvedExplorer} · Ecosystem map: ${approvedMap} · Both: ${approvedBoth})`
            : `• Approved: ${approved}`;
    const lines = [
        `*Batch summary*`,
        approvedLine,
        `• Rejected: ${rejected}`,
        `• Skipped: ${args.summary.skipped.length}`,
        `• Errors: ${args.summary.errors.length}`,
    ];
    if (args.summary.skipped.length > 0) {
        lines.push("", "*Skipped*");
        for (const s of args.summary.skipped) {
            lines.push(`• \`${s.id ?? s.recordId ?? "?"}\` — ${s.reason}`);
        }
    }
    if (args.summary.errors.length > 0) {
        lines.push("", "*Errors*");
        for (const e of args.summary.errors) {
            lines.push(`• \`${e.id ?? e.recordId ?? "?"}\` — ${e.reason}`);
        }
    }
    const body: Record<string, unknown> = {
        channel: args.channel,
        text: lines.join("\n"),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
    };
    if (args.threadTs !== undefined) body.thread_ts = args.threadTs;
    const res = await slackCall<{ ts: string }>("chat.postMessage", args.token, body);
    return res.ts;
}

export interface ApprovalArtifact {
    filename: string;
    bytes: Buffer;
    title: string;
}

/**
 * After a successful batch, upload the updated `explorer-apps.json` and each
 * newly added logo PNG to the channel (threaded under the summary) as a
 * Slack-side record of exactly what was added. No-op when `files` is empty.
 *
 * Uses Slack's two-step external upload (`files.getUploadURLExternal` →
 * POST bytes → `files.completeUploadExternal`); `files.upload` is deprecated.
 */
export async function postApprovalArtifacts(args: {
    token: string;
    channel: string;
    threadTs?: string;
    files: ApprovalArtifact[];
}): Promise<void> {
    if (args.files.length === 0) return;
    const completed: Array<{ id: string; title: string }> = [];
    for (const file of args.files) {
        const params = new URLSearchParams({
            filename: file.filename,
            length: String(file.bytes.length),
        });
        const ticket = await slackCall<{ upload_url: string; file_id: string }>(
            `files.getUploadURLExternal?${params.toString()}`,
            args.token,
            undefined,
            "GET",
        );
        const upload = await fetch(ticket.upload_url, {
            method: "POST",
            body: new Uint8Array(file.bytes),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!upload.ok) {
            throw new SlackBatchError("UPLOAD", `File upload POST returned HTTP ${upload.status}`);
        }
        completed.push({ id: ticket.file_id, title: file.title });
    }
    const body: Record<string, unknown> = {
        files: completed,
        channel_id: args.channel,
    };
    if (args.threadTs !== undefined) body.thread_ts = args.threadTs;
    await slackCall<unknown>("files.completeUploadExternal", args.token, body);
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
                text:
                    `*Pending submissions*: ${submissions.length}\n` +
                    "Check each row under the surface to publish it to — *Explorer dApps*, " +
                    "*Ecosystem map*, or *Both* — or under *Reject* to dismiss. A row left " +
                    "unchecked everywhere stays pending; a row checked in more than one group is refused.",
            },
        },
    ];
    if (submissions.length === 0) {
        return {
            type: "modal",
            callback_id: CALLBACK_ID,
            title: { type: "plain_text", text: "Explorer admin" },
            close: { type: "plain_text", text: "Close" },
            private_metadata: JSON.stringify({ mode: "pending", recordList: [] }),
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
            text: truncate(`${s.candidate.title} (${s.candidate.id})`, 75),
        },
        description: {
            type: "plain_text" as const,
            text: truncate(s.candidate.url, 75),
        },
        value: s.recordId,
    }));
    return {
        type: "modal",
        callback_id: CALLBACK_ID,
        title: { type: "plain_text", text: "Explorer admin" },
        submit: { type: "plain_text", text: "Apply decisions" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({
            mode: "pending",
            recordList: submissions.map((s) => s.recordId),
        }),
        blocks: [
            ...baseBlocks,
            approveGroup("pending_approve_explorer", "Approve → Explorer dApps", options),
            approveGroup("pending_approve_map", "Approve → Ecosystem map", options),
            approveGroup("pending_approve_both", "Approve → Both surfaces", options),
            approveGroup("pending_reject", "Reject", options),
        ],
    };
}

type CheckboxOption = {
    text: { type: "plain_text"; text: string };
    description: { type: "plain_text"; text: string };
    value: string;
};

function approveGroup(blockId: string, label: string, options: CheckboxOption[]): SlackBlock {
    return {
        type: "input",
        block_id: blockId,
        optional: true,
        label: { type: "plain_text", text: label },
        element: { type: "checkboxes", action_id: "selected", options },
    };
}

/** Block ids of the per-surface approve groups + reject, in display order. */
export const PENDING_DECISION_BLOCKS = {
    explorer: "pending_approve_explorer",
    map: "pending_approve_map",
    both: "pending_approve_both",
    reject: "pending_reject",
} as const;

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
