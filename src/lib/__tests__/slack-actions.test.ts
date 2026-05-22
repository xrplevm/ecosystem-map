/**
 * @jest-environment node
 *
 * End-to-end tests for the `/api/slack/actions` dispatcher. We drive the
 * exported handler with signed bodies and stub:
 *   - `globalThis.fetch` for Slack API calls (history / reactions / views
 *     / chat.postMessage).
 *   - The S3 client (`aws-sdk-client-mock`) for `getObject` /
 *     `putObject`, so `withEtagRetry` exercises the real retry logic.
 *   - The Anthropic SDK module (`@anthropic-ai/sdk`) so audit calls don't
 *     touch the network.
 */
/* eslint-disable import/first */

// Stub Anthropic so `auditSubmission` can be exercised without a real key.
// `jest.mock` is hoisted by Jest above the static `import`s below.
jest.mock("@anthropic-ai/sdk", () => {
    const create = jest.fn(async () => ({
        content: [{ type: "text", text: JSON.stringify({ verdict: "ok", findings: [] }) }],
    }));
    return {
        __esModule: true,
        default: jest.fn().mockImplementation(() => ({ messages: { create } })),
    };
});

import { createHmac } from "crypto";

import { GetObjectCommand, GetObjectCommandOutput, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import handler from "../../../api/slack/actions";
import { __resetEnvCacheForTests } from "../env";
import { __resetS3StateForTests } from "../s3-client";
import type { ExplorerApp } from "../explorer-apps-types";

const SIGNING_SECRET = "x".repeat(32);

const s3Mock = mockClient(S3Client);

// ---------- helpers ----------

function bodyFrom(json: unknown): GetObjectCommandOutput["Body"] {
    const text = JSON.stringify(json);
    return { transformToString: async () => text } as unknown as GetObjectCommandOutput["Body"];
}

function sign(rawBody: string, timestamp: string): string {
    const base = `v0:${timestamp}:${rawBody}`;
    return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function jsonResp(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

interface FetchCall {
    url: string;
    init: RequestInit;
}

function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): {
    spy: jest.Mock;
    calls: FetchCall[];
} {
    const calls: FetchCall[] = [];
    const spy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        calls.push({ url, init: init ?? {} });
        return impl(url, init);
    });
    (globalThis as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
    return { spy, calls };
}

interface FakeReq { method: string; headers: Record<string, string>; on: (event: string, cb: (chunk: unknown) => void) => FakeReq; }

function makeReq(rawBody: string, headers: Record<string, string>): FakeReq {
    const listeners: Record<string, (chunk: unknown) => void> = {};
    const req: FakeReq = {
        method: "POST",
        headers,
        on(event, cb) {
            listeners[event] = cb;
            queueMicrotask(() => {
                if (event === "end" && listeners.data !== undefined) {
                    listeners.data(Buffer.from(rawBody, "utf8"));
                    cb(undefined);
                }
            });
            return req;
        },
    };
    return req;
}

interface FakeRes {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    setHeader: (k: string, v: string) => void;
    status: (code: number) => FakeRes;
    json: (body: unknown) => FakeRes;
    end: () => FakeRes;
}

function makeRes(): FakeRes {
    const res: FakeRes = {
        statusCode: 0,
        body: undefined,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        end() { return this; },
    };
    return res;
}

async function postSignedPayload(payload: Record<string, unknown>): Promise<FakeRes> {
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const req = makeReq(rawBody, {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(rawBody, ts),
    }) as unknown as Parameters<typeof handler>[0];
    const res = makeRes();
    await handler(req, res as unknown as Parameters<typeof handler>[1]);
    return res;
}

// ---------- fixtures ----------

const ACME: ExplorerApp = {
    id: "acme", external: true, title: "Acme", logo: "https://x.example/a.png",
    shortDescription: "x", categories: ["bridge"], author: "Acme", url: "https://acme.example",
};
const BETA: ExplorerApp = {
    id: "beta", external: true, title: "Beta", logo: "https://x.example/b.png",
    shortDescription: "y", categories: ["defi"], author: "Beta", url: "https://beta.example",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    s3Mock.reset();
    __resetEnvCacheForTests();
    __resetS3StateForTests();
    process.env = { ...ORIGINAL_ENV };
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    process.env.SLACK_APPROVAL_CHANNEL = "C123";
    process.env.AWS_REGION = "eu-west-1";
    process.env.S3_BUCKET = "peersyst-development";
    process.env.S3_JSON_KEY = "explorer-apps.json";
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
});

