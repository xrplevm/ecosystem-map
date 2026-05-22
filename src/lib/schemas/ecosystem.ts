import { z } from "zod";

/**
 * Section vocabulary for the ecosystem map.
 *
 * Phase 7 retired the committed JSON file the ecosystem-entry schema once
 * validated; the canonical registry now lives in S3 (see
 * `src/lib/schemas/explorer-app.ts`). What remains here is the section
 * enum + Zod schema, the single source of truth for which sections the
 * frontend renders and the submission form accepts.
 */

export const SECTION_IDS = [
    "wallets",
    "bridges",
    "dapps",
    "oracles",
    "indexers",
    "daos",
    "explorers",
    "validators",
    "core",
    "auditors",
    "providers",
] as const;

export const SectionIdSchema = z.enum(SECTION_IDS);
export type SectionId = z.infer<typeof SectionIdSchema>;
