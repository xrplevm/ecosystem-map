import { z } from "zod";

import type { ExplorerApp } from "../explorer-apps-types";

/**
 * Unified runtime schema for the canonical `explorer-apps.json` entry.
 *
 * The structural source-of-truth for the shape is
 * `src/lib/explorer-apps-types.ts` (`ExplorerApp`). This schema validates
 * the same shape at every external boundary (S3 read, runtime fetch in
 * the consumer, Slack modal submit handler). It is the single Zod entry
 * point used across phase-7 sub-tasks D/E/F so that all writers and
 * readers agree on the contract.
 *
 * Two optional fields are additive on top of the historical 70-entry
 * corpus (decision #3 in `progress/plan-phase-7-s3-batch.md`):
 *
 *   - `surfaces`: when omitted, defaults to `["explorer-apps"]` — keeps
 *     the existing registry consumers parsing unchanged.
 *   - `ecosystemSection`: required iff `surfaces` includes
 *     `"ecosystem-map"`. Enforced via `superRefine` so the issue path
 *     points at `ecosystemSection` (the user-actionable field) rather
 *     than `surfaces`.
 */

const SLUG_RE = /^[a-z0-9-]+$/;

const httpsUrl = z
    .string()
    .url("must be a valid URL")
    .refine((v) => v.startsWith("https://"), "must use https://");

const slugString = (label: string) =>
    z
        .string()
        .min(1, `${label} is required`)
        .regex(SLUG_RE, `${label} must be lowercase alphanumeric with dashes`);

const surfaceEnum = z.enum(["explorer-apps", "ecosystem-map"]);

const surfacesField = z
    .array(surfaceEnum)
    .min(1, "surfaces must list at least one consumer")
    .default(["explorer-apps"]);

export const explorerAppSchema = z
    .object({
        id: slugString("id"),
        external: z.boolean(),
        title: z.string().min(1, "title is required").max(100, "title must be ≤100 chars"),
        logo: httpsUrl,
        shortDescription: z
            .string()
            .min(1, "shortDescription is required")
            .max(160, "shortDescription must be ≤160 chars"),
        description: z.string().max(4000, "description must be ≤4000 chars").optional(),
        categories: z
            .array(slugString("category"))
            .min(1, "at least one category is required")
            .max(10, "at most 10 categories allowed"),
        author: z.string().min(1, "author is required").max(200, "author must be ≤200 chars"),
        url: httpsUrl,
        site: httpsUrl.optional(),
        github: httpsUrl.optional(),
        surfaces: surfacesField,
        ecosystemSection: slugString("ecosystemSection").optional(),
    })
    .superRefine((value, ctx) => {
        if (value.surfaces.includes("ecosystem-map") && !value.ecosystemSection) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["ecosystemSection"],
                message:
                    'ecosystemSection is required when surfaces includes "ecosystem-map"',
            });
        }
    });

/** Pre-defaults shape (what an external producer hands us). */
export type ExplorerAppInput = z.input<typeof explorerAppSchema>;

/**
 * Post-defaults shape (what consumers see after `parse`).
 *
 * Compile-time invariant: `ExplorerAppParsed` is a structural subtype of
 * `ExplorerApp` from `explorer-apps-types.ts`. The only divergence is
 * `surfaces`, which becomes required after the default fires — that is
 * a strict refinement of the canonical shape (required → optional is
 * always assignable in TS), so downstream code typed against
 * `ExplorerApp` continues to compile without changes.
 */
export type ExplorerAppParsed = z.output<typeof explorerAppSchema>;

// Static assertion (erased at runtime) that the parsed shape still
// satisfies the canonical interface. If a future field ever drifts,
// this line will fail to compile.
type _Assignable = ExplorerAppParsed extends ExplorerApp ? true : never;
const _explorerAppParsedExtendsExplorerApp: _Assignable = true;
void _explorerAppParsedExtendsExplorerApp;

export const explorerAppsArraySchema = z.array(explorerAppSchema);

/**
 * Error thrown by the eager (`parse*`) helpers. Carries the original
 * `ZodError` so callers that want structured access (e.g. Slack block
 * builders) can still walk the issue tree, while the `message` is a
 * single-line, human-readable summary suitable for logs and DMs.
 */
export class ExplorerAppParseError extends Error {
    public readonly zodError: z.ZodError;

    constructor(message: string, zodError: z.ZodError) {
        super(message);
        this.name = "ExplorerAppParseError";
        this.zodError = zodError;
    }
}

/**
 * Error thrown by `assertUniqueIds`. Kept separate from
 * `ExplorerAppParseError` because `id` uniqueness is a *cross-entry*
 * invariant — it cannot be expressed inside the per-entry schema
 * without forcing every caller to validate the whole array at once.
 */
export class DuplicateIdError extends Error {
    public readonly duplicates: string[];

    constructor(duplicates: string[]) {
        super(`duplicate explorer-app id(s): ${duplicates.join(", ")}`);
        this.name = "DuplicateIdError";
        this.duplicates = duplicates;
    }
}

function formatZodError(error: z.ZodError): string {
    return error.errors
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
            return `${path}: ${issue.message}`;
        })
        .join("; ");
}

export function parseExplorerApp(input: unknown): ExplorerAppParsed {
    const result = explorerAppSchema.safeParse(input);
    if (!result.success) {
        throw new ExplorerAppParseError(
            `invalid explorer-app entry — ${formatZodError(result.error)}`,
            result.error,
        );
    }
    return result.data;
}

export function safeParseExplorerApp(
    input: unknown,
): { ok: true; value: ExplorerAppParsed } | { ok: false; error: string } {
    const result = explorerAppSchema.safeParse(input);
    if (!result.success) {
        return { ok: false, error: formatZodError(result.error) };
    }
    return { ok: true, value: result.data };
}

export function parseExplorerAppsArray(input: unknown): ExplorerAppParsed[] {
    const result = explorerAppsArraySchema.safeParse(input);
    if (!result.success) {
        throw new ExplorerAppParseError(
            `invalid explorer-apps array — ${formatZodError(result.error)}`,
            result.error,
        );
    }
    return result.data;
}

/**
 * Cross-entry invariant: ids must be unique across the whole array.
 * Throws `DuplicateIdError` listing every offending id (deduped, in
 * first-seen order) so a caller can surface the full conflict set in
 * one round-trip rather than failing on the first dup and looping.
 */
export function assertUniqueIds(apps: ReadonlyArray<ExplorerAppParsed>): void {
    const counts = new Map<string, number>();
    for (const app of apps) {
        counts.set(app.id, (counts.get(app.id) ?? 0) + 1);
    }
    const duplicates: string[] = [];
    counts.forEach((count, id) => {
        if (count > 1) duplicates.push(id);
    });
    if (duplicates.length > 0) {
        throw new DuplicateIdError(duplicates);
    }
}
