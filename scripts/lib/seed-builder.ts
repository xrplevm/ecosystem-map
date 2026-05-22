/**
 * Pure merge logic for the phase-7h migration seed.
 *
 * Inputs:
 *   - `explorerApps`: parsed array of the canonical `explorer-apps.json`
 *     registry (see `src/lib/schemas/explorer-apps-entry.ts`).
 *   - `ecosystemEntries`: parsed array of `src/data/ecosystem.json`
 *     (see `src/lib/schemas/ecosystem.ts`).
 *
 * Output:
 *   - `entries`: merged array of `MigrationSeedEntry` (explorer-apps shape +
 *     `surfaces` and `ecosystemSection` opt-in fields).
 *   - `report`: structured counters/lists describing matches, creates,
 *     mismatches, and entries we refused to map.
 *
 * The CLI wrapper (`scripts/generate-seed.ts`) handles I/O; this module is
 * pure so the test suite can drive it with fixtures and assert on the
 * report shape directly.
 *
 * The output is intentionally NOT validated against
 * `ExplorerAppEntrySchema` — the seed is a *staging* artefact that a human
 * inspects and edits before upload. Strict validation belongs in the
 * Slack-side "Apply seed" handler (sub-tarea E), not here.
 */
import type { ExplorerCategory } from "../../src/lib/schemas/explorer-apps";

/**
 * A row of `explorer-apps.json` as it lives on the wire. Locally we accept
 * partial shapes (some fields may be missing in fixtures or hand-written
 * seeds); the merge surfaces missing required fields via the `skipped`
 * report rather than throwing.
 */
export interface ExplorerAppsEntryInput {
    id: string;
    external?: boolean;
    title: string;
    logo?: string;
    shortDescription?: string;
    categories?: string[];
    author?: string;
    url: string;
    description?: string;
    site?: string;
    github?: string;
    surfaces?: string[];
    ecosystemSection?: string;
}

/** Row of `src/data/ecosystem.json`. */
export interface EcosystemEntryInput {
    slug: string;
    name: string;
    section: string;
    url: string;
    logoFile: string;
    description?: string;
    longDescription?: string;
    categories?: string[];
    author?: string;
    site?: string;
    github?: string;
}

/** Final merged row. Superset of the explorer-apps shape. */
export interface MigrationSeedEntry {
    id: string;
    external: boolean;
    title: string;
    logo: string;
    shortDescription: string;
    categories: string[];
    author: string;
    url: string;
    description?: string;
    site?: string;
    github?: string;
    surfaces: ("explorer-apps" | "ecosystem-map")[];
    ecosystemSection?: string;
}

export interface SeedMismatch {
    id: string;
    field: "title" | "url" | "site" | "github" | "author";
    explorerApps: string | undefined;
    ecosystemMap: string | undefined;
}

export interface SeedSkip {
    source: "explorer-apps" | "ecosystem-map";
    identifier: string;
    reason: string;
}

export interface SeedReport {
    explorerAppsCount: number;
    ecosystemCount: number;
    mergedCount: number;
    matches: { id: string; ecosystemSection: string }[];
    creates: { id: string; ecosystemSection: string; title: string }[];
    explorerAppsOnly: { id: string; title: string }[];
    mismatches: SeedMismatch[];
    skipped: SeedSkip[];
}

export interface BuildSeedResult {
    entries: MigrationSeedEntry[];
    report: SeedReport;
}

/**
 * Best-effort mapping of legacy `ecosystem.json` section ids to the closest
 * curated `ExplorerCategory` from `explorer-apps.ts`. Migration-only — once
 * a human reviews the seed they can refine these per row.
 */
const SECTION_TO_CATEGORY: Record<string, ExplorerCategory> = {
    wallets: "Wallet",
    bridges: "Bridge",
    dapps: "DeFi",
    oracles: "Oracles",
    indexers: "Tools",
    daos: "DAO",
    explorers: "Explorer",
    validators: "Services",
    core: "Tools",
    auditors: "Services",
    providers: "Services",
};

/**
 * Canonicalises a URL for comparison: lowercase host, drop trailing slash.
 * Falls back to a trimmed/lowercased raw string when the URL is not
 * parseable so two equally-malformed values still compare equal.
 */
