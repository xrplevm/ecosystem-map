import {
    ExplorerAppsLoadError,
    filterExplorerApps,
    groupByEcosystemSection,
    loadExplorerApps,
} from "../explorer-apps-source";
import type { ExplorerApp } from "../explorer-apps-types";

const VALID_REMOTE_URL = "https://example.test/explorer-apps.json";

const minimalEntry = (overrides: Partial<ExplorerApp>): ExplorerApp => ({
    id: "demo",
    external: true,
    title: "Demo",
    logo: "https://example.com/demo.png",
    shortDescription: "demo",
    categories: ["dApp"],
    author: "demo",
    url: "https://example.com",
    ...overrides,
});

function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
    } as unknown as Response;
}

describe("loadExplorerApps", () => {
    test("returns the remote payload on the happy path", async () => {
        const apps = [minimalEntry({})];
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(apps));

        const result = await loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL });

        expect(result.source).toBe("remote");
        expect(result.apps).toEqual(apps);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(VALID_REMOTE_URL);
    });

    test("appends a cache-buster when bypassCache is set", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([]));

        await loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL, bypassCache: true });

        const calledWith = fetchImpl.mock.calls[0][0] as string;
        expect(calledWith.startsWith(`${VALID_REMOTE_URL}?ts=`)).toBe(true);
    });

    test("falls back to the bundled snapshot when the remote fetch fails", async () => {
        const apps = [minimalEntry({ id: "from-snapshot" })];
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(jsonResponse(apps));

        const result = await loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL });

        expect(result.source).toBe("snapshot");
        expect(result.apps).toEqual(apps);
        expect(fetchImpl).toHaveBeenNthCalledWith(2, "/explorer-apps.snapshot.json");
    });

    test("falls back to snapshot when remote returns an HTTP error", async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse({}, false))
            .mockResolvedValueOnce(jsonResponse([minimalEntry({})]));

        const result = await loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL });

        expect(result.source).toBe("snapshot");
    });

    test("throws ExplorerAppsLoadError when both sources fail", async () => {
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error("remote boom"))
            .mockRejectedValueOnce(new Error("snapshot boom"));

        await expect(loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL })).rejects.toBeInstanceOf(
            ExplorerAppsLoadError,
        );
    });

    test("throws when the response is not an array", async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse({ not: "array" }))
            .mockRejectedValueOnce(new Error("snapshot boom"));

        await expect(loadExplorerApps({ fetchImpl, remoteUrl: VALID_REMOTE_URL })).rejects.toBeInstanceOf(
            ExplorerAppsLoadError,
        );
    });

    describe("when no remote URL is configured", () => {
        const ENV_KEY = "REACT_APP_EXPLORER_APPS_URL";
        let prevEnv: string | undefined;

        beforeEach(() => {
            prevEnv = process.env[ENV_KEY];
            delete process.env[ENV_KEY];
        });

        afterEach(() => {
            if (prevEnv === undefined) {
                delete process.env[ENV_KEY];
            } else {
                process.env[ENV_KEY] = prevEnv;
            }
        });

        test("serves the bundled snapshot directly without hitting any remote", async () => {
            const apps = [minimalEntry({ id: "from-snapshot" })];
            const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(apps));

            const result = await loadExplorerApps({ fetchImpl });

            expect(result.source).toBe("snapshot");
            expect(result.apps).toEqual(apps);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl).toHaveBeenCalledWith("/explorer-apps.snapshot.json");
        });

        test("uses REACT_APP_EXPLORER_APPS_URL as the remote when it is set", async () => {
            process.env[ENV_KEY] = "https://env.test/explorer-apps.json";
            const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([minimalEntry({})]));

            const result = await loadExplorerApps({ fetchImpl });

            expect(result.source).toBe("remote");
            expect(fetchImpl).toHaveBeenCalledWith("https://env.test/explorer-apps.json");
        });

        test("throws ExplorerAppsLoadError when the snapshot itself fails", async () => {
            const fetchImpl = jest.fn().mockRejectedValue(new Error("snapshot boom"));

            await expect(loadExplorerApps({ fetchImpl })).rejects.toBeInstanceOf(ExplorerAppsLoadError);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });
    });
});

describe("groupByEcosystemSection", () => {
    test("groups entries that opt in to the ecosystem-map surface", () => {
        const apps: ExplorerApp[] = [
            minimalEntry({ id: "a", surfaces: ["ecosystem-map"], ecosystemSection: "dapps" }),
            minimalEntry({ id: "b", surfaces: ["ecosystem-map", "explorer-apps"], ecosystemSection: "dapps" }),
            minimalEntry({ id: "c", surfaces: ["ecosystem-map"], ecosystemSection: "wallets" }),
        ];

        const grouped = groupByEcosystemSection(apps);

        expect(grouped.get("dapps")?.map((a) => a.id)).toEqual(["a", "b"]);
        expect(grouped.get("wallets")?.map((a) => a.id)).toEqual(["c"]);
    });

    test("excludes entries without the ecosystem-map surface", () => {
        const apps: ExplorerApp[] = [
            minimalEntry({ id: "explorer-only" }), // default surfaces: ["explorer-apps"]
            minimalEntry({ id: "explorer-only-explicit", surfaces: ["explorer-apps"] }),
        ];

        const grouped = groupByEcosystemSection(apps);

        expect(grouped.size).toBe(0);
    });

    test("warns and skips entries that opt in but omit ecosystemSection", () => {
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            const apps: ExplorerApp[] = [
                minimalEntry({ id: "broken", surfaces: ["ecosystem-map"] }),
            ];

            const grouped = groupByEcosystemSection(apps);

            expect(grouped.size).toBe(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("broken"));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe("filterExplorerApps", () => {
    test("includes entries whose surfaces include explorer-apps (default)", () => {
        const apps: ExplorerApp[] = [
            minimalEntry({ id: "default-surfaces" }),
            minimalEntry({ id: "explicit", surfaces: ["explorer-apps"] }),
            minimalEntry({ id: "ecosystem-only", surfaces: ["ecosystem-map"] }),
        ];

        const result = filterExplorerApps(apps);

        expect(result.map((a) => a.id)).toEqual(["default-surfaces", "explicit"]);
    });
});
