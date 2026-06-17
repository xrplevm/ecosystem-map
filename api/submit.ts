import type { VercelRequest, VercelResponse } from "@vercel/node";

import {
    AirtableError,
    createSubmissionRecord,
    deleteRecord,
    uploadIcon,
} from "../src/lib/airtable";
import { loadEnv } from "../src/lib/env";
import {
    EnvValidationError,
    SubmissionError,
    SubmissionErrorCode,
} from "../src/lib/errors";
import { parseMultipart, type MultipartFieldValue } from "../src/lib/multipart";
import { explorerAppSchema } from "../src/lib/schemas/explorer-app";
import { SubmissionSchema, type Submission } from "../src/lib/schemas/submission";
import { postMessage } from "../src/lib/slack";
import { slugify } from "../src/lib/slug";

/**
 * POST /api/submit — accepts the multipart submission form and stages it in
 * Airtable as a `Status = Pending` row. **Nothing is written to S3** here; the
 * raw logo is stored as an Airtable attachment and only promoted to S3 (after
 * normalisation) when a reviewer approves via `/explorer-admin`.
 *
 * Flow:
 *   1. Parse + validate the fields (`SubmissionSchema`) and a pre-flight
 *      `explorerAppSchema` check (so a row that could never become a valid
 *      registry entry is rejected at the boundary, not left unapprovable).
 *   2. Create the Airtable record, then upload the raw logo bytes to its
 *      attachment field. If the upload fails, the record is rolled back.
 *   3. Post a lightweight Slack notice linking the Airtable record.
 *
 * No Claude audit (removed): approval is a purely human review in Slack.
 */

export const config = {
    api: { bodyParser: false },
};

const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);

// Syntactically-valid placeholder used only for the pre-flight schema check;
// the real logo URL is assigned at approval after the S3 upload.
const PREFLIGHT_LOGO_URL = "https://airtable.invalid/pending-logo.png";

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
            // `shortDescription` is required on the explorer card. Surface the
            // constraint at the boundary rather than failing at approval.
            throw new SubmissionError(
                SubmissionErrorCode.INVALID_PAYLOAD,
                "description is required (used as shortDescription on the explorer card)",
            );
        }

        const categorySlugs =
            submission.categories === undefined || submission.categories.length === 0
                ? [submission.section]
                : submission.categories.map((c) => slugify(c));

        // Pre-flight: a logo-less validation of the would-be registry entry, so
        // anything the explorer-app schema would reject (e.g. shortDescription
        // >160 chars) is caught now instead of becoming an unapprovable row.
        // Validate against BOTH surfaces (the strictest case — it requires
        // `ecosystemSection`) so the row is approvable to any target the
        // reviewer later picks in Slack.
        const preflight = explorerAppSchema.safeParse({
            id,
            external: true,
            title: submission.name,
            logo: PREFLIGHT_LOGO_URL,
            shortDescription: submission.description,
            categories: categorySlugs,
            author: submission.author ?? submission.submitterName ?? "Unknown",
            url: submission.url,
            ...(submission.longDescription !== undefined ? { description: submission.longDescription } : {}),
            ...(submission.site !== undefined ? { site: submission.site } : {}),
            ...(submission.github !== undefined ? { github: submission.github } : {}),
            surfaces: ["explorer-apps", "ecosystem-map"] as const,
            ecosystemSection: submission.section,
        });
        if (!preflight.success) {
            const detail = preflight.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ");
            throw new SubmissionError(
                SubmissionErrorCode.INVALID_PAYLOAD,
                `Submission failed explorer-app validation: ${detail}`,
            );
        }

        // Stage in Airtable: create the row, then attach the RAW logo bytes
        // (normalisation is deferred to approval). Roll back the row if the
        // attachment upload fails so we never leave a Pending row without a logo.
        const recordId = await createSubmissionRecord({
            name: submission.name,
            url: submission.url,
            shortDescription: submission.description,
            section: submission.section,
            categories: submission.categories,
            longDescription: submission.longDescription,
            author: submission.author,
            site: submission.site,
            github: submission.github,
            submitterEmail: submission.submitterEmail,
            submitterName: submission.submitterName,
        });

        try {
            await uploadIcon(recordId, parsed.file.bytes, parsed.file.mimeType, parsed.file.filename || `${id}`);
        } catch (uploadErr) {
            try {
                await deleteRecord(recordId);
            } catch (rollbackErr) {
                console.error("[submit] failed to roll back record after icon upload error", rollbackErr);
            }
            throw new SubmissionError(
                SubmissionErrorCode.UPSTREAM_AIRTABLE,
                `Failed to attach logo to Airtable: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
            );
        }

        // Best-effort Slack notice — a failed post must not fail the submission
        // (the row is already safely staged in Airtable).
        try {
            await postMessage({
                token: env.SLACK_BOT_TOKEN,
                channel: env.SLACK_APPROVAL_CHANNEL,
                text: `New ecosystem submission: ${submission.name}`,
                blocks: buildNoticeBlocks({
                    name: submission.name,
                    id,
                    section: submission.section,
                    submitterEmail: submission.submitterEmail,
                    recordUrl: `https://airtable.com/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
                }),
            });
        } catch (slackErr) {
            console.warn("[submit] Slack notice failed (submission still staged)", slackErr);
        }

        res.status(200).json({ ok: true, id, recordId });
    } catch (err) {
        respondWithError(res, err);
    }
}

function buildNoticeBlocks(args: {
    name: string;
    id: string;
    section: string;
    submitterEmail: string;
    recordUrl: string;
}): Array<Record<string, unknown>> {
    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text:
                    `:inbox_tray: *New submission:* ${escapeMarkdown(args.name)} (\`${args.id}\`)\n` +
                    `Section: \`${args.section}\` — review via \`/explorer-admin\` → *Pending submissions*.`,
            },
        },
        {
            type: "context",
            elements: [
                {
                    type: "mrkdwn",
                    text: `<${args.recordUrl}|Open in Airtable> · from ${escapeMarkdown(args.submitterEmail)}`,
                },
            ],
        },
    ];
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
    if (err instanceof AirtableError) {
        console.error("[submit] Airtable error", err.message);
        res.status(502).json({ ok: false, code: "UPSTREAM_AIRTABLE", message: "Could not stage the submission" });
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
        case SubmissionErrorCode.UPSTREAM_AIRTABLE:
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
