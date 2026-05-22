import {
    assertUniqueIds,
    DuplicateIdError,
    ExplorerAppParseError,
    explorerAppSchema,
    parseExplorerApp,
    parseExplorerAppsArray,
    safeParseExplorerApp,
    type ExplorerAppInput,
    type ExplorerAppParsed,
} from "../explorer-app";

const baseEntry: ExplorerAppInput = {
    id: "acme-defi",
    external: true,
    title: "Acme DeFi",
    logo: "https://cdn.example.com/logos/acme.png",
    shortDescription: "Decentralized lending on XRPL EVM.",
    categories: ["defi"],
    author: "Acme Labs",
    url: "https://acme.example.com",
};

describe("explorerAppSchema", () => {
    it("accepts a minimal entry and applies the surfaces default", () => {
        const parsed = explorerAppSchema.parse(baseEntry);
        expect(parsed.surfaces).toEqual(["explorer-apps"]);
        expect(parsed.ecosystemSection).toBeUndefined();
        expect(parsed.id).toBe("acme-defi");
    });

    it("preserves an explicit surfaces list", () => {
        const parsed = explorerAppSchema.parse({
            ...baseEntry,
            surfaces: ["explorer-apps", "ecosystem-map"],
            ecosystemSection: "defi",
        });
        expect(parsed.surfaces).toEqual(["explorer-apps", "ecosystem-map"]);
        expect(parsed.ecosystemSection).toBe("defi");
    });

    it("rejects ecosystem-map surface without ecosystemSection", () => {
        const result = explorerAppSchema.safeParse({
            ...baseEntry,
            surfaces: ["ecosystem-map"],
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        const issue = result.error.errors.find((e) => e.path.join(".") === "ecosystemSection");
        expect(issue).toBeDefined();
        expect(issue?.message).toMatch(/ecosystem-map/);
    });

    it("rejects non-https url", () => {
        const result = explorerAppSchema.safeParse({
            ...baseEntry,
            url: "http://acme.example.com",
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.errors.some((e) => e.path.join(".") === "url")).toBe(true);
    });

    it("rejects non-slug id", () => {
        const result = explorerAppSchema.safeParse({
            ...baseEntry,
            id: "Acme DeFi!",
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.errors.some((e) => e.path.join(".") === "id")).toBe(true);
    });

    it("rejects empty categories", () => {
        const result = explorerAppSchema.safeParse({ ...baseEntry, categories: [] });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.errors.some((e) => e.path.join(".") === "categories")).toBe(true);
    });

    it("rejects more than 10 categories", () => {
        const result = explorerAppSchema.safeParse({
            ...baseEntry,
            categories: Array.from({ length: 11 }, (_, i) => `cat-${i}`),
        });
        expect(result.success).toBe(false);
    });
});

describe("parseExplorerApp", () => {
    it("returns the parsed value on success", () => {
        const parsed: ExplorerAppParsed = parseExplorerApp(baseEntry);
        expect(parsed.title).toBe("Acme DeFi");
    });

    it("throws ExplorerAppParseError with friendly message on failure", () => {
        expect.assertions(3);
        try {
            parseExplorerApp({ ...baseEntry, url: "ftp://nope" });
        } catch (err) {
            expect(err).toBeInstanceOf(ExplorerAppParseError);
            const message = (err as Error).message;
            expect(message).toContain("url");
            expect(message).toMatch(/invalid|valid|https/i);
        }
    });
});

describe("safeParseExplorerApp", () => {
    it("returns ok:true on success", () => {
        const result = safeParseExplorerApp(baseEntry);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.id).toBe("acme-defi");
    });

    it("returns ok:false with formatted error on failure", () => {
        const result = safeParseExplorerApp({ ...baseEntry, id: "BAD" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain("id");
    });
});

describe("parseExplorerAppsArray", () => {
    it("parses an array of valid entries", () => {
        const parsed = parseExplorerAppsArray([
            baseEntry,
            { ...baseEntry, id: "second" },
            { ...baseEntry, id: "third", surfaces: ["ecosystem-map"], ecosystemSection: "defi" },
        ]);
        expect(parsed).toHaveLength(3);
        expect(parsed[0].surfaces).toEqual(["explorer-apps"]);
        expect(parsed[2].ecosystemSection).toBe("defi");
    });

    it("throws ExplorerAppParseError pointing at the bad index", () => {
        expect.assertions(2);
        try {
            parseExplorerAppsArray([baseEntry, { ...baseEntry, id: "Bad Id" }]);
        } catch (err) {
            expect(err).toBeInstanceOf(ExplorerAppParseError);
            expect((err as Error).message).toContain("1.id");
        }
    });
});

describe("assertUniqueIds", () => {
    const a = parseExplorerApp(baseEntry);
    const b = parseExplorerApp({ ...baseEntry, id: "second" });

    it("does not throw when all ids are unique", () => {
        expect(() => assertUniqueIds([a, b])).not.toThrow();
    });

    it("throws DuplicateIdError listing every duplicate", () => {
        expect.assertions(2);
        const dupA = parseExplorerApp(baseEntry);
        const dupB = parseExplorerApp({ ...baseEntry, id: "second" });
        try {
            assertUniqueIds([a, b, dupA, dupB]);
        } catch (err) {
            expect(err).toBeInstanceOf(DuplicateIdError);
            expect((err as DuplicateIdError).duplicates).toEqual(
                expect.arrayContaining(["acme-defi", "second"]),
            );
        }
    });
});
