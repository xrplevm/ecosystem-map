/**
 * @jest-environment node
 *
 * End-to-end tests for the `/api/slack/actions` dispatcher. We drive the
 * exported handler with signed bodies and stub:
 *   - `globalThis.fetch` for Slack API calls (views / chat.postMessage /
 *     files.* upload flow).
 *   - The S3 client (`aws-sdk-client-mock`) for `getObject` / `putObject`,
 *     so `withEtagRetry` and `putLogo` exercise the real client.
 *   - The Airtable module (pending queue + status writes) and `logo-image`
 *     (`normalizeLogo`, which loads `sharp` — unavailable under jest).
 */
/* eslint-disable import/first */

// Mock the logo normaliser so `sharp` never loads under jest.
jest.mock("../logo-image", () => ({
    __esModule: true,
    normalizeLogo: jest.fn(async (b: Buffer) => b),
    LOGO_CONTENT_TYPE: "image/png",
    LOGO_SIZE: 250,
    LOGO_CORNER_RADIUS: 30,
}));

// Mock Airtable so the pending queue + status writes are controllable.
jest.mock("../airtable", () => ({
    __esModule: true,
    STATUS: { pending: "Pending", approved: "Approved", rejected: "Rejected" },
    listPendingSubmissions: jest.fn(async () => []),
    setStatus: jest.fn(async () => undefined),
    downloadAttachment: jest.fn(async () => Buffer.from("RAWLOGO")),
}));

import { createHmac } from "crypto";

