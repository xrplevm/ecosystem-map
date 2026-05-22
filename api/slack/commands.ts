import type { VercelRequest, VercelResponse } from "@vercel/node";

import { loadEnv } from "../../src/lib/env";
import { EnvValidationError, SlackVerifyError } from "../../src/lib/errors";
import { verifySlackSignature } from "../../src/lib/slack";
import { buildModeSelectorView, SlackBatchError } from "../../src/lib/slack-batch";

/**
 * POST /api/slack/commands — receives Slack slash-command payloads.
 *
 * Currently a single command, `/explorer-admin`, opens the multi-mode
 * admin modal (Pending / Existing / Seed). The mode picker is the modal
 * body; selecting a mode swaps the view via `views.update` (handled in
 * `api/slack/actions.ts` under the `block_actions` branch).
 *
 *   1. Read raw body (Vercel body parser disabled — we need exact bytes
 *      Slack signed).
 *   2. Verify HMAC (timing-safe + replay window) reusing
 *      `verifySlackSignature`.
 *   3. Parse the URL-encoded form (Slack posts slash commands as
 *      `application/x-www-form-urlencoded`, NOT JSON).
 *   4. Open the modal with `views.open` using the supplied `trigger_id`.
 *   5. Reply 200 with empty body so Slack dismisses the slash response.
 */

export const config = {
    api: { bodyParser: false },
};

const SLACK_API_BASE = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 8_000;
const ALLOWED_COMMANDS = new Set(["/explorer-admin"]);

interface SlashPayload {
    command: string;
    trigger_id: string;
    user_id: string;
    channel_id: string;
}

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
            console.error("[slack/commands] env invalid", err.issues);
        } else {
            console.error("[slack/commands] env load failed", err);
        }
        res.status(500).json({ ok: false, code: "ENV_INVALID" });
        return;
    }

    let rawBody: string;
    try {
        rawBody = await readRawBody(req);
    } catch (err) {
        console.error("[slack/commands] failed to read body", err);
        res.status(400).json({ ok: false, code: "BAD_BODY" });
        return;
    }

    const timestamp = pickHeader(req, "x-slack-request-timestamp");
    const signature = pickHeader(req, "x-slack-signature");

    try {
        verifySlackSignature({
            rawBody,
            timestamp,
            signature,
            signingSecret: env.SLACK_SIGNING_SECRET,
        });
    } catch (err) {
        if (err instanceof SlackVerifyError) {
            console.warn("[slack/commands] signature rejected", err.code);
        } else {
            console.error("[slack/commands] signature verify error", err);
        }
        res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
        return;
    }

    const payload = parseSlashPayload(rawBody);
    if (payload === null) {
        res.status(400).json({ ok: false, code: "BAD_PAYLOAD" });
        return;
    }
    if (!ALLOWED_COMMANDS.has(payload.command)) {
        // A command we don't recognise reaches us only via misconfiguration
        // — bail with a copy the operator sees in the channel.
        res.status(200).json({
            response_type: "ephemeral",
            text: `Unknown command: ${payload.command}`,
        });
        return;
    }

    try {
        await openView({
            token: env.SLACK_BOT_TOKEN,
            triggerId: payload.trigger_id,
            view: buildModeSelectorView(),
        });
        // Slash commands expect 200 with empty body (or a minimal ephemeral
        // payload) so Slack does not echo the command text in-channel.
        res.status(200).json({});
    } catch (err) {
        if (err instanceof SlackBatchError) {
            console.error("[slack/commands] views.open failed", err.code, err.message);
        } else {
            console.error("[slack/commands] views.open error", err);
        }
        res.status(200).json({
            response_type: "ephemeral",
            text: ":warning: Couldn't open the admin modal — check Vercel logs.",
        });
    }
}

function parseSlashPayload(rawBody: string): SlashPayload | null {
    const params = new URLSearchParams(rawBody);
    const command = params.get("command");
    const triggerId = params.get("trigger_id");
    const userId = params.get("user_id");
    const channelId = params.get("channel_id");
    if (command === null || triggerId === null || userId === null || channelId === null) {
        return null;
    }
    return { command, trigger_id: triggerId, user_id: userId, channel_id: channelId };
}

async function openView(args: {
    token: string;
    triggerId: string;
    view: object;
}): Promise<void> {
    const res = await fetch(`${SLACK_API_BASE}/views.open`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${args.token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ trigger_id: args.triggerId, view: args.view }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new SlackBatchError("HTTP", `views.open returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
        throw new SlackBatchError("SLACK_API", `views.open failed: ${json.error ?? "unknown"}`);
    }
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
