import { auditSubmission, AuditInput, formatAuditForSlack } from "../audit";

const baseInput: AuditInput = {
    title: "Acme DeFi",
    url: "https://acme.example",
    site: "https://acme.example",
    github: "https://github.com/acme/acme",
    shortDescription: "Decentralized lending on XRPL EVM.",
    description: "Long-form description of the protocol.",
    categories: ["DeFi", "Lending"],
    author: "Acme Labs",
};

type MockResponse = { content: Array<{ type: string; text?: string }> };

function makeClient(impl: (signal: AbortSignal | undefined) => Promise<MockResponse> | MockResponse) {
    const create = jest.fn(
        async (
            _params: unknown,
            options?: { signal?: AbortSignal },
        ): Promise<MockResponse> => impl(options?.signal),
    );
    // Cast through unknown — we only stub the surface auditSubmission touches.
    const client = { messages: { create } } as unknown as NonNullable<
        Parameters<typeof auditSubmission>[1]
    >["client"];
    return { client, create };
}

function jsonReply(payload: unknown): MockResponse {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("auditSubmission", () => {
    it("returns the model's ok verdict on a clean submission", async () => {
        const { client, create } = makeClient(() =>
            jsonReply({ verdict: "ok", reasons: ["coherent metadata"], confidence: 0.92 }),
        );

        const result = await auditSubmission(baseInput, { client });

        expect(create).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            verdict: "ok",
            reasons: ["coherent metadata"],
            confidence: 0.92,
        });
        expect(result.raw).toBeUndefined();
    });

    it("returns warn verdict and preserves raw output for review", async () => {
        const raw = JSON.stringify({
            verdict: "warn",
            reasons: ["site domain differs from url", "shortDescription is generic"],
            confidence: 0.55,
        });
        const { client } = makeClient(() => ({ content: [{ type: "text", text: raw }] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("warn");
        expect(result.reasons).toHaveLength(2);
        expect(result.confidence).toBeCloseTo(0.55);
        expect(result.raw).toBe(raw);
    });

    it("returns block verdict and preserves raw output", async () => {
        const raw = JSON.stringify({
            verdict: "block",
            reasons: ["typosquat of well-known protocol"],
            confidence: 0.97,
        });
        const { client } = makeClient(() => ({ content: [{ type: "text", text: raw }] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("block");
        expect(result.raw).toBe(raw);
    });

    it("strips ```json fences before parsing", async () => {
        const fenced = "```json\n" + JSON.stringify({ verdict: "ok", reasons: ["fine"], confidence: 1 }) + "\n```";
        const { client } = makeClient(() => ({ content: [{ type: "text", text: fenced }] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("ok");
    });

    it("falls back to warn with audit parse error on malformed JSON", async () => {
        const raw = "not json at all";
        const { client } = makeClient(() => ({ content: [{ type: "text", text: raw }] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result).toEqual({
            verdict: "warn",
            reasons: ["audit parse error"],
            confidence: 0,
            raw,
        });
    });

    it("falls back to warn when the model returns a JSON shape that fails the verdict schema", async () => {
        const raw = JSON.stringify({ verdict: "definitely-bad", reasons: [], confidence: 2 });
        const { client } = makeClient(() => ({ content: [{ type: "text", text: raw }] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("warn");
        expect(result.reasons).toEqual(["audit parse error"]);
        expect(result.raw).toBe(raw);
    });

    it("returns warn audit unavailable on abort/timeout", async () => {
        const { client } = makeClient((signal) => {
            return new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            });
        });

        jest.useFakeTimers();
        try {
            const promise = auditSubmission(baseInput, { client });
            jest.advanceTimersByTime(8_000);
            const result = await promise;
            expect(result.verdict).toBe("warn");
            expect(result.reasons[0]).toMatch(/audit unavailable: timeout/);
            expect(result.confidence).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("returns warn audit unavailable on network error", async () => {
        const { client } = makeClient(() => {
            throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
        });

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("warn");
        expect(result.reasons[0]).toMatch(/audit unavailable: network error/);
        expect(result.confidence).toBe(0);
    });

    it("returns warn audit unavailable when no API key is provided and no client injected", async () => {
        const previous = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const result = await auditSubmission(baseInput);
            expect(result.verdict).toBe("warn");
            expect(result.reasons).toEqual(["audit unavailable: ANTHROPIC_API_KEY missing"]);
        } finally {
            if (previous !== undefined) {
                process.env.ANTHROPIC_API_KEY = previous;
            }
        }
    });

    it("returns warn audit unavailable when the response has no text block", async () => {
        const { client } = makeClient(() => ({ content: [] }));

        const result = await auditSubmission(baseInput, { client });

        expect(result.verdict).toBe("warn");
        expect(result.reasons).toEqual(["audit unavailable: empty response"]);
    });
});

describe("formatAuditForSlack", () => {
    it("formats an ok verdict with green check and bullets", () => {
        const formatted = formatAuditForSlack({
            verdict: "ok",
            reasons: ["coherent metadata", "established author"],
            confidence: 0.9,
        });
        expect(formatted.emoji).toBe("✅");
        expect(formatted.line).toBe("✅ Audit: OK (confidence 90%)");
        expect(formatted.mrkdwn).toContain("• coherent metadata");
        expect(formatted.mrkdwn).toContain("• established author");
    });

    it("formats a warn verdict with warning sign", () => {
        const formatted = formatAuditForSlack({
            verdict: "warn",
            reasons: ["site domain differs from url"],
            confidence: 0.5,
        });
        expect(formatted.emoji).toBe("⚠️");
        expect(formatted.line).toBe("⚠️ Audit: WARN (confidence 50%)");
        expect(formatted.mrkdwn.startsWith("*⚠️ Audit: WARN")).toBe(true);
    });

    it("formats a block verdict with stop sign and shows placeholder when reasons empty", () => {
        const formatted = formatAuditForSlack({
            verdict: "block",
            reasons: [],
            confidence: 0.99,
        });
        expect(formatted.emoji).toBe("🛑");
        expect(formatted.line).toBe("🛑 Audit: BLOCK (confidence 99%)");
        expect(formatted.mrkdwn).toContain("_(no reasons reported)_");
    });
});
