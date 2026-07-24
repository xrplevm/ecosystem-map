/**
 * @jest-environment node
 */
import {
    buildExistingModalView,
    buildModeSelectorView,
    buildPendingModalView,
    buildSeedDiffView,
    buildSeedModalView,
    CALLBACK_ID,
    computeSeedDiff,
    postApprovalArtifacts,
    postBatchSummary,
    PRIVATE_METADATA_LIMIT,
    readPendingSubmissions,
    SlackBatchError,
    type PendingSubmission,
} from "../slack-batch";
import { __resetEnvCacheForTests } from "../env";

type FetchSpy = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const TOKEN = "xoxb-test";
const CHANNEL = "C123";

function jsonResponse(body: unknown, status = 200): Response {
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

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.SLACK_BOT_TOKEN = TOKEN;
    process.env.SLACK_SIGNING_SECRET = "x".repeat(32);
    process.env.SLACK_APPROVAL_CHANNEL = CHANNEL;
    process.env.AIRTABLE_API_KEY = "patTEST";
    process.env.AIRTABLE_BASE_ID = "appTEST";
    process.env.AIRTABLE_TABLE_ID = "tblTEST";
    __resetEnvCacheForTests();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe("readPendingSubmissions (Airtable-sourced)", () => {
    it("queries Airtable for Status=Pending and maps rows", async () => {
        const spy = installFetch(async () =>
            jsonResponse({
                records: [
                    {
                        id: "rec1",
                        fields: {
                            Name: "Acme",
                            Website: "https://acme.example",
                            Description: "x",
                            Section: "dapps",
                            Assignee: [{ url: "https://v5.airtableusercontent.com/a" }],
                        },
                    },
                ],
            }),
        );
        const result = await readPendingSubmissions();
        expect(result).toHaveLength(1);
        expect(result[0].recordId).toBe("rec1");
        expect(result[0].candidate.id).toBe("acme");
        const url = spy.mock.calls[0][0] as string;
        expect(url).toContain("api.airtable.com");
        expect(decodeURIComponent(url)).toContain("{Status}='Pending'");
    });
});

describe("postBatchSummary", () => {
    it("renders approved breakdown / rejected / skipped / error counts and returns the ts", async () => {
        const spy = installFetch(async () => jsonResponse({ ok: true, ts: "99.9" }));
        const ts = await postBatchSummary({
            token: TOKEN,
            channel: CHANNEL,
            summary: {
                approved: 3,
                approvedExplorer: 1,
                approvedMap: 1,
                approvedBoth: 1,
                rejected: 1,
                skipped: [{ id: "x", reason: "validation: bad url" }],
                errors: [{ recordId: "rec4", reason: "ETag conflict" }],
            },
        });
        expect(ts).toBe("99.9");
        const body = JSON.parse(spy.mock.calls[0][1]!.body as string);
        expect(body.text).toContain("Approved: 3 (Explorer dApps: 1 · Ecosystem map: 1 · Both: 1)");
        expect(body.text).toContain("Rejected: 1");
        expect(body.text).toContain("Skipped: 1");
        expect(body.text).toContain("Errors: 1");
        expect(body.text).toContain("validation: bad url");
        expect(body.text).toContain("ETag conflict");
    });
});

describe("postApprovalArtifacts", () => {
    it("uploads the JSON + each logo via the external-upload flow, threaded", async () => {
        const calls: string[] = [];
        installFetch(async (url) => {
            calls.push(url);
            if (url.includes("files.getUploadURLExternal")) {
                return jsonResponse({ ok: true, upload_url: "https://files.slack.test/up", file_id: `F${calls.length}` });
            }
            if (url.startsWith("https://files.slack.test/up")) {
                return jsonResponse({ ok: true });
            }
            return jsonResponse({ ok: true });
        });
        await postApprovalArtifacts({
            token: TOKEN,
            channel: CHANNEL,
            threadTs: "100.1",
            files: [
                { filename: "explorer-apps.json", bytes: Buffer.from("[]"), title: "explorer-apps.json" },
                { filename: "explorer-dapp-acme.png", bytes: Buffer.from("PNG"), title: "explorer-dapp-acme.png" },
            ],
        });
        expect(calls.filter((c) => c.includes("files.getUploadURLExternal"))).toHaveLength(2);
        expect(calls.filter((c) => c.startsWith("https://files.slack.test/up"))).toHaveLength(2);
        const complete = calls.find((c) => c.includes("files.completeUploadExternal"));
        expect(complete).toBeDefined();
    });

    it("is a no-op when there are no files (e.g. zero approvals)", async () => {
        const spy = installFetch(async () => jsonResponse({ ok: true }));
        await postApprovalArtifacts({ token: TOKEN, channel: CHANNEL, files: [] });
        expect(spy).not.toHaveBeenCalled();
    });

    it("throws SlackBatchError when the upload POST fails", async () => {
        installFetch(async (url) => {
            if (url.includes("files.getUploadURLExternal")) {
                return jsonResponse({ ok: true, upload_url: "https://files.slack.test/up", file_id: "F1" });
            }
            if (url.startsWith("https://files.slack.test/up")) {
                return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" } as unknown as Response;
            }
            return jsonResponse({ ok: true });
        });
        await expect(
            postApprovalArtifacts({
                token: TOKEN,
                channel: CHANNEL,
                files: [{ filename: "a.json", bytes: Buffer.from("x"), title: "a" }],
            }),
        ).rejects.toBeInstanceOf(SlackBatchError);
    });
});

describe("view builders", () => {
    it("buildModeSelectorView shows the modes and has no submit button", () => {
        const view = buildModeSelectorView();
        expect(view.callback_id).toBe(CALLBACK_ID);
        expect(view.submit).toBeUndefined();
        expect(view.blocks.find((b) => b.block_id === "mode_block")).toBeDefined();
    });

    it("buildPendingModalView encodes the 3 surface-approve groups + Reject", () => {
        const submissions: PendingSubmission[] = [
            {
                recordId: "rec10",
                candidate: {
                    id: "a", external: true, title: "A", shortDescription: "y",
                    categories: ["defi"], author: "x", url: "https://x",
                    ecosystemSection: "dapps",
                },
                logoUrl: "https://v5.airtableusercontent.com/a",
            },
        ];
        const view = buildPendingModalView(submissions);
        expect(view.submit?.text).toBe("Apply decisions");
        const meta = JSON.parse(view.private_metadata!) as { mode: string; recordList: string[] };
        expect(meta.mode).toBe("pending");
        expect(meta.recordList).toEqual(["rec10"]);
        const ids = view.blocks.map((b) => b.block_id);
        expect(ids).toContain("pending_approve_explorer");
        expect(ids).toContain("pending_approve_map");
        expect(ids).toContain("pending_approve_both");
        expect(ids).toContain("pending_reject");
    });

    it("buildPendingModalView with no submissions still produces a closable modal", () => {
        const view = buildPendingModalView([]);
        expect(view.submit).toBeUndefined();
    });

    it("buildExistingModalView includes id input and delete checkbox", () => {
        const ids = buildExistingModalView().blocks.map((b) => b.block_id);
        expect(ids).toContain("id");
        expect(ids).toContain("delete_confirm");
        expect(ids).toContain("title");
    });

    it("buildSeedModalView includes seed_json textarea and reviewed checkbox", () => {
        const ids = buildSeedModalView().blocks.map((b) => b.block_id);
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

    it("renders summary + per-bucket lists and stamps phase=confirm", () => {
        const view = buildSeedDiffView({
            diff: { added: ["x"], updated: ["y"], removed: ["z"] },
            seedJson,
            mode: "replace",
        });
        expect(view).not.toBeNull();
        expect(view!.submit?.text).toBe("Apply");
        const meta = JSON.parse(view!.private_metadata as string) as Record<string, unknown>;
        expect(meta).toMatchObject({ mode: "seed", phase: "confirm", replace: true, seedJson });
        const summary = view!.blocks.find((b) => b.block_id === "diff_summary");
        const summaryText = (summary?.text as { text: string } | undefined)?.text ?? "";
        expect(summaryText).toContain("Added: *1*");
        expect(summaryText).toContain("Removed: *1*");
    });

    it("omits the removed block in merge mode", () => {
        const view = buildSeedDiffView({
            diff: { added: ["x"], updated: [], removed: [] },
            seedJson,
            mode: "merge",
        });
        expect(view!.blocks.find((b) => b.block_id === "diff_removed")).toBeUndefined();
    });

    it("returns null when the seed payload would overflow private_metadata", () => {
        const view = buildSeedDiffView({
            diff: { added: ["a"], updated: [], removed: [] },
            seedJson: "x".repeat(3500),
            mode: "merge",
        });
        expect(view).toBeNull();
        expect(PRIVATE_METADATA_LIMIT).toBe(3000);
    });
});
