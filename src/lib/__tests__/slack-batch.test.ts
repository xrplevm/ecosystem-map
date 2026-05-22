/**
 * @jest-environment node
 */
import {
    APPROVED_REACTION,
    buildExistingModalView,
    buildModeSelectorView,
    buildPendingModalView,
    buildSeedDiffView,
    buildSeedModalView,
    CALLBACK_ID,
    computeSeedDiff,
    markSubmissionApproved,
    PENDING_EVENT_TYPE,
    postBatchSummary,
    PRIVATE_METADATA_LIMIT,
    readPendingSubmissions,
    REJECTED_REACTION,
    SlackBatchError,
    type PendingSubmission,
} from "../slack-batch";
import type { ExplorerApp } from "../explorer-apps-types";

type FetchSpy = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const TOKEN = "xoxb-test";
const CHANNEL = "C123";

function jsonResponse(body: unknown, status = 200): Response {
    // Avoid `new Response(...)` because the CRA5 / jest-jsdom env does not
    // expose a global Response constructor; we shim the slim shape our
    // production code consumes (`ok`, `status`, `json()`).
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchSpy {
    const spy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        return impl(typeof input === "string" ? input : String(input), init);
    }) as unknown as FetchSpy;
    (globalThis as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
    return spy;
}

describe("readPendingSubmissions", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const sample: ExplorerApp = {
        id: "acme",
        external: true,
        title: "Acme",
        logo: "https://example.com/acme.png",
        shortDescription: "x",
        categories: ["defi"],
        author: "Acme",
        url: "https://acme.example",
    };

    it("returns only messages tagged with the pending metadata and unresolved reactions", async () => {
        const spy = installFetch(async () =>
            jsonResponse({
                ok: true,
                messages: [
                    {
                        ts: "1.0",
                        metadata: { event_type: PENDING_EVENT_TYPE, event_payload: sample },
                        reactions: [],
                    },
                    {
                        ts: "2.0",
                        metadata: { event_type: PENDING_EVENT_TYPE, event_payload: { ...sample, id: "approved" } },
                        reactions: [{ name: APPROVED_REACTION }],
                    },
                    {
                        ts: "3.0",
                        metadata: { event_type: PENDING_EVENT_TYPE, event_payload: { ...sample, id: "rejected" } },
                        reactions: [{ name: REJECTED_REACTION }],
                    },
                    {
                        ts: "4.0",
                        // no metadata — chat-only message in the channel
                        reactions: [],
                    },
                ],
            }),
        );

        const result = await readPendingSubmissions({ token: TOKEN, channel: CHANNEL });

        expect(result).toHaveLength(1);
        expect(result[0].ts).toBe("1.0");
        expect(result[0].payload.id).toBe("acme");
        expect(spy).toHaveBeenCalledTimes(1);
        const url = spy.mock.calls[0][0] as string;
        expect(url).toContain("conversations.history");
        expect(url).toContain("include_all_metadata=true");
        expect(url).toContain(`channel=${CHANNEL}`);
    });

    it("propagates Slack API errors as SlackBatchError", async () => {
        installFetch(async () => jsonResponse({ ok: false, error: "channel_not_found" }));
        await expect(readPendingSubmissions({ token: TOKEN, channel: CHANNEL })).rejects.toBeInstanceOf(SlackBatchError);
    });

    it("rejects HTTP failures", async () => {
        installFetch(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as unknown as Response);
        await expect(readPendingSubmissions({ token: TOKEN, channel: CHANNEL })).rejects.toBeInstanceOf(SlackBatchError);
    });
});

describe("markSubmissionApproved", () => {
    afterEach(() => jest.restoreAllMocks());
    it("posts to reactions.add with the approved reaction name", async () => {
        const spy = installFetch(async () => jsonResponse({ ok: true }));
        await markSubmissionApproved({ token: TOKEN, channel: CHANNEL, ts: "12.34" });
        expect(spy).toHaveBeenCalledTimes(1);
        const init = spy.mock.calls[0][1]!;
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ channel: CHANNEL, timestamp: "12.34", name: APPROVED_REACTION });
    });
});

describe("postBatchSummary", () => {
    afterEach(() => jest.restoreAllMocks());
    it("renders approved/skipped/error counts and reasons", async () => {
        const spy = installFetch(async () => jsonResponse({ ok: true }));
        await postBatchSummary({
            token: TOKEN,
            channel: CHANNEL,
            summary: {
                approved: 2,
                skipped: [{ id: "x", reason: "validation: bad url" }],
                errors: [{ ts: "4.5", reason: "ETag conflict" }],
            },
        });
        const init = spy.mock.calls[0][1]!;
        const body = JSON.parse(init.body as string);
        expect(body.text).toContain("Approved: 2");
        expect(body.text).toContain("Skipped: 1");
        expect(body.text).toContain("Errors: 1");
        expect(body.text).toContain("validation: bad url");
        expect(body.text).toContain("ETag conflict");
    });
});