import { GetObjectCommand, GetObjectCommandOutput, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import handler from "../../../api/slack/actions";
import * as airtable from "../airtable";
import type { ExplorerAppCandidate, PendingSubmission } from "../airtable";
import { __resetEnvCacheForTests } from "../env";
import { normalizeLogo } from "../logo-image";
import { __resetS3StateForTests } from "../s3-client";
import type { ExplorerApp } from "../explorer-apps-types";

// CRA's jest runs with `resetMocks: true`, so factory implementations are
// wiped before each test — every mock impl is (re)established in beforeEach.
const listPendingMock = airtable.listPendingSubmissions as jest.Mock;
const setStatusMock = airtable.setStatus as jest.Mock;
const downloadMock = airtable.downloadAttachment as jest.Mock;
const normalizeMock = normalizeLogo as jest.Mock;

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

/** Default Slack stub: everything ok; chat.postMessage returns a ts. */
function installSlackOk(): { calls: FetchCall[] } {
    const { calls } = installFetch(async (url) => {
        if (url.includes("chat.postMessage")) return jsonResp({ ok: true, ts: "777.1" });
        if (url.includes("files.getUploadURLExternal")) {
            return jsonResp({ ok: true, upload_url: "https://files.slack.test/up", file_id: "F1" });
        }
        return jsonResp({ ok: true });
    });
    return { calls };
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

const ACME_CANDIDATE: ExplorerAppCandidate = {
    id: "acme", external: true, title: "Acme", shortDescription: "x",
    categories: ["bridge"], author: "Acme", url: "https://acme.example",
    ecosystemSection: "dapps",
};
function pending(recordId: string, candidate: ExplorerAppCandidate, logoUrl = "https://v5.airtableusercontent.com/x"): PendingSubmission {
    return { recordId, candidate, logoUrl };
}

const BETA: ExplorerApp = {
    id: "beta", external: true, title: "Beta", logo: "https://x.example/b.png",
    shortDescription: "y", categories: ["defi"], author: "Beta", url: "https://beta.example",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    s3Mock.reset();
    __resetEnvCacheForTests();
    __resetS3StateForTests();
    listPendingMock.mockResolvedValue([]);
    setStatusMock.mockResolvedValue(undefined);
    downloadMock.mockResolvedValue(Buffer.from("RAWLOGO"));
    normalizeMock.mockImplementation(async (b: Buffer) => b);
    process.env = { ...ORIGINAL_ENV };
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    process.env.SLACK_APPROVAL_CHANNEL = "C123";
    process.env.AIRTABLE_API_KEY = "patTEST";
    process.env.AIRTABLE_BASE_ID = "appTEST";
    process.env.AIRTABLE_TABLE_ID = "tblTEST";
    process.env.AWS_REGION = "eu-west-1";
    process.env.S3_BUCKET = "peersyst-development";
    process.env.S3_JSON_KEY = "explorer-apps.json";
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
});

afterAll(() => { process.env = ORIGINAL_ENV; });
afterEach(() => { jest.restoreAllMocks(); });

// ---------- pending: approve / reject ----------

describe("view_submission · pending mode (per-surface approve / reject)", () => {
    function group(ids?: string[]): { selected: { type: string; selected_options: Array<{ value: string }> } } {
        return { selected: { type: "checkboxes", selected_options: (ids ?? []).map((v) => ({ value: v })) } };
    }
    function pendingPayload(opts: { explorer?: string[]; map?: string[]; both?: string[]; reject?: string[] }): Record<string, unknown> {
        const all = [...(opts.explorer ?? []), ...(opts.map ?? []), ...(opts.both ?? []), ...(opts.reject ?? [])];
        return {
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V1",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "pending", recordList: all }),
                state: {
                    values: {
                        pending_approve_explorer: group(opts.explorer),
                        pending_approve_map: group(opts.map),
                        pending_approve_both: group(opts.both),
                        pending_reject: group(opts.reject),
                    },
                },
            },
        };
    }

    function writtenEntries(): ExplorerApp[] {
        const jsonPut = s3Mock.commandCalls(PutObjectCommand).find((p) => p.args[0].input.Key === "explorer-apps.json")!;
        return JSON.parse(jsonPut.args[0].input.Body as string) as ExplorerApp[];
    }

    it("approves to the Ecosystem map: surfaces=[ecosystem-map] with ecosystemSection, posts summary + artifacts", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        listPendingMock.mockResolvedValue([pending("rec1", ACME_CANDIDATE)]);
        const { calls } = installSlackOk();

        const res = await postSignedPayload(pendingPayload({ map: ["rec1"] }));

        expect(res.statusCode).toBe(200);
        const keys = s3Mock.commandCalls(PutObjectCommand).map((p) => p.args[0].input.Key);
        expect(keys).toContain("explorer-dapp-acme.png");
        const acme = writtenEntries().find((e) => e.id === "acme")!;
        expect(acme.surfaces).toEqual(["ecosystem-map"]);
        expect(acme.ecosystemSection).toBe("dapps");
        expect(setStatusMock).toHaveBeenCalledWith("rec1", "Approved", expect.objectContaining({ registryId: "acme" }));
        const summary = calls.find((c) => c.url.includes("chat.postMessage"))!;
        expect((JSON.parse(summary.init.body as string) as { text: string }).text).toContain("Ecosystem map: 1");
        expect(calls.some((c) => c.url.includes("files.completeUploadExternal"))).toBe(true);
    });

    it("approves to Explorer dApps: surfaces=[explorer-apps] and drops ecosystemSection", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        listPendingMock.mockResolvedValue([pending("rec1", ACME_CANDIDATE)]);
        installSlackOk();

        await postSignedPayload(pendingPayload({ explorer: ["rec1"] }));

        const acme = writtenEntries().find((e) => e.id === "acme")!;
        expect(acme.surfaces).toEqual(["explorer-apps"]);
        expect(acme.ecosystemSection).toBeUndefined();
    });

    it("approves to Both: surfaces include explorer-apps and ecosystem-map", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        listPendingMock.mockResolvedValue([pending("rec1", ACME_CANDIDATE)]);
        installSlackOk();

        await postSignedPayload(pendingPayload({ both: ["rec1"] }));

        const acme = writtenEntries().find((e) => e.id === "acme")!;
        expect(acme.surfaces!.slice().sort()).toEqual(["ecosystem-map", "explorer-apps"]);
        expect(acme.ecosystemSection).toBe("dapps");
    });

    it("rejects: marks Rejected and never writes to S3", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        listPendingMock.mockResolvedValue([pending("rec1", ACME_CANDIDATE)]);
        installSlackOk();

        const res = await postSignedPayload(pendingPayload({ reject: ["rec1"] }));

        expect(res.statusCode).toBe(200);
        expect(setStatusMock).toHaveBeenCalledWith("rec1", "Rejected");
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("refuses a row checked in two groups (inline error, no writes)", async () => {
        listPendingMock.mockResolvedValue([pending("rec1", ACME_CANDIDATE)]);
        installSlackOk();
        const res = await postSignedPayload(pendingPayload({ explorer: ["rec1"], map: ["rec1"] }));
        const body = res.body as { response_action: string; errors: Record<string, string> };
        expect(body.response_action).toBe("errors");
        expect(body.errors.pending_reject).toBeDefined();
        expect(setStatusMock).not.toHaveBeenCalled();
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("returns an inline error when nothing is selected", async () => {
        const res = await postSignedPayload(pendingPayload({}));
        expect((res.body as { response_action?: string }).response_action).toBe("errors");
    });

    it("skips a row that is no longer pending (no S3 write)", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        listPendingMock.mockResolvedValue([]); // rec9 is gone
        installSlackOk();
        const res = await postSignedPayload(pendingPayload({ map: ["rec9"] }));
        expect(res.statusCode).toBe(200);
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
        expect(setStatusMock).not.toHaveBeenCalled();
    });
});

