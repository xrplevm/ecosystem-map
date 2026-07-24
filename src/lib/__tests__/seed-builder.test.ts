/**
 * Tests for the phase-7h migration seed builder.
 *
 * Test file lives under `src/lib/__tests__/` rather than the
 * `scripts/__tests__/` path the briefing suggested because react-scripts
 * pins Jest's `roots` to `<rootDir>/src` and does not allow that key in
 * the CRA-allowed Jest overrides. The builder module itself stays in
 * `scripts/lib/` (where the CLI consumes it) and is imported here via
 * relative path.
 */
import {
    buildSeed,
    normalizeUrl,
    formatReport,
    type EcosystemEntryInput,
    type ExplorerAppsEntryInput,
} from "../../../scripts/lib/seed-builder";

const fixtureExplorerApps: ExplorerAppsEntryInput[] = [
    {
        id: "metamask",
        external: true,
        title: "MetaMask",
        logo: "https://example.com/logos/metamask.png",
        shortDescription: "Self-custodial wallet.",
        categories: ["Wallet"],
        author: "ConsenSys",
        url: "https://metamask.io/",
        description: "MetaMask is a self-custodial wallet.",
        site: "https://metamask.io/",
        github: "https://github.com/MetaMask/metamask-extension",
    },
    {
        id: "axelar",
        external: true,
        title: "Axelar",
        logo: "https://example.com/logos/axelar.png",
        shortDescription: "Cross-chain bridge.",
        categories: ["Bridge"],
        author: "Axelar Network",
        url: "https://axelar.network/",
        description: "Cross-chain communication.",
        site: "https://axelar.network/",
    },
    {
        id: "garbage",
        // Missing url + title on purpose to exercise the skip path.
    } as ExplorerAppsEntryInput,
];

const fixtureEcosystem: EcosystemEntryInput[] = [
    {
        slug: "metamask",
        name: "MetaMask",
        section: "wallets",
        url: "https://metamask.io",
        logoFile: "metamask.png",
    },
    {
        slug: "axelar",
        name: "Axelar Bridge", // title mismatch on purpose
        section: "bridges",
        url: "https://axelar.network/different", // url mismatch on purpose
        logoFile: "axelar.png",
    },
    {
        slug: "fluxprotocol",
        name: "Flux Protocol",
        section: "oracles",
        url: "https://fluxprotocol.org",
        logoFile: "flux.png",
        description: "Decentralized oracle.",
    },
    {
        slug: "joeydao",
        name: "Joey DAO",
        section: "daos",
        url: "https://joeydao.example",
        logoFile: "joey.png",
    },
    {
        slug: "broken",
        name: "",
        section: "dapps",
        url: "",
        logoFile: "broken.png",
    },
];