afterAll(() => { process.env = ORIGINAL_ENV; });
afterEach(() => { jest.restoreAllMocks(); });

// ---------- approve (pending mode) ----------

describe("view_submission · pending mode (approve batch)", () => {
    it("appends valid submissions to S3, marks ✅, and posts a summary", async () => {
        // Existing canonical JSON has BETA only.
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });

        const slackResponses = new Map<string, unknown>([
            ["conversations.history", {
                ok: true,
                messages: [
                    { ts: "1.0", metadata: { event_type: "explorer_submission_pending", event_payload: ACME }, reactions: [] },
                ],
            }],
            ["reactions.add", { ok: true }],
            ["chat.postMessage", { ok: true }],
        ]);
        const { calls } = installFetch(async (url) => {
            for (const [k, body] of Array.from(slackResponses)) if (url.includes(k)) return jsonResp(body);
            return jsonResp({ ok: true });
        });

        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "pending", tsList: ["1.0"] }),
                state: {
                    values: {
                        pending_selection: {
                            selected: { type: "checkboxes", selected_options: [{ value: "1.0" }] },
                        },
                    },
                },
            },
        });

        expect(res.statusCode).toBe(200);
        // S3 PUT body = original [BETA] + new [ACME] (order: existing first then appended).
        const puts = s3Mock.commandCalls(PutObjectCommand);
        expect(puts).toHaveLength(1);
        const written = JSON.parse(puts[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id).sort()).toEqual(["acme", "beta"]);

        // reactions.add called with the right ts.
        const reactionCalls = calls.filter((c) => c.url.includes("reactions.add"));
        expect(reactionCalls).toHaveLength(1);
        expect(JSON.parse(reactionCalls[0].init.body as string)).toMatchObject({
            channel: "C123", timestamp: "1.0", name: "white_check_mark",
        });
        // Summary posted with approved=1.
        const summaryCall = calls.find((c) => c.url.includes("chat.postMessage"));
        expect(summaryCall).toBeDefined();
        expect((JSON.parse(summaryCall!.init.body as string) as { text: string }).text).toContain("Approved: 1");
    });

    it("skips submissions failing schema validation and reports them in the summary", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        const broken = { ...ACME, url: "not-a-url" };
        installFetch(async (url) => {
            if (url.includes("conversations.history")) {
                return jsonResp({
                    ok: true,
                    messages: [
                        { ts: "1.0", metadata: { event_type: "explorer_submission_pending", event_payload: broken }, reactions: [] },
                    ],
                });
            }
            return jsonResp({ ok: true });
        });
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "pending" }),
                state: {
                    values: {
                        pending_selection: { selected: { type: "checkboxes", selected_options: [{ value: "1.0" }] } },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        // Nothing valid, so no S3 PUT.
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("returns inline modal error when no entries are selected", async () => {
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "pending" }),
                state: { values: { pending_selection: { selected: { type: "checkboxes", selected_options: [] } } } },
            },
        });
        expect((res.body as { response_action?: string }).response_action).toBe("errors");
    });
});

// ---------- existing (edit/delete) ----------

