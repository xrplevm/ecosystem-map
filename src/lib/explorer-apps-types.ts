/**
 * Wire shape of `explorer-apps.json` as stored in S3.
 *
 * This is the canonical source-of-truth shape for the dApp registry, shared
 * between the writer (Slack approval batch handler) and the consumer
 * (`App.tsx` runtime fetch). It is intentionally a structural type — the
 * Zod schema that validates network/S3 boundaries lives in
 * `src/lib/schemas/` and is added in phase-7b-s3-infra's schema sub-task
 * (`src/lib/explorer-apps.ts` will re-export the validated type once it
 * is refactored in sub-task D).
 *
 * The two optional fields `surfaces` and `ecosystemSection` are additive
 * to the historical 70-entry corpus, so existing entries continue to
 * parse unchanged. See `progress/plan-phase-7-s3-batch.md` decision #3.
 */

export type ExplorerAppSurface = "explorer-apps" | "ecosystem-map";

export interface ExplorerApp {
    id: string;
    external: boolean;
    title: string;
    /** Fully-qualified public URL of the logo asset (S3 origin). */
    logo: string;
    shortDescription: string;
    categories: string[];
    author: string;
    url: string;
    description?: string;
    site?: string;
    github?: string;
    /** Defaults to `["explorer-apps"]` at the consumer when absent. */
    surfaces?: ExplorerAppSurface[];
    /** Required iff `surfaces` includes `"ecosystem-map"`. */
    ecosystemSection?: string;
}

export type ExplorerAppsJson = ExplorerApp[];
