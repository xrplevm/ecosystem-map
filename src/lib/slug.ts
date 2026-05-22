/**
 * Slugify human input into a kebab-case identifier matching
 * `/^[a-z0-9][a-z0-9-]*$/` (the `id` shape required by
 * `ExplorerAppSchema` and used as the S3 logo key in `api/submit.ts`).
 *
 * Strategy: lowercase, strip diacritics, replace anything non-alphanumeric
 * with a hyphen, collapse repeats, trim. Same semantics on frontend and
 * backend so duplicate detection is deterministic.
 */
export function slugify(input: string): string {
    const normalized = input
        .normalize("NFKD")
        // Strip Unicode combining marks (Mn category): the NFKD step splits
        // accented letters into base + combining mark; we drop the mark.
        // Using `\p{Mn}` instead of a literal range avoids fragility around
        // editor re-encoding of the combining-mark code points (U+0300–U+036F).
        .replace(/\p{Mn}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    return normalized;
}
