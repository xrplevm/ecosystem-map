import type { VercelRequest, VercelResponse } from "@vercel/node";

import { auditSubmission, formatAuditForSlack } from "../src/lib/audit";
import { loadEnv } from "../src/lib/env";
import {
    EnvValidationError,
    SubmissionError,
    SubmissionErrorCode,
} from "../src/lib/errors";
import type { ExplorerApp } from "../src/lib/explorer-apps-types";
import { parseMultipart, type MultipartFieldValue } from "../src/lib/multipart";
import { putLogo } from "../src/lib/s3-client";
import { explorerAppSchema } from "../src/lib/schemas/explorer-app";
import { SubmissionSchema, type Submission } from "../src/lib/schemas/submission";
import { postMessage } from "../src/lib/slack";
import { PENDING_EVENT_TYPE } from "../src/lib/slack-batch";
import { slugify } from "../src/lib/slug";

/**
 * POST /api/submit — accepts a multipart form, uploads the logo to S3,
 * runs the Anthropic-Claude integrity audit, then posts an approval
 * message tagged with `metadata.event_type=explorer_submission_pending`
 * so the `/explorer-admin` modal can list it from `conversations.history`.
 *
 * Phase-7e shape (post-PR-flow retirement):
 *   - Logo bytes go to S3 (`explorer-dapp-<id>.<ext>`), and the resulting
 *     URL is the value we store in the entry's `logo` field.
 *   - The Slack message has NO Approve/Reject buttons — those moved to
 *     the multi-mode admin modal. Approval is a batch-write keyed by
 *     metadata + Slack reactions (✅/❌).
 *   - The audit verdict from Claude is rendered in the message body so
 *     the human reviewer sees the signal before opening the modal.
 */

export const config = {
    api: { bodyParser: false },
};

const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const ALLOWED_LOGO_EXT_BY_MIME: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED" });
        return;
    }

    try {
        const env = loadEnv();

        const parsed = await parseMultipart({
            headers: req.headers,
            stream: req,
            maxFileBytes: env.SUBMISSION_LOGO_MAX_BYTES,
            fileFieldName: "logo",
        });

        if (parsed.file === undefined) {
            throw new SubmissionError(SubmissionErrorCode.LOGO_MISSING, "Logo file is required");
        }
        if (!ALLOWED_LOGO_MIME.has(parsed.file.mimeType)) {
            throw new SubmissionError(
                SubmissionErrorCode.INVALID_LOGO_TYPE,
                `Unsupported logo type: ${parsed.file.mimeType}`,
            );
        }

        const submission = parseSubmissionFields(parsed.fields);

        const id = slugify(submission.name);
        if (id === "") {
            throw new SubmissionError(SubmissionErrorCode.INVALID_PAYLOAD, "name produces an empty id");
        }
        if (submission.description === undefined || submission.description === "") {
            // The ExplorerApp schema requires `shortDescription`. Surface
            // the constraint at the submission boundary rather than failing
            // mid-pipeline at approval time.
            throw new SubmissionError(
                SubmissionErrorCode.INVALID_PAYLOAD,
                "description is required (used as shortDescription on the explorer card)",
            );
        }

        const logoExt = ALLOWED_LOGO_EXT_BY_MIME[parsed.file.mimeType];
        const logoKey = `explorer-dapp-${id}${logoExt}`;
        const { url: logoUrl } = await putLogo(logoKey, parsed.file.bytes, parsed.file.mimeType);

        const author = submission.author ?? submission.submitterName ?? "Unknown";
        const categories = submission.categories === undefined || submission.categories.length === 0
            ? [submission.section]
            : submission.categories.map(slugifyCategory);

        const candidate = {
            id,
            external: true,
            title: submission.name,
            logo: logoUrl,
            shortDescription: submission.description,
            categories,
            author,
            url: submission.url,
            ...(submission.longDescription !== undefined ? { description: submission.longDescription } : {}),
            ...(submission.site !== undefined ? { site: submission.site } : {}),
            ...(submission.github !== undefined ? { github: submission.github } : {}),
            surfaces: ["ecosystem-map"] as const,
            ecosystemSection: submission.section,
        };

        const validated = explorerAppSchema.safeParse(candidate);
        if (!validated.success) {
            const detail = validated.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ");
            throw new SubmissionError(
                SubmissionErrorCode.INVALID_PAYLOAD,
                `Submission failed explorer-app validation: ${detail}`,
            );
        }
        const entry: ExplorerApp = validated.data;

        // Run the audit in parallel with logo upload would be nicer but
        // the audit has to come AFTER the entry is finalized (the prompt
        // needs the canonical fields). 8s timeout inside auditSubmission
        // bounds total cost.
        const auditVerdict = await auditSubmission({
            title: entry.title,
            url: entry.url,
            site: entry.site,
            github: entry.github,
            shortDescription: entry.shortDescription,
            description: entry.description,
            categories: entry.categories,
            author: entry.author,
        });
        const auditFormatted = formatAuditForSlack(auditVerdict);

        const submitter = submission.submitterName !== undefined
            ? { email: submission.submitterEmail, name: submission.submitterName }
            : { email: submission.submitterEmail };

        const blocks = buildPendingMessageBlocks({
            entry,
            submitter,
            auditMrkdwn: auditFormatted.mrkdwn,
        });

        await postMessage({
            token: env.SLACK_BOT_TOKEN,
            channel: env.SLACK_APPROVAL_CHANNEL,
            blocks,
            text: `New ecosystem submission: ${entry.title}`,
            // The `metadata` parameter is documented for chat.postMessage.
            // postMessage's helper takes a fixed set of fields; route the
            // call through it but extend the body via the `metadata` param.
            metadata: {
                event_type: PENDING_EVENT_TYPE,
                // `event_payload` is typed `Record<string, unknown>` on Slack's
                // metadata envelope; `ExplorerApp` is structurally compatible
                // but strictly richer (e.g. `external: boolean`), so the double
                // cast bridges the narrowing without weakening the value.
                event_payload: entry as unknown as Record<string, unknown>,
            },
        });

        res.status(200).json({
            ok: true,
            id,
            audit: auditVerdict.verdict,
        });
    } catch (err) {
        respondWithError(res, err);
    }
}

