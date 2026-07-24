import { z } from "zod";

import { EnvValidationError } from "./errors";

/**
 * Runtime-validated environment for the submission backend.
 *
 * Each serverless handler calls `loadEnv()` at the top of its entry point.
 * The result is cached in module scope so we don't re-validate on every
 * warm invocation — Vercel reuses the same Node process across requests.
 */

const EnvSchema = z.object({
    SLACK_BOT_TOKEN: z
        .string()
        .min(1, "SLACK_BOT_TOKEN is required")
        .refine((v) => v.startsWith("xoxb-"), "SLACK_BOT_TOKEN must start with 'xoxb-'"),
    SLACK_SIGNING_SECRET: z
        .string()
        .min(32, "SLACK_SIGNING_SECRET must be at least 32 characters"),
    SLACK_APPROVAL_CHANNEL: z
        .string()
        .min(1, "SLACK_APPROVAL_CHANNEL is required")
        .refine((v) => v.startsWith("C") || v.startsWith("G"), "SLACK_APPROVAL_CHANNEL must be a channel ID (starts with C or G), not a name"),
    SUBMISSION_LOGO_MAX_BYTES: z
        .coerce.number()
        .int()
        .positive()
        .default(500_000),
    // Airtable staging — submissions land here as Pending rows (logo as an
    // attachment) until a reviewer approves them in `/explorer-admin`. The
    // base/table default to the known submission queue so local read-only
    // flows work; the PAT has no default and is asserted by the Airtable
    // client at call time so unrelated handlers/tests don't trip validation.
    AIRTABLE_API_KEY: z.string().min(1).optional(),
    AIRTABLE_BASE_ID: z.string().min(1).default("appDFL9N9MDWj0Ywd"),
    AIRTABLE_TABLE_ID: z.string().min(1).default("tblSXGty3mcKj7F62"),
    // S3 storage for the canonical `explorer-apps.json` and dApp logos.
    // Region/bucket/key carry safe defaults so local dev (read-only flows)
    // works without configuration. Access keys are intentionally optional
    // here — the S3 client itself asserts their presence at instantiation
    // so read-only callers (e.g. consumer fetch) don't trip env validation
    // when credentials aren't available.
    AWS_REGION: z.string().min(1).default("eu-west-1"),
    S3_BUCKET: z.string().min(1).default("peersyst-development"),
    S3_JSON_KEY: z.string().min(1).default("explorer-apps.json"),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export type SubmissionEnv = z.infer<typeof EnvSchema>;

let cached: SubmissionEnv | undefined;

export function loadEnv(): SubmissionEnv {
    if (cached !== undefined) {
        return cached;
    }
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
        throw new EnvValidationError(issues);
    }
    cached = parsed.data;
    return cached;
}

/**
 * True when the submission backend is fully configured — i.e. `loadEnv()`
 * succeeds. The only required-without-default fields are the three Slack vars,
 * so in practice this answers "is Slack configured?". Exposed to the static
 * frontend via `GET /api/config` so it can decide whether to open the in-app
 * submission form or link straight to the Airtable fallback (the CRA bundle
 * can't read these server-only vars itself).
 */
export function isSubmissionsConfigured(): boolean {
    try {
        loadEnv();
        return true;
    } catch {
        return false;
    }
}

/**
 * Test-only: reset the cache so tests with mutated `process.env` see fresh values.
 * NOT intended for use by handler code.
 */
export function __resetEnvCacheForTests(): void {
    cached = undefined;
}
