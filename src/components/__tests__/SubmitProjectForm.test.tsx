import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SubmitProjectForm from "../SubmitProjectForm";

/**
 * Tests focus on bugs we control:
 * - The form refuses to submit invalid input (URL, email).
 * - Oversized logos are blocked client-side before the fetch.
 * - The exact FormData shape that gets sent to `/api/submit`.
 *
 * `fetch` is mocked because we don't run a real backend in unit tests; the
 * backend's contract is already exercised in `src/lib/__tests__/`.
 */

function pngFile(name: string, sizeBytes: number): File {
    const bytes = new Uint8Array(sizeBytes);
    // Stamp a PNG signature so the file isn't completely opaque.
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([bytes], name, { type: "image/png" });
}

function mockFetchOk(body: unknown): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }),
    );
}

beforeAll(() => {
    if (typeof URL.createObjectURL !== "function") {
        URL.createObjectURL = jest.fn(() => "blob:mock");
        URL.revokeObjectURL = jest.fn();
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

async function fillValidFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText(/project name/i), "Acme Wallet");
    // Section is a custom radio group (Phase 5). Clicking the "Wallets" pill
    // sets `section = "wallets"` — same value the legacy `<select>` produced.
    await user.click(screen.getByRole("radio", { name: /^wallets$/i }));
    await user.clear(screen.getByLabelText(/project url/i));
    await user.type(screen.getByLabelText(/project url/i), "https://acme.example");
    await user.type(screen.getByLabelText(/your email/i), "submitter@example.com");
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']");
    if (fileInput === null) {
        throw new Error("file input not found");
    }
    await user.upload(fileInput, pngFile("logo.png", 1024));
}

async function fillExplorerAppsExtras(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText(/long description/i), "Longer paragraph here.");
    await user.click(screen.getByRole("checkbox", { name: /^tools$/i }));
    await user.type(screen.getByLabelText(/^author$/i), "Acme Inc");
    await user.type(screen.getByLabelText(/marketing site/i), "https://acme.example/about");
    await user.type(screen.getByLabelText(/^github$/i), "https://github.com/acme/wallet");
}