function buildPendingMessageBlocks(args: {
    entry: ExplorerApp;
    submitter: { email: string; name?: string };
    auditMrkdwn: string;
}): Array<Record<string, unknown>> {
    const e = args.entry;
    const fields: string[] = [
        `*Title:* ${escapeMarkdown(e.title)}`,
        `*ID:* \`${e.id}\``,
        `*Section:* ${e.ecosystemSection ?? "(none)"}`,
        `*URL:* <${e.url}|${escapeMarkdown(e.url)}>`,
        `*Author:* ${escapeMarkdown(e.author)}`,
        `*Categories:* ${e.categories.map((c) => `\`${c}\``).join(", ")}`,
        `*Short description:* ${escapeMarkdown(e.shortDescription)}`,
        `*Submitter:* ${escapeMarkdown(args.submitter.name ?? "(anonymous)")} <${escapeMarkdown(args.submitter.email)}>`,
    ];
    if (e.site !== undefined) fields.push(`*Site:* <${e.site}|${escapeMarkdown(e.site)}>`);
    if (e.github !== undefined) fields.push(`*GitHub:* <${e.github}|${escapeMarkdown(e.github)}>`);
    if (e.description !== undefined) fields.push(`*Description:* ${escapeMarkdown(e.description)}`);

    return [
        {
            type: "header",
            text: { type: "plain_text", text: "New ecosystem submission" },
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: fields.join("\n") },
        },
        {
            type: "image",
            image_url: e.logo,
            alt_text: `${e.title} logo`,
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: args.auditMrkdwn },
        },
        {
            type: "context",
            elements: [
                {
                    type: "mrkdwn",
                    text: "Use `/explorer-admin` → *Pending submissions* to approve in batch.",
                },
            ],
        },
    ];
}

const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const TRIM_DASH = /^-+|-+$/g;

function slugifyCategory(c: string): string {
    return c.toLowerCase().replace(NON_SLUG_CHARS, "-").replace(TRIM_DASH, "");
}

function parseSubmissionFields(fields: Record<string, MultipartFieldValue>): Submission {
    const parsed = SubmissionSchema.safeParse({
        name: pickFirstString(fields.name),
        section: pickFirstString(fields.section),
        url: pickFirstString(fields.url),
        description: pickFirstString(fields.description),
        longDescription: pickFirstString(fields.longDescription),
        categories: collectAllStrings(fields.categories),
        author: pickFirstString(fields.author),
        site: pickFirstString(fields.site),
        github: pickFirstString(fields.github),
        submitterEmail: pickFirstString(fields.submitterEmail),
        submitterName: pickFirstString(fields.submitterName),
    });
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new SubmissionError(SubmissionErrorCode.INVALID_PAYLOAD, `Submission validation failed: ${detail}`);
    }
    return parsed.data;
}

function pickFirstString(v: MultipartFieldValue | undefined): string | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}

function collectAllStrings(v: MultipartFieldValue | undefined): string[] | undefined {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.length === 0 ? undefined : v;
    return v === "" ? undefined : [v];
}

function setCorsHeaders(res: VercelResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function respondWithError(res: VercelResponse, err: unknown): void {
    if (err instanceof SubmissionError) {
        const status = mapSubmissionStatus(err.code);
        const payload: Record<string, unknown> = { ok: false, code: err.code, message: err.message };
        if (err.suggestion !== undefined) {
            payload.suggestion = err.suggestion;
        }
        res.status(status).json(payload);
        return;
    }
    if (err instanceof EnvValidationError) {
        console.error("[submit] env validation failed", err.issues);
        res.status(500).json({ ok: false, code: "ENV_INVALID", message: "Server is misconfigured" });
        return;
    }
    console.error("[submit] unexpected error", err instanceof Error ? err.stack ?? err.message : err);
    res.status(500).json({ ok: false, code: "INTERNAL", message: "Internal error" });
}

function mapSubmissionStatus(code: SubmissionErrorCode): number {
    switch (code) {
        case SubmissionErrorCode.INVALID_PAYLOAD:
        case SubmissionErrorCode.SECTION_INVALID:
        case SubmissionErrorCode.LOGO_MISSING:
            return 400;
        case SubmissionErrorCode.INVALID_LOGO_TYPE:
            return 415;
        case SubmissionErrorCode.LOGO_TOO_LARGE:
            return 413;
        case SubmissionErrorCode.UPSTREAM_SLACK:
            return 502;
        default: {
            const exhaustive: never = code;
            void exhaustive;
            return 500;
        }
    }
}

function escapeMarkdown(input: string): string {
    return input.replace(/[<>&]/gu, (ch) => {
        if (ch === "<") return "&lt;";
        if (ch === ">") return "&gt;";
        return "&amp;";
    });
}