describe("view_submission · existing mode (edit / delete)", () => {
    it("filters the entry on delete and writes the shrunken array", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME, BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        installFetch(async () => jsonResp({ ok: true }));

        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "existing" }),
                state: {
                    values: {
                        id: { value: { type: "plain_text_input", value: "acme" } },
                        delete_confirm: { value: { type: "checkboxes", selected_options: [{ value: "delete" }] } },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        const puts = s3Mock.commandCalls(PutObjectCommand);
        expect(puts).toHaveLength(1);
        const written = JSON.parse(puts[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id)).toEqual(["beta"]);
    });

    it("rejects delete when the id does not exist (inline modal error)", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "existing" }),
                state: {
                    values: {
                        id: { value: { type: "plain_text_input", value: "ghost" } },
                        delete_confirm: { value: { type: "checkboxes", selected_options: [{ value: "delete" }] } },
                    },
                },
            },
        });
        const body = res.body as { response_action: string; errors: Record<string, string> };
        expect(body.response_action).toBe("errors");
        expect(body.errors.id).toContain("ghost");
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("patches a non-auditable field without invoking the audit pipeline", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        const { calls } = installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "existing" }),
                state: {
                    values: {
                        id: { value: { type: "plain_text_input", value: "acme" } },
                        title: { value: { type: "plain_text_input", value: "Acme Renamed" } },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        const puts = s3Mock.commandCalls(PutObjectCommand);
        const written = JSON.parse(puts[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written[0].title).toBe("Acme Renamed");
        // Non-auditable change → confirmation post WITHOUT 'touched' wording.
        const post = calls.find((c) => c.url.includes("chat.postMessage"));
        expect(post).toBeDefined();
        const text = (JSON.parse(post!.init.body as string) as { text: string }).text;
        expect(text).toContain("Edited");
    });

    it("invokes the audit when an auditable field (url) changes", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        const { calls } = installFetch(async () => jsonResp({ ok: true }));
        await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "existing" }),
                state: {
                    values: {
                        id: { value: { type: "plain_text_input", value: "acme" } },
                        url: { value: { type: "plain_text_input", value: "https://acme-new.example" } },
                    },
                },
            },
        });
        // The post-edit Slack message references the auditable field that changed.
        const post = calls.find((c) => c.url.includes("chat.postMessage"));
        expect(post).toBeDefined();
        const text = (JSON.parse(post!.init.body as string) as { text: string }).text;
        expect(text).toContain("Edit audit");
    });

    it("returns inline modal error when no patch fields are filled and delete is unchecked", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "existing" }),
                state: {
                    values: {
                        id: { value: { type: "plain_text_input", value: "acme" } },
                    },
                },
            },
        });
        expect((res.body as { response_action?: string }).response_action).toBe("errors");
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
});

// ---------- seed ----------

