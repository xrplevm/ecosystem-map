/**
 * @jest-environment node
 *
 * Unit tests for the Airtable client. `globalThis.fetch` is the only I/O
 * seam — we stub it and assert the exact requests (endpoints, bodies) plus
 * the record→candidate mapping.
 */
import {
    AirtableError,
    createSubmissionRecord,
    deleteRecord,
    downloadAttachment,
    ICON_FIELD_ID,
    listPendingSubmissions,
    setStatus,
    STATUS,
    uploadIcon,
} from "../airtable";
import { __resetEnvCacheForTests } from "../env";

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

function jsonResp(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "x".repeat(32);
    process.env.SLACK_APPROVAL_CHANNEL = "C123";
    process.env.AIRTABLE_API_KEY = "patTEST";
    process.env.AIRTABLE_BASE_ID = "appTEST";
    process.env.AIRTABLE_TABLE_ID = "tblTEST";
    __resetEnvCacheForTests();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe("createSubmissionRecord", () => {
    it("POSTs the mapped fields with Status=Pending and returns the record id", async () => {
        const { calls } = installFetch(async () => jsonResp({ id: "recABC" }));
        const id = await createSubmissionRecord({
            name: "Acme Wallet",
            url: "https://acme.example",
            shortDescription: "tagline",
            section: "wallets",
            categories: ["Wallet", "DeFi"],
            longDescription: "the long story",
            author: "Acme Inc",
            site: "https://acme.example/about",
            github: "https://github.com/acme/wallet",
            submitterEmail: "sub@acme.example",
            submitterName: "Sam",
        });
        expect(id).toBe("recABC");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.airtable.com/v0/appTEST/tblTEST");
        expect(calls[0].init.method).toBe("POST");
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.typecast).toBe(true);
        expect(body.fields).toMatchObject({
            Name: "Acme Wallet",
            Website: "https://acme.example",
            Description: "tagline",
            Section: "wallets",
            "Contact email": "sub@acme.example",
            Status: "Pending",
            "Long description": "the long story",
            Categories: ["Wallet", "DeFi"],
            Author: "Acme Inc",
            Site: "https://acme.example/about",
            GitHub: "https://github.com/acme/wallet",
            "Submitter name": "Sam",
        });
    });

    it("omits optional fields that are undefined", async () => {
        const { calls } = installFetch(async () => jsonResp({ id: "rec1" }));
        await createSubmissionRecord({
            name: "Min",
            url: "https://min.example",
            shortDescription: "x",
            section: "dapps",
            submitterEmail: "a@b.com",
        });
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.fields).not.toHaveProperty("Categories");
        expect(body.fields).not.toHaveProperty("Author");
        expect(body.fields).not.toHaveProperty("Long description");
    });

    it("throws AirtableError on a non-2xx response", async () => {
        installFetch(async () => jsonResp({ error: { type: "INVALID", message: "bad" } }, 422));
        await expect(
            createSubmissionRecord({
                name: "X",
                url: "https://x.example",
                shortDescription: "x",
                section: "dapps",
                submitterEmail: "a@b.com",
            }),
        ).rejects.toBeInstanceOf(AirtableError);
    });
});

describe("uploadIcon", () => {
    it("POSTs base64 bytes to the content endpoint addressed by field id", async () => {
        const { calls } = installFetch(async () => jsonResp({ id: "recABC" }));
        await uploadIcon("recABC", Buffer.from("PNGDATA"), "image/png", "logo.png");
        expect(calls[0].url).toBe(
            `https://content.airtable.com/v0/appTEST/recABC/${ICON_FIELD_ID}/uploadAttachment`,
        );
        const body = JSON.parse(calls[0].init.body as string);
        expect(body).toEqual({
            contentType: "image/png",
            file: Buffer.from("PNGDATA").toString("base64"),
            filename: "logo.png",
        });
    });
});