describe("buildSeed", () => {
    it("merges explorer-apps and ecosystem-map by id with expected counts", () => {
        const { entries, report } = buildSeed(fixtureExplorerApps, fixtureEcosystem);

        // 2 valid explorer-apps + 2 ecosystem-only creates = 4 merged.
        // The third explorer-apps entry is skipped (no id/title/url).
        // The "broken" ecosystem entry is skipped (no name/url).
        expect(entries).toHaveLength(4);
        expect(report.explorerAppsCount).toBe(3);
        expect(report.ecosystemCount).toBe(5);
        expect(report.mergedCount).toBe(4);
        expect(report.matches).toHaveLength(2);
        expect(report.creates).toHaveLength(2);
        expect(report.skipped).toHaveLength(2);
    });

    it("attaches ecosystem-map surface and ecosystemSection on matched ids", () => {
        const { entries } = buildSeed(fixtureExplorerApps, fixtureEcosystem);

        const metamask = entries.find((e) => e.id === "metamask");
        expect(metamask).toBeDefined();
        expect(metamask?.surfaces).toEqual(["explorer-apps", "ecosystem-map"]);
        expect(metamask?.ecosystemSection).toBe("wallets");
        // explorer-apps title/url win silently
        expect(metamask?.title).toBe("MetaMask");
        expect(metamask?.url).toBe("https://metamask.io/");
    });

    it("creates fresh entries for ecosystem-map-only ids with derived defaults", () => {
        const { entries } = buildSeed(fixtureExplorerApps, fixtureEcosystem);

        const flux = entries.find((e) => e.id === "fluxprotocol");
        expect(flux).toBeDefined();
        expect(flux?.surfaces).toEqual(["ecosystem-map"]);
        expect(flux?.ecosystemSection).toBe("oracles");
        expect(flux?.categories).toEqual(["Oracles"]);
        expect(flux?.author).toBe("unknown");
        expect(flux?.shortDescription).toBe("Decentralized oracle.");
        expect(flux?.external).toBe(true);
        expect(flux?.logo).toBe(""); // populated by migrate-logos later
    });

    it("reports mismatches when explorer-apps and ecosystem-map disagree", () => {
        const { report } = buildSeed(fixtureExplorerApps, fixtureEcosystem);

        const titleMismatch = report.mismatches.find(
            (m) => m.id === "axelar" && m.field === "title",
        );
        expect(titleMismatch).toEqual({
            id: "axelar",
            field: "title",
            explorerApps: "Axelar",
            ecosystemMap: "Axelar Bridge",
        });

        const urlMismatch = report.mismatches.find(
            (m) => m.id === "axelar" && m.field === "url",
        );
        expect(urlMismatch?.explorerApps).toBe("https://axelar.network/");
        expect(urlMismatch?.ecosystemMap).toBe("https://axelar.network/different");

        // Trailing slash on metamask URL should NOT trigger a mismatch.
        expect(report.mismatches.find((m) => m.id === "metamask")).toBeUndefined();
    });

    it("excludes invalid entries with a recorded reason", () => {
        const { report } = buildSeed(fixtureExplorerApps, fixtureEcosystem);

        const explorerSkip = report.skipped.find((s) => s.source === "explorer-apps");
        expect(explorerSkip?.identifier).toBe("garbage");
        expect(explorerSkip?.reason).toContain("missing required field");

        const ecoSkip = report.skipped.find((s) => s.source === "ecosystem-map");
        expect(ecoSkip?.identifier).toBe("broken");
        expect(ecoSkip?.reason).toContain("missing required field");
    });

    it("preserves explorer-apps surface untouched when no ecosystem-map match exists", () => {
        const { entries, report } = buildSeed(
            [
                {
                    id: "lone",
                    external: true,
                    title: "Lone",
                    logo: "https://x.example/lone.png",
                    shortDescription: "alone",
                    categories: ["Tools"],
                    author: "x",
                    url: "https://lone.example",
                    description: "lone",
                    site: "https://lone.example",
                },
            ],
            [],
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].surfaces).toEqual(["explorer-apps"]);
        expect(entries[0].ecosystemSection).toBeUndefined();
        expect(report.explorerAppsOnly).toEqual([{ id: "lone", title: "Lone" }]);
    });
});

describe("normalizeUrl", () => {
    it("treats trailing slash differences as equal", () => {
        expect(normalizeUrl("https://Example.com/")).toBe(normalizeUrl("https://example.com"));
    });

    it("returns empty string for empty input", () => {
        expect(normalizeUrl("")).toBe("");
        expect(normalizeUrl(undefined)).toBe("");
    });

    it("falls back to lowercased trim on unparseable input", () => {
        expect(normalizeUrl("  NOT-A-URL ")).toBe("not-a-url");
    });
});

describe("formatReport", () => {
    it("includes counts and section headers", () => {
        const { report } = buildSeed(fixtureExplorerApps, fixtureEcosystem);
        const markdown = formatReport(report);
        expect(markdown).toContain("# Seed migration report");
        expect(markdown).toContain("## Counts");
        expect(markdown).toContain("## Matches");
        expect(markdown).toContain("## Creates (new entries from ecosystem-map)");
        expect(markdown).toContain("## Mismatches");
        expect(markdown).toContain("## Skipped");
        expect(markdown).toContain("merged seed entries: 4");
    });
});