export function normalizeUrl(input: string | undefined): string {
    if (!input) {
        return "";
    }
    try {
        const url = new URL(input);
        const host = url.host.toLowerCase();
        const path = url.pathname.replace(/\/+$/u, "");
        return `${url.protocol}//${host}${path}${url.search}`;
    } catch {
        return input.trim().toLowerCase();
    }
}

function pushMismatch(
    out: SeedMismatch[],
    id: string,
    field: SeedMismatch["field"],
    explorer: string | undefined,
    ecosystem: string | undefined,
    compare: (a: string, b: string) => boolean = (a, b) => a === b,
): void {
    if (!explorer || !ecosystem) {
        // One side absent — informational, not a conflict. Surface only
        // when both sides claim a value and they disagree.
        return;
    }
    if (compare(explorer, ecosystem)) {
        return;
    }
    out.push({ id, field, explorerApps: explorer, ecosystemMap: ecosystem });
}

/**
 * Build the merged seed from the two sources. Pure function — no I/O.
 */
export function buildSeed(
    explorerApps: ExplorerAppsEntryInput[],
    ecosystemEntries: EcosystemEntryInput[],
): BuildSeedResult {
    const skipped: SeedSkip[] = [];
    const mismatches: SeedMismatch[] = [];
    const matches: SeedReport["matches"] = [];
    const creates: SeedReport["creates"] = [];

    // Phase 1: index the explorer-apps source. Trust its ids verbatim.
    const byId = new Map<string, MigrationSeedEntry>();
    for (const raw of explorerApps) {
        if (!raw.id || !raw.title || !raw.url) {
            skipped.push({
                source: "explorer-apps",
                identifier: raw.id || raw.title || "<no-id>",
                reason: "missing required field (id/title/url)",
            });
            continue;
        }
        const surfaces: ("explorer-apps" | "ecosystem-map")[] =
            raw.surfaces && raw.surfaces.length > 0
                ? raw.surfaces.filter(
                      (s): s is "explorer-apps" | "ecosystem-map" =>
                          s === "explorer-apps" || s === "ecosystem-map",
                  )
                : ["explorer-apps"];
        const entry: MigrationSeedEntry = {
            id: raw.id,
            external: raw.external ?? true,
            title: raw.title,
            logo: raw.logo ?? "",
            shortDescription: raw.shortDescription ?? "",
            categories: raw.categories ? [...raw.categories] : [],
            author: raw.author ?? "",
            url: raw.url,
            description: raw.description,
            site: raw.site,
            github: raw.github,
            surfaces,
            ecosystemSection: raw.ecosystemSection,
        };
        byId.set(entry.id, entry);
    }

    // Phase 2: walk ecosystem.json. Match by slug==id (the schema invariant
    // in `src/lib/slug.ts`); on miss synthesise a fresh row.
    for (const eco of ecosystemEntries) {
        if (!eco.slug || !eco.name || !eco.url || !eco.section) {
            skipped.push({
                source: "ecosystem-map",
                identifier: eco.slug || eco.name || "<no-slug>",
                reason: "missing required field (slug/name/url/section)",
            });
            continue;
        }

        const existing = byId.get(eco.slug);
        if (existing) {
            // MERGE branch: add the ecosystem-map surface, attach the
            // section, and record any field divergence — explorer-apps
            // values win silently in the output (the registry is SoT).
            if (!existing.surfaces.includes("ecosystem-map")) {
                existing.surfaces.push("ecosystem-map");
            }
            existing.ecosystemSection = eco.section;

            pushMismatch(mismatches, eco.slug, "title", existing.title, eco.name);
            pushMismatch(
                mismatches,
                eco.slug,
                "url",
                existing.url,
                eco.url,
                (a, b) => normalizeUrl(a) === normalizeUrl(b),
            );
            pushMismatch(
                mismatches,
                eco.slug,
                "site",
                existing.site,
                eco.site,
                (a, b) => normalizeUrl(a) === normalizeUrl(b),
            );
            pushMismatch(
                mismatches,
                eco.slug,
                "github",
                existing.github,
                eco.github,
                (a, b) => normalizeUrl(a) === normalizeUrl(b),
            );
            pushMismatch(mismatches, eco.slug, "author", existing.author, eco.author);

            matches.push({ id: eco.slug, ecosystemSection: eco.section });
            continue;
        }

        // CREATE branch: synthesise a row with the explorer-apps shape
        // best-effort. Humans review the seed before upload, so we leave
        // `logo` empty when we cannot derive a stable URL — the dedicated
        // `migrate-logos` runner (sub-task H.2) populates it.
        const fallbackCategory = SECTION_TO_CATEGORY[eco.section] ?? "Tools";
        const created: MigrationSeedEntry = {
            id: eco.slug,
            external: true,
            title: eco.name,
            logo: "",
            shortDescription: eco.description ?? eco.name,
            categories:
                eco.categories && eco.categories.length > 0
                    ? [...eco.categories]
                    : [fallbackCategory],
            author: eco.author ?? "unknown",
            url: eco.url,
            description: eco.longDescription ?? eco.description,
            site: eco.site,
            github: eco.github,
            surfaces: ["ecosystem-map"],
            ecosystemSection: eco.section,
        };
        byId.set(eco.slug, created);
        creates.push({ id: eco.slug, ecosystemSection: eco.section, title: eco.name });
    }

    // Stable order — explorer-apps first, then ecosystem-only creates in
    // input order. `Map` iterates in insertion order, satisfying both.
    const entries = Array.from(byId.values());

    const explorerAppsOnly = entries
        .filter((e) => e.surfaces.length === 1 && e.surfaces[0] === "explorer-apps")
        .map((e) => ({ id: e.id, title: e.title }));

    const report: SeedReport = {
        explorerAppsCount: explorerApps.length,
        ecosystemCount: ecosystemEntries.length,
        mergedCount: entries.length,
        matches,
        creates,
        explorerAppsOnly,
        mismatches,
        skipped,
    };

    return { entries, report };
}