describe("listPendingSubmissions", () => {
    it("filters by Status=Pending and maps rows to registry candidates", async () => {
        const { calls } = installFetch(async () =>
            jsonResp({
                records: [
                    {
                        id: "rec1",
                        fields: {
                            Name: "Acme Wallet",
                            Website: "https://acme.example",
                            Description: "tagline",
                            Section: "wallets",
                            Categories: ["Wallet", "DeFi"],
                            "Long description": "long",
                            Site: "https://acme.example/about",
                            Assignee: [{ url: "https://v5.airtableusercontent.com/abc" }],
                        },
                    },
                    {
                        id: "rec2",
                        // Missing Section — incomplete draft, must be skipped.
                        fields: { Name: "Broken", Website: "https://b.example", Description: "x" },
                    },
                ],
            }),
        );
        const result = await listPendingSubmissions();
        expect(decodeURIComponent(calls[0].url)).toContain("{Status}='Pending'");
        expect(result).toHaveLength(1);
        const { recordId, candidate, logoUrl } = result[0];
        expect(recordId).toBe("rec1");
        expect(candidate.id).toBe("acme-wallet");
        expect(candidate.title).toBe("Acme Wallet");
        expect(candidate.url).toBe("https://acme.example");
        expect(candidate.shortDescription).toBe("tagline");
        // surfaces are NOT baked in — the reviewer picks them at approval.
        expect((candidate as { surfaces?: unknown }).surfaces).toBeUndefined();
        expect(candidate.ecosystemSection).toBe("wallets");
        expect(candidate.categories).toEqual(["wallet", "defi"]);
        expect(candidate.description).toBe("long");
        expect(candidate.site).toBe("https://acme.example/about");
        expect(logoUrl).toBe("https://v5.airtableusercontent.com/abc");
    });

    it("falls back to [section] when no categories are set", async () => {
        installFetch(async () =>
            jsonResp({
                records: [
                    {
                        id: "rec1",
                        fields: {
                            Name: "No Cats",
                            Website: "https://nc.example",
                            Description: "x",
                            Section: "validators",
                        },
                    },
                ],
            }),
        );
        const [row] = await listPendingSubmissions();
        expect(row.candidate.categories).toEqual(["validators"]);
        expect(row.logoUrl).toBeUndefined();
    });
});

describe("setStatus", () => {
    it("PATCHes the status and optional registry id / logo URL", async () => {
        const { calls } = installFetch(async () => jsonResp({ id: "rec1" }));
        await setStatus("rec1", STATUS.approved, {
            registryId: "acme-wallet",
            logoUrl: "https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-dapp-acme-wallet.png",
        });
        expect(calls[0].url).toBe("https://api.airtable.com/v0/appTEST/tblTEST/rec1");
        expect(calls[0].init.method).toBe("PATCH");
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.fields).toEqual({
            Status: "Approved",
            "Registry id": "acme-wallet",
            "Logo URL": "https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-dapp-acme-wallet.png",
        });
    });

    it("rejects with only a Status field", async () => {
        const { calls } = installFetch(async () => jsonResp({ id: "rec1" }));
        await setStatus("rec1", STATUS.rejected);
        const body = JSON.parse(calls[0].init.body as string);
        expect(body.fields).toEqual({ Status: "Rejected" });
    });
});

describe("downloadAttachment / deleteRecord", () => {
    it("downloadAttachment returns the bytes", async () => {
        const bytes = new TextEncoder().encode("hello").buffer;
        installFetch(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => bytes,
        }) as unknown as Response);
        const buf = await downloadAttachment("https://v5.airtableusercontent.com/x");
        expect(buf.toString("utf8")).toBe("hello");
    });

    it("downloadAttachment throws on non-ok", async () => {
        installFetch(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response);
        await expect(downloadAttachment("https://x")).rejects.toBeInstanceOf(AirtableError);
    });

    it("deleteRecord issues a DELETE", async () => {
        const { calls } = installFetch(async () => jsonResp({ deleted: true, id: "rec1" }));
        await deleteRecord("rec1");
        expect(calls[0].url).toBe("https://api.airtable.com/v0/appTEST/tblTEST/rec1");
        expect(calls[0].init.method).toBe("DELETE");
    });
});
