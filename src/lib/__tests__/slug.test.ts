import { slugify } from "../slug";

describe("slugify", () => {
    it("kebab-cases simple input", () => {
        expect(slugify("My Dapp")).toBe("my-dapp");
    });

    it("strips diacritics", () => {
        expect(slugify("Façade Über")).toBe("facade-uber");
    });

    it("collapses runs of separators", () => {
        expect(slugify("foo   bar___baz")).toBe("foo-bar-baz");
    });

    it("trims leading and trailing hyphens", () => {
        expect(slugify("---hi---")).toBe("hi");
    });

    it("produces only kebab-safe characters", () => {
        expect(slugify("Crazy!@#$%^&*()_+={}[]|:;\"'<>,.?/")).toBe("crazy");
    });
});