/**
 * Format the report as a human-readable Markdown document. Co-located
 * with the builder so the CLI does not duplicate formatting and tests can
 * assert structure without re-implementing it. Named `formatReport`
 * (not `render*`) on purpose so eslint's testing-library naming
 * convention does not mistake it for a React render helper.
 */
export function formatReport(report: SeedReport): string {
    const lines: string[] = [];
    lines.push("# Seed migration report");
    lines.push("");
    lines.push("## Counts");
    lines.push("");
    lines.push(`- explorer-apps source entries: ${report.explorerAppsCount}`);
    lines.push(`- ecosystem-map source entries: ${report.ecosystemCount}`);
    lines.push(`- merged seed entries: ${report.mergedCount}`);
    lines.push(`- matches (present in both): ${report.matches.length}`);
    lines.push(`- creates (ecosystem-map only): ${report.creates.length}`);
    lines.push(`- explorer-apps only (untouched): ${report.explorerAppsOnly.length}`);
    lines.push(`- mismatches detected: ${report.mismatches.length}`);
    lines.push(`- skipped (invalid input): ${report.skipped.length}`);
    lines.push("");

    lines.push("## Matches");
    lines.push("");
    if (report.matches.length === 0) {
        lines.push("_None._");
    } else {
        for (const m of report.matches) {
            lines.push(`- \`${m.id}\` → section \`${m.ecosystemSection}\``);
        }
    }
    lines.push("");

    lines.push("## Creates (new entries from ecosystem-map)");
    lines.push("");
    if (report.creates.length === 0) {
        lines.push("_None._");
    } else {
        for (const c of report.creates) {
            lines.push(`- \`${c.id}\` (${c.title}) → section \`${c.ecosystemSection}\``);
        }
    }
    lines.push("");

    lines.push("## Mismatches (explorer-apps wins; review required)");
    lines.push("");
    if (report.mismatches.length === 0) {
        lines.push("_None._");
    } else {
        lines.push("| id | field | explorer-apps | ecosystem-map |");
        lines.push("| --- | --- | --- | --- |");
        for (const m of report.mismatches) {
            lines.push(
                `| \`${m.id}\` | ${m.field} | ${m.explorerApps ?? ""} | ${m.ecosystemMap ?? ""} |`,
            );
        }
    }
    lines.push("");

    lines.push("## Skipped (invalid — needs human attention)");
    lines.push("");
    if (report.skipped.length === 0) {
        lines.push("_None._");
    } else {
        for (const s of report.skipped) {
            lines.push(`- [${s.source}] \`${s.identifier}\` — ${s.reason}`);
        }
    }
    lines.push("");

    return lines.join("\n");
}
