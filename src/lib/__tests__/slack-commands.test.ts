/**
 * @jest-environment node
 *
 * Tests for the `/explorer-admin` slash-command entry. We exercise the
 * full handler — env load, HMAC verify, command parse, views.open — by
 * driving the Vercel handler with a fake request/response pair and a
 * stubbed `globalThis.fetch`.
 */
import { createHmac } from "crypto";

import handler from "../../../api/slack/commands";
import { __resetEnvCacheForTests } from "../env";

const SIGNING_SECRET = "x".repeat(32);
const BOT_TOKEN = "xoxb-test";

function sign(rawBody: string, timestamp: string): string {
    const base = `v0:${timestamp}:${rawBody}`;
    return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

interface FakeReq {
    method: string;
    headers: Record<string, string>;
    on: (event: string, cb: (chunk: unknown) => void) => FakeReq;
}

function makeReq(rawBody: string, headers: Record<string, string>): FakeReq {
    const listeners: Record<string, (chunk: unknown) => void> = {};
    const req: FakeReq = {
        method: "POST",
        headers,
        on(event: string, cb: (chunk: unknown) => void) {
            listeners[event] = cb;
            // Drive the read on the next microtask so the handler has
            // already attached `data`/`end` listeners before we fire them.
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
        setHeader(k: string, v: string) { this.headers[k] = v; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
        end() { return this; },
    };
    return res;
}

beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APPROVAL_CHANNEL = "C123";
    __resetEnvCacheForTests();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("POST /api/slack/commands", () => {
    it("rejects non-POST requests with 405", async () => {
        const res = makeRes();
        const req = makeReq("", {}) as unknown as Parameters<typeof handler>[0];
        (req as unknown as { method: string }).method = "GET";
        await handler(req, res as unknown as Parameters<typeof handler>[1]);
        expect(res.statusCode).toBe(405);
    });

    it("rejects requests with a bad signature as 401 without leaking specifics", async () => {
        const fetchSpy = jest.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
        const rawBody = "command=%2Fexplorer-admin&trigger_id=t&user_id=u&channel_id=C";
        const ts = String(Math.floor(Date.now() / 1000));
        const req = makeReq(rawBody, {
            "x-slack-request-timestamp": ts,
            "x-slack-signature": "v0=deadbeef",
        }) as unknown as Parameters<typeof handler>[0];
        const res = makeRes();
        await handler(req, res as unknown as Parameters<typeof handler>[1]);
        expect(res.statusCode).toBe(401);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("opens the modal via views.open on a valid /explorer-admin request", async () => {
        const fetchSpy = jest.fn(async () => jsonResponse({ ok: true }));
        (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
        const rawBody = "command=%2Fexplorer-admin&trigger_id=trigger123&user_id=U1&channel_id=C1";
        const ts = String(Math.floor(Date.now() / 1000));
        const req = makeReq(rawBody, {
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sign(rawBody, ts),
        }) as unknown as Parameters<typeof handler>[0];
        const res = makeRes();
        await handler(req, res as unknown as Parameters<typeof handler>[1]);
        expect(res.statusCode).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain("views.open");
        const body = JSON.parse(init.body as string);
        expect(body.trigger_id).toBe("trigger123");
        expect(body.view.callback_id).toBe("explorer_admin_v1");
    });

    it("returns ephemeral notice for an unknown command", async () => {
        const fetchSpy = jest.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
        const rawBody = "command=%2Funknown&trigger_id=t&user_id=u&channel_id=C";
        const ts = String(Math.floor(Date.now() / 1000));
        const req = makeReq(rawBody, {
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sign(rawBody, ts),
        }) as unknown as Parameters<typeof handler>[0];
        const res = makeRes();
        await handler(req, res as unknown as Parameters<typeof handler>[1]);
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ response_type: "ephemeral" });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
