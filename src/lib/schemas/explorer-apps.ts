import { z } from "zod";

/**
 * Schemas and types mirroring the canonical `explorer-apps.json` shape
 * consumed by the mainnet-explorer-dapps registry downstream.
 *
 * The five explorer-apps "extras" (longDescription, categories, author,
 * site, github) live on `SubmissionSchema` as OPTIONAL fields — the
 * source-of-truth registry tolerates them missing, and the ecosystem
 * map continues to work without any of them.
 */

/**
 * Curated category vocabulary, kept aligned with the entries currently
 * present in `explorer-apps.json`. Order is the one the picker renders
 * (Bridge / DeFi / RWA up top because those are the most common in the
 * registry; meta-categories like API/gRPC/Snapshot are at the bottom).
 */
export const EXPLORER_CATEGORIES = [
    "Bridge",
    "DeFi",
    "RWA",
    "NFT",
    "Wallet",
    "DAO",
    "Prediction Market",
    "Launchpad",
    "Marketplace",
    "Oracles",
    "Explorer",
    "MEME",
    "AI",
    "Learning",
    "Tools",
    "Services",
    "API",
    "gRPC",
    "Snapshot",
    "Content",
] as const;

export const ExplorerCategorySchema = z.enum(EXPLORER_CATEGORIES);
export type ExplorerCategory = z.infer<typeof ExplorerCategorySchema>;

/** Convenience re-export so the UI imports a stable name without duplicating the list. */
export const CATEGORY_OPTIONS: ReadonlyArray<ExplorerCategory> = EXPLORER_CATEGORIES;

export const LONG_DESCRIPTION_MAX = 2000;
export const AUTHOR_MAX = 80;
export const EXPLORER_URL_MAX = 300;
export const CATEGORIES_MAX = 5;

export const EXPLORER_APP_LIMITS = {
    LONG_DESCRIPTION_MAX,
    AUTHOR_MAX,
    EXPLORER_URL_MAX,
    CATEGORIES_MAX,
} as const;