// ---------- existing (edit/delete) ----------

const ACME_FULL: ExplorerApp = { ...ACME_CANDIDATE, logo: "https://x.example/a.png" };

describe("view_submission · existing mode (edit / delete)", () => {
    it("filters the entry on delete and writes the shrunken array", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME_FULL, BETA]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        installSlackOk();

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
        const written = JSON.parse(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id)).toEqual(["beta"]);
    });

    it("patches a field and posts a plain 'Edited' confirmation (no audit)", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME_FULL]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        const { calls } = installSlackOk();
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
        const post = calls.find((c) => c.url.includes("chat.postMessage"))!;
        const text = (JSON.parse(post.init.body as string) as { text: string }).text;
        expect(text).toContain("Edited");
        expect(text).not.toContain("audit");
    });
});

// ---------- seed (unchanged flow) ----------

describe("view_submission · seed mode", () => {
    const seedJson = JSON.stringify([{ ...ACME_FULL, id: "new-1" }]);

    it("phase 2 (replace) applies via withEtagRetry", async () => {
        s3Mock.on(GetObjectCommand).resolves({ ETag: '"e1"', Body: bodyFrom([ACME_FULL]) });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });
        installSlackOk();
        await postSignedPayload({
            type: "view_submission",
            user: { id: "U1" },
            view: {
                id: "V2",
                callback_id: "explorer_admin_v1",
                private_metadata: JSON.stringify({ mode: "seed", phase: "confirm", seedJson, replace: true }),
                state: { values: {} },
            },
        });
        const written = JSON.parse(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body as string) as ExplorerApp[];
        expect(written.map((e) => e.id)).toEqual(["new-1"]);
    });
});

// ---------- block_actions: mode select ----------

describe("block_actions · mode select", () => {
    it("opens the pending modal via views.update on mode=pending", async () => {
        listPendingMock.mockResolvedValue([]);
        const { calls } = installSlackOk();
        const res = await postSignedPayload({
            type: "block_actions",
            user: { id: "U1" },
            view: { id: "V1", callback_id: "explorer_admin_v1" },
            actions: [{ action_id: "mode_select", type: "static_select", selected_option: { value: "pending" } }],
        });
        expect(res.statusCode).toBe(200);
        const update = calls.find((c) => c.url.includes("views.update"))!;
        const body = JSON.parse(update.init.body as string) as { view: { private_metadata: string } };
        expect(JSON.parse(body.view.private_metadata).mode).toBe("pending");
    });
});