describe("view_submission · seed mode (2-step: input → confirm → apply)", () => {
    const seedJson = JSON.stringify([
        { ...ACME, id: "new-1" },
        { ...BETA, id: "new-2" },
    ]);

    it("requires the 'reviewed' checkbox before computing diff", async () => {
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "seed" }),
                state: {
                    values: {
                        seed_json: { value: { type: "plain_text_input", value: seedJson } },
                        reviewed: { value: { type: "checkboxes", selected_options: [] } },
                        replace: { value: { type: "checkboxes", selected_options: [] } },
                    },
                },
            },
        });
        const body = res.body as { errors?: Record<string, string> };
        expect(body.errors?.reviewed).toBeDefined();
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("phase 1: returns diff preview via response_action=update and does NOT mutate S3", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "seed" }),
                state: {
                    values: {
                        seed_json: { value: { type: "plain_text_input", value: seedJson } },
                        reviewed: { value: { type: "checkboxes", selected_options: [{ value: "ack" }] } },
                        replace: { value: { type: "checkboxes", selected_options: [{ value: "replace" }] } },
                    },
                },
            },
        });
        const body = res.body as {
            response_action?: string;
            view?: { private_metadata: string; blocks: Array<{ block_id?: string; text?: { text: string } }> };
        };
        expect(body.response_action).toBe("update");
        expect(body.view).toBeDefined();
        // Phase-2 marker present in the new view's private_metadata.
        const meta = JSON.parse(body.view!.private_metadata) as Record<string, unknown>;
        expect(meta.mode).toBe("seed");
        expect(meta.phase).toBe("confirm");
        expect(meta.replace).toBe(true);
        expect(typeof meta.seedJson).toBe("string");
        // Diff summary should report 2 added + 0 updated + 1 removed for replace mode
        // (current=[ACME], seed=[new-1,new-2] → ACME removed, both seed entries added).
        const summaryBlock = body.view!.blocks.find((b) => b.block_id === "diff_summary");
        expect(summaryBlock?.text?.text).toContain("Added: *2*");
        expect(summaryBlock?.text?.text).toContain("Updated: *0*");
        expect(summaryBlock?.text?.text).toContain("Removed: *1*");
        // Critically: zero S3 writes in phase 1.
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("phase 1: closes modal (response_action=clear) when diff is empty", async () => {
        // Empty seed against empty canonical → no added/updated/removed.
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([]) });
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "seed" }),
                state: {
                    values: {
                        seed_json: { value: { type: "plain_text_input", value: "[]" } },
                        reviewed: { value: { type: "checkboxes", selected_options: [{ value: "ack" }] } },
                        replace: { value: { type: "checkboxes", selected_options: [] } },
                    },
                },
            },
        });
        const body = res.body as { response_action?: string };
        expect(body.response_action).toBe("clear");
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("phase 2 (replace): re-validates seed from private_metadata and applies via withEtagRetry", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        installFetch(async () => jsonResp({ ok: true }));
        await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V2",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({
                    mode: "seed",
                    phase: "confirm",
                    seedJson,
                    replace: true,
                }),
                state: { values: {} },
            },
        });
        const puts = s3Mock.commandCalls(PutObjectCommand);
        expect(puts).toHaveLength(1);
        const written = JSON.parse(puts[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id).sort()).toEqual(["new-1", "new-2"]);
    });

    it("phase 2 (merge): applies merge-by-id when replace=false", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME, BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        installFetch(async () => jsonResp({ ok: true }));
        await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V2",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({
                    mode: "seed",
                    phase: "confirm",
                    seedJson,
                    replace: false,
                }),
                state: { values: {} },
            },
        });
        const written = JSON.parse(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id).sort()).toEqual(["acme", "beta", "new-1", "new-2"]);
    });

    it("returns inline schema error for malformed seed JSON in phase 1", async () => {
        installFetch(async () => jsonResp({ ok: true }));
        const res = await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "seed" }),
                state: {
                    values: {
                        seed_json: { value: { type: "plain_text_input", value: "[{not json" } },
                        reviewed: { value: { type: "checkboxes", selected_options: [{ value: "ack" }] } },
                        replace: { value: { type: "checkboxes", selected_options: [] } },
                    },
                },
            },
        });
        const body = res.body as { errors?: Record<string, string> };
        expect(body.errors?.seed_json).toBeDefined();
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
});

// ---------- block_actions: mode select ----------

describe("block_actions · mode select", () => {
    it("opens the pending modal via views.update on mode=pending", async () => {
        const { calls } = installFetch(async (url) => {
            if (url.includes("conversations.history")) return jsonResp({ ok: true, messages: [] });
            return jsonResp({ ok: true });
        });
        const res = await postSignedPayload({
            type: "block_actions",
            user: { id: "U1" },
            view: { id: "V1", callback_id: "explorer_admin_v1" },
            actions: [{ action_id: "mode_select", type: "static_select", selected_option: { value: "pending" } }],
        });
        expect(res.statusCode).toBe(200);
        const update = calls.find((c) => c.url.includes("views.update"));
        expect(update).toBeDefined();
        const body = JSON.parse(update!.init.body as string) as { view: { private_metadata: string } };
        expect(JSON.parse(body.view.private_metadata).mode).toBe("pending");
    });
});
