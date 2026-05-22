import { createHmac, timingSafeEqual } from "crypto";

import { SlackVerifyError, SlackVerifyErrorCode, SubmissionError, SubmissionErrorCode } from "./errors";

/**
 * Lightweight Slack client.
 *
 * We hit Slack via plain fetch instead of `@slack/web-api`:
 *  - We only use one endpoint here (chat.postMessage); the modal flow has
 *    its own helpers in `slack-batch.ts` and `api/slack/actions.ts`.
 *  - The official SDK ships a transitive surface (axios, form-data) that is
 *    unnecessary weight on serverless cold starts.
 *  - Direct fetch keeps signature verification and message-building easy to
 *    unit-test without dragging the SDK into mocks.
 */

const SLACK_API_BASE = "https://slack.com/api";
const SIGNATURE_VERSION = "v0";
const REPLAY_WINDOW_SECONDS = 60 * 5;
const REQUEST_TIMEOUT_MS = 8_000;

interface SlackOkResponse {
    ok: true;
}

interface SlackErrorResponse {
    ok: false;
    error: string;
}

type SlackApiResponse<T> = (T & SlackOkResponse) | SlackErrorResponse;

interface PostMessageResponse {
    ts: string;
    channel: string;
}

/**
 * Verify that a Slack request signature matches.
 *
 * @throws {SlackVerifyError} on any failure path (missing inputs, stale
 * timestamp, mismatched signature). Callers should reply 401 without
 * disclosing the specific failure.
 */
export function verifySlackSignature(args: {
    rawBody: string;
    timestamp: string;
    signature: string;
    signingSecret: string;
    nowSeconds?: number;
}): void {
    const { rawBody, timestamp, signature, signingSecret } = args;
    if (!timestamp || !signature || !signingSecret) {
        throw new SlackVerifyError(SlackVerifyErrorCode.MISSING_HEADERS, "Missing Slack signature inputs");
    }

    const timestampSeconds = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampSeconds)) {
        throw new SlackVerifyError(SlackVerifyErrorCode.BAD_TIMESTAMP, "Slack timestamp is not numeric");
    }

    const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
        throw new SlackVerifyError(SlackVerifyErrorCode.TIMESTAMP_EXPIRED, "Slack timestamp is outside the replay window");
    }

    const baseString = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
    const expected = `${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

    // Constant-time compare; both buffers must be equal length.
    if (expected.length !== signature.length) {
        throw new SlackVerifyError(SlackVerifyErrorCode.BAD_SIGNATURE, "Slack signature mismatch");
    }
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signature, "utf8");
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
        throw new SlackVerifyError(SlackVerifyErrorCode.BAD_SIGNATURE, "Slack signature mismatch");
    }
}

export async function postMessage(args: {
    token: string;
    channel: string;
    blocks: Array<Record<string, unknown>>;
    text: string;
    threadTs?: string;
    /**
     * Optional structured metadata attached to the message. Used by the
     * `/explorer-admin` modal (sub-task phase-7e) to filter pending
     * submissions out of `conversations.history` without a sidecar store.
     */
    metadata?: { event_type: string; event_payload: Record<string, unknown> };
}): Promise<PostMessageResponse> {
    const body: Record<string, unknown> = {
        channel: args.channel,
        blocks: args.blocks,
        text: args.text,
    };
    if (args.threadTs !== undefined) {
        body.thread_ts = args.threadTs;
    }
    if (args.metadata !== undefined) {
        body.metadata = args.metadata;
    }
    const data = await slackJsonCall<PostMessageResponse>("chat.postMessage", args.token, body);
    return { ts: data.ts, channel: data.channel };
}

async function slackJsonCall<T>(
    method: string,
    token: string,
    body: Record<string, unknown> | undefined,
    httpMethod: "GET" | "POST" = "POST",
): Promise<T> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
    };
    if (httpMethod === "POST") {
        headers["Content-Type"] = "application/json; charset=utf-8";
    }
    const res = await fetchWithTimeout(`${SLACK_API_BASE}/${method}`, {
        method: httpMethod,
        headers,
        body: httpMethod === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        throw new SubmissionError(SubmissionErrorCode.UPSTREAM_SLACK, `Slack ${method} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as SlackApiResponse<T>;
    if (!json.ok) {
        // Surface the Slack error code but not the bot token (the token never
        // appears in `json`, but we guard anyway by avoiding any spread).
        throw new SubmissionError(SubmissionErrorCode.UPSTREAM_SLACK, `Slack ${method} error: ${json.error}`);
    }
    return json;
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