describe("view builders", () => {
    it("buildModeSelectorView shows the 3 modes and has no submit button", () => {
        const view = buildModeSelectorView();
        expect(view.callback_id).toBe(CALLBACK_ID);
        expect(view.submit).toBeUndefined();
        const select = view.blocks.find((b) => b.block_id === "mode_block");
        expect(select).toBeDefined();
    });

    it("buildPendingModalView with submissions encodes a checkbox per entry and stamps tsList", () => {
        const submissions: PendingSubmission[] = [
            {
                ts: "10.0",
                payload: {
                    id: "a", external: true, title: "A", logo: "https://x", shortDescription: "y",
                    categories: ["defi"], author: "x", url: "https://x",
                },
                reactions: [],
            },
        ];
        const view = buildPendingModalView(submissions);
        expect(view.submit?.text).toBe("Approve selected");
        expect(view.private_metadata).toBeDefined();
        const meta = JSON.parse(view.private_metadata!) as { mode: string; tsList: string[] };
        expect(meta.mode).toBe("pending");
        expect(meta.tsList).toEqual(["10.0"]);
    });

    it("buildPendingModalView with no submissions still produces a closable modal", () => {
        const view = buildPendingModalView([]);
        expect(view.submit).toBeUndefined();
    });

    it("buildExistingModalView includes id input and delete checkbox", () => {
        const view = buildExistingModalView();
        const ids = view.blocks.map((b) => b.block_id);
        expect(ids).toContain("id");
        expect(ids).toContain("delete_confirm");
        expect(ids).toContain("title");
    });

    it("buildSeedModalView includes seed_json textarea and reviewed checkbox", () => {
        const view = buildSeedModalView();
        const ids = view.blocks.map((b) => b.block_id);
        expect(ids).toContain("seed_json");
        expect(ids).toContain("reviewed");
        expect(ids).toContain("replace");
    });
});

describe("computeSeedDiff", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };

    it("classifies added/updated for merge mode and never reports removed", () => {
        const diff = computeSeedDiff([a, b], [b, c], "merge");
        expect(diff.added).toEqual(["c"]);
        expect(diff.updated).toEqual(["b"]);
        expect(diff.removed).toEqual([]);
    });

    it("includes removed entries in replace mode", () => {
        const diff = computeSeedDiff([a, b], [b, c], "replace");
        expect(diff.added).toEqual(["c"]);
        expect(diff.updated).toEqual(["b"]);
        expect(diff.removed).toEqual(["a"]);
    });
});

describe("buildSeedDiffView", () => {
    const seedJson = JSON.stringify([{ id: "x" }, { id: "y" }]);

    it("renders summary + per-bucket lists and stamps phase=confirm in private_metadata", () => {
        const view = buildSeedDiffView({
            diff: { added: ["x"], updated: ["y"], removed: ["z"] },
            seedJson,
            mode: "replace",
        });
        expect(view).not.toBeNull();
        expect(view!.callback_id).toBe(CALLBACK_ID);
        expect(view!.submit?.text).toBe("Apply");
        const meta = JSON.parse(view!.private_metadata as string) as Record<string, unknown>;
        expect(meta).toMatchObject({ mode: "seed", phase: "confirm", replace: true, seedJson });
        // Summary block carries the counts.
        const summary = view!.blocks.find((b) => b.block_id === "diff_summary");
        const summaryText = (summary?.text as { text: string } | undefined)?.text ?? "";
        expect(summaryText).toContain("Added: *1*");
        expect(summaryText).toContain("Updated: *1*");
        expect(summaryText).toContain("Removed: *1*");
        // Per-bucket id chips present.
        const added = view!.blocks.find((b) => b.block_id === "diff_added");
        expect((added?.text as { text: string } | undefined)?.text).toContain("`x`");
        const removed = view!.blocks.find((b) => b.block_id === "diff_removed");
        expect((removed?.text as { text: string } | undefined)?.text).toContain("`z`");
    });

    it("omits the removed block in merge mode (merge never deletes)", () => {
        const view = buildSeedDiffView({
            diff: { added: ["x"], updated: [], removed: [] },
            seedJson,
            mode: "merge",
        });
        expect(view!.blocks.find((b) => b.block_id === "diff_removed")).toBeUndefined();
        const meta = JSON.parse(view!.private_metadata as string) as { replace: boolean };
        expect(meta.replace).toBe(false);
    });

    it("renders an empty-state marker for a zero-change diff", () => {
        const view = buildSeedDiffView({
            diff: { added: [], updated: [], removed: [] },
            seedJson,
            mode: "replace",
        });
        expect(view).not.toBeNull();
        const summary = view!.blocks.find((b) => b.block_id === "diff_summary");
        const summaryText = (summary?.text as { text: string } | undefined)?.text ?? "";
        expect(summaryText).toContain("Total changes: *0*");
        const added = view!.blocks.find((b) => b.block_id === "diff_added");
        expect((added?.text as { text: string } | undefined)?.text).toContain("_(none)_");
    });

    it("returns null when the seed payload would overflow private_metadata", () => {
        // Fabricate a seed that blows past the 2800-char budget.
        const huge = "x".repeat(3500);
        const view = buildSeedDiffView({
            diff: { added: ["a"], updated: [], removed: [] },
            seedJson: huge,
            mode: "merge",
        });
        expect(view).toBeNull();
        // Sanity — exposes the configured ceiling so the contract is testable.
        expect(PRIVATE_METADATA_LIMIT).toBe(3000);
    });
});
