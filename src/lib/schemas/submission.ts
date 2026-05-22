import { z } from "zod";

import { SectionIdSchema } from "./ecosystem";
import {
    AUTHOR_MAX,
    CATEGORIES_MAX,
    EXPLORER_URL_MAX,
    ExplorerCategorySchema,
    LONG_DESCRIPTION_MAX,
} from "./explorer-apps";

/**
 * Schema for incoming submissions — shared between the frontend form (Phase 3)
 * and the backend serverless function (Phase 2).
 *
 * Required fields cover the ecosystem-map card (name, section, url, logo).
 * Optional fields cover the `explorer-apps.json` extras the downstream
 * registry consumes (longDescription, categories, author, site, github).
 *
 * `description` is the short tagline (≤DESCRIPTION_MAX) that doubles as the
 * explorer-apps `shortDescription`. `longDescription` is the full paragraph
 * (≤LONG_DESCRIPTION_MAX) the detail view uses. Both are optional so a
 * minimal submission still flies through.
 *
 * The schema rejects obvious garbage (non-https URLs, oversize free-text,
 * unknown categories) at the boundary so the rest of the pipeline can trust
 * the data.
 */

const HTTPS_URL_MAX = 300;
const NAME_MAX = 80;
// 320 leaves ~10% headroom above the longest `shortDescription` currently
// observed in the canonical `explorer-apps.json` registry (292 chars, entry
// `geochain`). The previous 280 would have rejected legitimate corpus entries.
const DESCRIPTION_MAX = 320;
const SUBMITTER_NAME_MAX = 80;

const emptyToUndefined = (v: unknown): unknown => {
    if (typeof v === "string" && v.trim() === "") {
        return undefined;
    }
    return v;
};

const optionalHttpsUrl = (label: string) =>
    z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .max(EXPLORER_URL_MAX, `${label} must be ${EXPLORER_URL_MAX} chars or fewer`)
            .url(`${label} must be a valid URL`)
            .refine((v) => v.startsWith("https://"), `${label} must start with https://`)
            .optional(),
    );

export const SubmissionSchema = z.object({
    name: z.string().trim().min(1, "name is required").max(NAME_MAX, `name must be ${NAME_MAX} chars or fewer`),
    section: SectionIdSchema,
    url: z
        .string()
        .trim()
        .max(HTTPS_URL_MAX, `url must be ${HTTPS_URL_MAX} chars or fewer`)
        .url("url must be a valid URL")
        .refine((v) => v.startsWith("https://"), "url must start with https://"),
    description: z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .max(DESCRIPTION_MAX, `description must be ${DESCRIPTION_MAX} chars or fewer`)
            .optional(),
    ),
    longDescription: z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .max(LONG_DESCRIPTION_MAX, `longDescription must be ${LONG_DESCRIPTION_MAX} chars or fewer`)
            .optional(),
    ),
    // `categories` is opt-in. An empty array is treated the same as "field not
    // provided" so the form contract stays simple (no need to send an empty
    // array; just omit the field).
    categories: z.preprocess(
        (v) => (Array.isArray(v) && v.length === 0 ? undefined : v),
        z
            .array(ExplorerCategorySchema)
            .min(1, "Pick at least one category")
            .max(CATEGORIES_MAX, `Pick at most ${CATEGORIES_MAX} categories`)
            .optional(),
    ),
    author: z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .max(AUTHOR_MAX, `author must be ${AUTHOR_MAX} chars or fewer`)
            .optional(),
    ),
    site: optionalHttpsUrl("site"),
    github: optionalHttpsUrl("github"),
    submitterEmail: z.string().trim().email("submitterEmail must be a valid email"),
    submitterName: z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .max(SUBMITTER_NAME_MAX, `submitterName must be ${SUBMITTER_NAME_MAX} chars or fewer`)
            .optional(),
    ),
});

export type Submission = z.infer<typeof SubmissionSchema>;

export const SUBMISSION_LIMITS = {
    NAME_MAX,
    DESCRIPTION_MAX,
    HTTPS_URL_MAX,
    SUBMITTER_NAME_MAX,
    LONG_DESCRIPTION_MAX,
    AUTHOR_MAX,
    SITE_URL_MAX: EXPLORER_URL_MAX,
    GITHUB_URL_MAX: EXPLORER_URL_MAX,
    CATEGORIES_MAX,
} as const;
