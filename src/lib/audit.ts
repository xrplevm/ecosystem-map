import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Lightweight integrity audit of a project submission via Anthropic Claude
 * (`claude-3-5-haiku-latest`). Used by:
 *   1. The submission intake (`api/submit.ts`) when a new entry arrives in the
 *      Slack approvals channel.
 *   2. The batch admin handler when an existing entry is edited and the diff
 *      touches `url`, `site` or `github`.
 *
 * Out of scope: this is a heuristic signal for the human approver, NOT a hard
 * gate. The function NEVER throws; on timeout, network or parse failure it
 * returns a `warn` verdict so the approval flow keeps moving — see
 * `_shared/senior-judgment.md` "external integrations must degrade gracefully".
 */

export type AuditInput = {
    title: string;
    url: string;
    site?: string;
    github?: string;
    shortDescription: string;
    description?: string;
    categories: string[];
    author: string;
};

export type AuditVerdict = {
    verdict: "ok" | "warn" | "block";
    reasons: string[];
    /** Model self-reported confidence in [0, 1]. 0 when audit unavailable. */
    confidence: number;
    /** Raw model output. Only populated for warn/block to aid manual review. */
    raw?: string;
};

const MODEL = "claude-3-5-haiku-latest";
const TIMEOUT_MS = 8_000;
const MAX_TOKENS = 400;

const VerdictSchema = z.object({
    verdict: z.enum(["ok", "warn", "block"]),
    reasons: z.array(z.string().min(1)).max(10),
    confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = [
    "You are an integrity reviewer for a curated XRPL EVM ecosystem listing.",
    "Given a project submission, decide whether to surface the entry for human approval.",
    "Look for: scam/phishing patterns, typosquatted or suspicious domains, impersonation of well-known projects,",
    "contradictions between url/site/github, empty or boilerplate descriptions that suggest filler content.",
    "",
    "Verdict rules:",
    '- "ok": no red flags, project looks legitimate at a surface level.',
    '- "warn": something off (weak description, mismatch, unverifiable claim) but not clearly malicious.',
    '- "block": clear red flag (impersonation, phishing domain, scam pattern).',
    "",
    "Respond with a SINGLE JSON object and nothing else. No prose, no markdown fences. Schema:",
    '{"verdict":"ok"|"warn"|"block","reasons":string[],"confidence":number}',
    "where reasons is 1-6 short bullet strings (≤140 chars each) and confidence is in [0,1].",
].join("\n");

function buildUserPrompt(input: AuditInput): string {
    const lines = [
        `title: ${input.title}`,
        `url: ${input.url}`,
        input.site ? `site: ${input.site}` : undefined,
        input.github ? `github: ${input.github}` : undefined,
        `author: ${input.author}`,
        `categories: ${input.categories.join(", ") || "(none)"}`,
        `shortDescription: ${input.shortDescription}`,
        input.description ? `description: ${input.description}` : undefined,
    ].filter((line): line is string => line !== undefined);
    return lines.join("\n");
}

function unavailable(reason: string): AuditVerdict {
    return {
        verdict: "warn",
        reasons: [`audit unavailable: ${reason}`],
        confidence: 0,
    };
}

/**
 * Extract the first plain-text block from a Claude `messages.create` response.
 * The SDK returns a discriminated array of content blocks; we only request
 * text so a single text block is the expected shape.
 */
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
    for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
            return block.text;
        }
    }
    return "";
}

function parseVerdict(raw: string): AuditVerdict {
    // The model is instructed to return raw JSON, but be defensive: strip
    // surrounding whitespace and (rarely) ```json fences before parsing.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return { verdict: "warn", reasons: ["audit parse error"], confidence: 0, raw };
    }
    const result = VerdictSchema.safeParse(parsed);
    if (!result.success) {
        return { verdict: "warn", reasons: ["audit parse error"], confidence: 0, raw };
    }
    const verdict: AuditVerdict = {
        verdict: result.data.verdict,
        reasons: result.data.reasons,
        confidence: result.data.confidence,
    };
    if (verdict.verdict !== "ok") {
        verdict.raw = raw;
    }
    return verdict;
}

export async function auditSubmission(
    input: AuditInput,
    options: { apiKey?: string; client?: Anthropic } = {},
): Promise<AuditVerdict> {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!options.client && (apiKey === undefined || apiKey === "")) {
        return unavailable("ANTHROPIC_API_KEY missing");
    }
    const client = options.client ?? new Anthropic({ apiKey });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await client.messages.create(
            {
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: buildUserPrompt(input) }],
            },
            { signal: controller.signal },
        );
        const text = extractText(response.content);
        if (text === "") {
            return unavailable("empty response");
        }
        return parseVerdict(text);
    } catch (err) {
        const name = err instanceof Error ? err.name : "unknown";
        if (name === "AbortError" || name === "APIUserAbortError") {
            return unavailable("timeout");
        }
        const message = err instanceof Error ? err.message : String(err);
        return unavailable(`network error (${message})`);
    } finally {
        clearTimeout(timeout);
    }
}

export function formatAuditForSlack(verdict: AuditVerdict): {
    emoji: string;
    line: string;
    mrkdwn: string;
} {
    const emoji = verdict.verdict === "ok" ? "✅" : verdict.verdict === "warn" ? "⚠️" : "🛑";
    const confidencePct = Math.round(verdict.confidence * 100);
    const line = `${emoji} Audit: ${verdict.verdict.toUpperCase()} (confidence ${confidencePct}%)`;
    const bullets = verdict.reasons.length === 0
        ? "_(no reasons reported)_"
        : verdict.reasons.map((reason) => `• ${reason}`).join("\n");
    const mrkdwn = `*${line}*\n${bullets}`;
    return { emoji, line, mrkdwn };
}
