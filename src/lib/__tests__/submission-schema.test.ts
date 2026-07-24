import { SubmissionSchema, SUBMISSION_LIMITS } from "../schemas/submission";

const VALID_BASE = {
    name: "My Dapp",
    section: "dapps",
    url: "https://my.dapp/",
    description: "A short, helpful description.",
    longDescription: "A longer paragraph describing the project.",
    categories: ["DeFi"],
    author: "My Org",
    site: "https://my.dapp/",
    github: "https://github.com/my-org/my-dapp",
    submitterEmail: "owner@example.com",
    submitterName: "Owner",
};

describe("SubmissionSchema", () => {
    it("accepts a complete valid payload", () => {
        const result = SubmissionSchema.safeParse(VALID_BASE);
        expect(result.success).toBe(true);
    });

    it("accepts a minimal payload with only the required ecosystem-map fields", () => {
        const result = SubmissionSchema.safeParse({
            name: "Minimal",
            section: "wallets",
            url: "https://minimal.example/",
            submitterEmail: "minimal@example.com",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.longDescription).toBeUndefined();
            expect(result.data.categories).toBeUndefined();
            expect(result.data.author).toBeUndefined();
            expect(result.data.site).toBeUndefined();
            expect(result.data.github).toBeUndefined();
        }
    });

    it("rejects non-https URLs", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, url: "http://insecure.example/" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path[0] === "url")).toBe(true);
        }
    });

    it("rejects malformed URLs", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, url: "not a url" });
        expect(result.success).toBe(false);
    });

    it("rejects unknown sections", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, section: "not-real" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path[0] === "section")).toBe(true);
        }
    });

    it("rejects empty name", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, name: "   " });
        expect(result.success).toBe(false);
    });

    it("rejects description longer than the limit", () => {
        const tooLong = "x".repeat(SUBMISSION_LIMITS.DESCRIPTION_MAX + 1);
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, description: tooLong });
        expect(result.success).toBe(false);
    });

    it("accepts the longest shortDescription currently in the explorer-apps registry (geochain, 292 chars)", () => {
        // Verbatim copy of `apps[id=geochain].shortDescription` from the
        // downstream `mainnet-explorer-dapps/explorer-apps.json` snapshot.
        // This is a regression guard: bumping DESCRIPTION_MAX below 292
        // would reject submissions that simply reproduce an entry the
        // canonical registry already accepts.
        const geochainShortDescription =
            "GeoChain is an innovative, onchain marketplace that brings transparency, security, and instant settlement to the geospatial data economy. By leveraging the XRPL EVM Sidechain, GeoChain combines EVM compatibility for smart contracts with the speed, low fees, and reliability of the XRP Ledger.";
        expect(geochainShortDescription.length).toBe(292);
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, description: geochainShortDescription });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.description).toBe(geochainShortDescription);
        }
    });

    it("rejects malformed submitterEmail", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, submitterEmail: "not-an-email" });
        expect(result.success).toBe(false);
    });

    it("treats empty description as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, description: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.description).toBeUndefined();
        }
    });

    it("treats empty submitterName as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, submitterName: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.submitterName).toBeUndefined();
        }
    });

    it("rejects longDescription longer than the limit", () => {
        const tooLong = "x".repeat(SUBMISSION_LIMITS.LONG_DESCRIPTION_MAX + 1);
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, longDescription: tooLong });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path[0] === "longDescription")).toBe(true);
        }
    });

    it("treats empty longDescription as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, longDescription: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.longDescription).toBeUndefined();
        }
    });

    it("rejects categories not in the allowlist", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, categories: ["NotARealCategory"] });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path[0] === "categories")).toBe(true);
        }
    });

    it("treats an empty categories array as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, categories: [] });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.categories).toBeUndefined();
        }
    });

    it("rejects more categories than the configured maximum", () => {
        const tooMany = Array.from({ length: SUBMISSION_LIMITS.CATEGORIES_MAX + 1 }, () => "DeFi");
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, categories: tooMany });
        expect(result.success).toBe(false);
    });

    it("accepts multiple valid categories", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, categories: ["DeFi", "RWA"] });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.categories).toEqual(["DeFi", "RWA"]);
        }
    });

    it("treats empty author as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, author: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.author).toBeUndefined();
        }
    });

    it("rejects author longer than the limit", () => {
        const tooLong = "x".repeat(SUBMISSION_LIMITS.AUTHOR_MAX + 1);
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, author: tooLong });
        expect(result.success).toBe(false);
    });

    it("rejects non-https site", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, site: "http://insecure.example/" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.path[0] === "site")).toBe(true);
        }
    });

    it("treats empty site as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, site: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.site).toBeUndefined();
        }
    });

    it("treats empty github as undefined", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, github: "" });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.github).toBeUndefined();
        }
    });

    it("rejects malformed github URL", () => {
        const result = SubmissionSchema.safeParse({ ...VALID_BASE, github: "not a url" });
        expect(result.success).toBe(false);
    });
});