describe("SubmitProjectForm", () => {
    test("renders required and explorer-apps optional fields", () => {
        render(<SubmitProjectForm />);
        expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/section/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/project url/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/^description$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/long description/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/^author$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/marketing site/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/^github$/i)).toBeInTheDocument();
        expect(screen.getByText(/^categories$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/your email/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^submit project$/i })).toBeInTheDocument();
    });

    test("shows a validation error for a non-https URL", async () => {
        const fetchSpy = jest.spyOn(global, "fetch");
        const user = userEvent.setup();
        render(<SubmitProjectForm />);
        await fillValidFields(user);

        await user.clear(screen.getByLabelText(/project url/i));
        await user.type(screen.getByLabelText(/project url/i), "http://insecure.example");

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await screen.findByText(/url must start with https/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("shows a validation error when the email is missing", async () => {
        const fetchSpy = jest.spyOn(global, "fetch");
        const user = userEvent.setup();
        render(<SubmitProjectForm />);
        await fillValidFields(user);
        await user.clear(screen.getByLabelText(/your email/i));

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await screen.findByText(/valid email/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("blocks submit when the logo exceeds 500KB and never calls fetch", async () => {
        const fetchSpy = jest.spyOn(global, "fetch");
        const user = userEvent.setup();
        render(<SubmitProjectForm />);

        await user.type(screen.getByLabelText(/project name/i), "Acme Wallet");
        await user.click(screen.getByRole("radio", { name: /^wallets$/i }));
        await user.type(screen.getByLabelText(/project url/i), "https://acme.example");
        await user.type(screen.getByLabelText(/your email/i), "submitter@example.com");

        const oversize = pngFile("huge.png", 500_001);
        const fileInput = document.querySelector<HTMLInputElement>("input[type='file']");
        if (fileInput === null) {
            throw new Error("file input not found");
        }
        await user.upload(fileInput, oversize);

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await screen.findByText(/500kb or less/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("submits FormData with the expected fields to /api/submit", async () => {
        const fetchSpy = mockFetchOk({ ok: true, submissionId: "sub-1", slug: "acme-wallet" });
        const user = userEvent.setup();
        render(<SubmitProjectForm />);
        await fillValidFields(user);

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe("/api/submit");
        expect(init?.method).toBe("POST");
        const body = init?.body;
        if (!(body instanceof FormData)) {
            throw new Error("body should be FormData");
        }
        expect(body.get("name")).toBe("Acme Wallet");
        expect(body.get("section")).toBe("wallets");
        expect(body.get("url")).toBe("https://acme.example");
        expect(body.get("submitterEmail")).toBe("submitter@example.com");
        const logo = body.get("logo");
        expect(logo).toBeInstanceOf(File);
        expect((logo as File).name).toBe("logo.png");
        // description/submitterName were empty, so they should not appear.
        expect(body.has("description")).toBe(false);
        expect(body.has("submitterName")).toBe(false);

        await screen.findByText(/maintainers review every submission on slack/i);
    });

    test("arrow keys move selection across the section radiogroup", async () => {
        const user = userEvent.setup();
        render(<SubmitProjectForm />);

        // Default selection is the first section ("Wallets").
        const walletsPill = screen.getByRole("radio", { name: /^wallets$/i });
        expect(walletsPill).toHaveAttribute("aria-checked", "true");

        walletsPill.focus();
        await user.keyboard("{ArrowRight}");

        // The next pill in SECTIONS order is "Bridges".
        const bridgesPill = screen.getByRole("radio", { name: /^bridges$/i });
        expect(bridgesPill).toHaveAttribute("aria-checked", "true");
        expect(walletsPill).toHaveAttribute("aria-checked", "false");
    });

    test("description counter updates and flips to the warn tint near the limit", async () => {
        const user = userEvent.setup();
        render(<SubmitProjectForm />);

        const description = screen.getByLabelText(/^description$/i);
        const counter = screen.getByText(/0 \/ 320/);
        expect(counter).toHaveAttribute("data-state", "ok");

        // 275 chars hits the warn threshold (~85% of DESCRIPTION_MAX=320).
        await user.type(description, "a".repeat(275));
        expect(screen.getByText(/275 \/ 320/)).toHaveAttribute("data-state", "warn");
    });

    test("submits explorer-apps extras as repeated category form fields", async () => {
        const fetchSpy = mockFetchOk({ ok: true, submissionId: "sub-2", slug: "acme-wallet" });
        const user = userEvent.setup();
        render(<SubmitProjectForm />);
        await fillValidFields(user);
        await fillExplorerAppsExtras(user);
        // Pick a second category so we exercise the array-encoding path.
        await user.click(screen.getByRole("checkbox", { name: /^defi$/i }));

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        const init = fetchSpy.mock.calls[0][1];
        const body = init?.body;
        if (!(body instanceof FormData)) {
            throw new Error("body should be FormData");
        }
        expect(body.get("longDescription")).toBe("Longer paragraph here.");
        expect(body.get("author")).toBe("Acme Inc");
        expect(body.get("site")).toBe("https://acme.example/about");
        expect(body.get("github")).toBe("https://github.com/acme/wallet");
        // Categories repeat as separate form entries, preserving pick order.
        expect(body.getAll("categories")).toEqual(["Tools", "DeFi"]);
    });

    test("locks the 6th category chip once five are selected", async () => {
        const user = userEvent.setup();
        render(<SubmitProjectForm />);

        // The first five chips in CATEGORY_OPTIONS order (Bridge, DeFi, RWA,
        // NFT, Wallet) — picking them exhausts the cap.
        await user.click(screen.getByRole("checkbox", { name: /^bridge$/i }));
        await user.click(screen.getByRole("checkbox", { name: /^defi$/i }));
        await user.click(screen.getByRole("checkbox", { name: /^rwa$/i }));
        await user.click(screen.getByRole("checkbox", { name: /^nft$/i }));
        await user.click(screen.getByRole("checkbox", { name: /^wallet$/i }));

        const sixth = screen.getByRole("checkbox", { name: /^dao$/i });
        expect(sixth).toBeDisabled();
        expect(sixth).toHaveAttribute("aria-disabled", "true");

        // Clicking a locked chip must NOT add it — a disabled button doesn't
        // fire onClick, but we assert the resulting state to pin the contract.
        await user.click(sixth);
        expect(sixth).toHaveAttribute("aria-checked", "false");
    });

    test("omits explorer-apps extras when the submitter leaves them blank", async () => {
        const fetchSpy = mockFetchOk({ ok: true, submissionId: "sub-3", slug: "acme-wallet" });
        const user = userEvent.setup();
        render(<SubmitProjectForm />);
        await fillValidFields(user);

        await user.click(screen.getByRole("button", { name: /^submit project$/i }));

        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        const init = fetchSpy.mock.calls[0][1];
        const body = init?.body;
        if (!(body instanceof FormData)) {
            throw new Error("body should be FormData");
        }
        expect(body.has("longDescription")).toBe(false);
        expect(body.has("categories")).toBe(false);
        expect(body.has("author")).toBe(false);
        expect(body.has("site")).toBe(false);
        expect(body.has("github")).toBe(false);
    });
});
