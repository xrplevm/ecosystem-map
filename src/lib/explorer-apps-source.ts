import type { ExplorerApp, ExplorerAppSurface, ExplorerAppsJson } from "./explorer-apps-types";
import type { SectionId } from "../data/types";

/**
 * Browser-side loader for the canonical `explorer-apps.json` registry.
 * Used by the ecosystem-map and the in-app explorer-apps surface.
 *
 * Strategy:
 *  1. resolve the remote URL from an explicit `remoteUrl` override or the
 *     `REACT_APP_EXPLORER_APPS_URL` env var.
 *  2. if a remote URL is configured, fetch it; on network/parse failure
 *     fall back to the bundled snapshot in `public/explorer-apps.snapshot.json`.
 *  3. if no remote URL is configured (the env var is unset), serve the
 *     bundled snapshot directly — it is the local source of truth.
 *  4. if the snapshot also fails, throw a typed error so the UI can render
 *     a degraded state with a retry affordance.
 *
 * There is intentionally no hardcoded default bucket: an unset
 * `REACT_APP_EXPLORER_APPS_URL` means "use the local snapshot".
 */

const SNAPSHOT_URL = "/explorer-apps.snapshot.json";

const DEFAULT_SURFACES: ExplorerAppSurface[] = ["explorer-apps"];

export type LoadSource = "remote" | "snapshot";

export interface LoadOptions {
    /** Append `?ts=<now>` to the remote URL to bypass any CDN/edge cache. */
    bypassCache?: boolean;
    /** Override fetch (tests). Defaults to `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
    /** Override the remote URL (tests / deploy). */
    remoteUrl?: string;
}

export interface LoadResult {
    apps: ExplorerApp[];
    source: LoadSource;
}

export class ExplorerAppsLoadError extends Error {
    public readonly remoteCause?: unknown;
    public readonly snapshotCause?: unknown;

    constructor(message: string, remoteCause?: unknown, snapshotCause?: unknown) {
        super(message);
        this.name = "ExplorerAppsLoadError";
        this.remoteCause = remoteCause;
        this.snapshotCause = snapshotCause;
    }
}

/**
 * Resolve the configured remote registry URL, or `null` when none is set.
 *
 * Precedence: explicit `override` (tests / deploy) → `REACT_APP_EXPLORER_APPS_URL`
 * → none. Returning `null` is meaningful: the loader serves the bundled local
 * snapshot instead of reaching out to a hardcoded bucket, so the in-repo
 * `public/explorer-apps.snapshot.json` is the source of truth for local dev and
 * any deploy that does not set the env var.
 */
function getRemoteUrl(override?: string): string | null {
    if (override) {
        return override;
    }
    // CRA inlines `process.env.REACT_APP_*` at build time; reading it
    // through this guarded form avoids a ReferenceError on environments
    // (Node test runner) where `process` is shimmed but the var is unset.
    const fromEnv = typeof process !== "undefined" ? process.env?.REACT_APP_EXPLORER_APPS_URL : undefined;
    return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

function withCacheBuster(url: string): string {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}ts=${Date.now()}`;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
    const response = await fetchImpl(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return (await response.json()) as unknown;
}

function assertExplorerAppsJson(value: unknown): asserts value is ExplorerAppsJson {
    if (!Array.isArray(value)) {
        throw new Error("expected JSON array");
    }
    // Lightweight runtime guard. The full Zod schema lives in
    // `src/lib/schemas/` (sub-task D); we deliberately avoid coupling the
    // consumer to that schema so the loader stays usable even if entries
    // gain optional fields the schema does not yet know about.
    for (const item of value) {
        if (item === null || typeof item !== "object") {
            throw new Error("expected each entry to be an object");
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.url !== "string") {
            throw new Error("entry missing required string fields (id/title/url)");
        }
    }
}

/**
 * Load the registry. When a remote URL is configured (via `remoteUrl` or
 * `REACT_APP_EXPLORER_APPS_URL`) it is fetched first, falling back to the
 * bundled snapshot on failure. When no remote URL is configured the bundled
 * snapshot is served directly. Resolves to `{ apps, source }` so callers can
 * show a "stale data" notice when `source === "snapshot"`.
 */
export async function loadExplorerApps(options: LoadOptions = {}): Promise<LoadResult> {
    const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchImpl) {
        throw new ExplorerAppsLoadError("fetch is unavailable in this environment");
    }

    const remoteBase = getRemoteUrl(options.remoteUrl);

    // No remote configured (no override, no REACT_APP_EXPLORER_APPS_URL):
    // serve the bundled local snapshot directly rather than a hardcoded bucket.
    if (remoteBase === null) {
        return loadSnapshot(fetchImpl);
    }

    const remoteUrl = options.bypassCache ? withCacheBuster(remoteBase) : remoteBase;

    let remoteCause: unknown;
    try {
        const json = await fetchJson(remoteUrl, fetchImpl);
        assertExplorerAppsJson(json);
        return { apps: json, source: "remote" };
    } catch (error) {
        remoteCause = error;
    }

    return loadSnapshot(fetchImpl, remoteCause);
}

/**
 * Load and validate the bundled snapshot. `remoteCause` is threaded through
 * (when present) so a combined failure carries both the remote and snapshot
 * errors; when absent the snapshot was the primary source.
 */
async function loadSnapshot(fetchImpl: typeof fetch, remoteCause?: unknown): Promise<LoadResult> {
    try {
        const json = await fetchJson(SNAPSHOT_URL, fetchImpl);
        assertExplorerAppsJson(json);
        return { apps: json, source: "snapshot" };
    } catch (snapshotCause) {
        throw new ExplorerAppsLoadError(
            remoteCause === undefined
                ? "Failed to load explorer-apps.json from the bundled snapshot"
                : "Failed to load explorer-apps.json from S3 and from the bundled snapshot",
            remoteCause,
            snapshotCause,
        );
    }
}

function surfacesOf(app: ExplorerApp): ExplorerAppSurface[] {
    return app.surfaces ?? DEFAULT_SURFACES;
}

/**
 * Filter to the subset that should appear inside the in-app explorer-apps
 * registry view. Defaults to `["explorer-apps"]` when an entry omits the
 * field, so the historical 70-entry corpus keeps showing.
 */
export function filterExplorerApps(apps: ExplorerApp[]): ExplorerApp[] {
    return apps.filter((app) => surfacesOf(app).includes("explorer-apps"));
}

/**
 * Group entries that opted in to `surfaces: [..., "ecosystem-map"]` by
 * their `ecosystemSection`. Entries that target the ecosystem map but
 * omit the section are skipped with a `console.warn` — silently dropping
 * them would mask migration mistakes; throwing would tank the page for
 * one bad row.
 *
 * Returned map preserves insertion order so callers can iterate alongside
 * the canonical `SECTIONS` array without re-sorting.
 */
export function groupByEcosystemSection(apps: ExplorerApp[]): Map<SectionId, ExplorerApp[]> {
    const grouped = new Map<SectionId, ExplorerApp[]>();
    for (const app of apps) {
        if (!surfacesOf(app).includes("ecosystem-map")) {
            continue;
        }
        const section = app.ecosystemSection;
        if (!section) {
            // eslint-disable-next-line no-console
            console.warn(
                `[explorer-apps-source] entry "${app.id}" opted into the ecosystem-map surface but is missing ecosystemSection; skipping.`,
            );
            continue;
        }
        const sectionId = section as SectionId;
        const bucket = grouped.get(sectionId) ?? [];
        bucket.push(app);
        grouped.set(sectionId, bucket);
    }
    return grouped;
}
