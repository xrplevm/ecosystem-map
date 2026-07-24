import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import App from "./App";
import { SECTIONS } from "./data/sections";

function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
    } as unknown as Response;
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url ?? String(input);
}

/**
 * `SubmitProjectButton` probes `GET /api/config` on mount to learn whether the
 * in-app submission flow is usable. These App-level tests exercise the
 * fully-configured (enabled) path — the disabled/Airtable path is covered in
 * `components/__tests__/SubmitProjectButton.test.tsx` — so the config mock
 * always reports `submissionsEnabled: true`. Registry fetches fall through to
 * the caller-supplied behaviour.
 */
beforeEach(() => {
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: jest.fn((input: RequestInfo | URL) => {
            if (requestUrl(input).includes("/api/config")) {
                return Promise.resolve(jsonResponse({ ok: true, submissionsEnabled: true }));
            }
            return Promise.resolve(jsonResponse([]));
        }),
    });
});

afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).fetch;
});

test("renders every section title from the data model", async () => {
    render(<App />);
    for (const section of SECTIONS) {
        expect(await screen.findByText(section.title)).toBeInTheDocument();
    }
});

test("renders the Submit your project CTA in the footer", async () => {
    render(<App />);
    const cta = await screen.findByRole("button", { name: /submit your project/i });
    expect(cta).toBeInTheDocument();
});

test("keeps the Airtable submission link as a fallback in the footer", async () => {
    render(<App />);
    const airtableLink = await screen.findByRole("link", { name: /airtable/i });
    expect(airtableLink).toHaveAttribute("href", "https://airtable.com/appDFL9N9MDWj0Ywd/shrl5nsqAhtghUN8I");
});

test("falls back to the bundled snapshot when the remote fetch fails", async () => {
    // Routed by URL rather than call order: the /api/config probe and the
    // registry loads fire together on mount, so a positional mock would be
    // racy. Any remote registry fetch fails; the bundled snapshot succeeds.
    const snapshot = jsonResponse([
        {
            id: "demo",
            external: true,
            title: "Demo dApp",
            logo: "https://example.com/demo.png",
            shortDescription: "demo",
            categories: ["dApp"],
            author: "demo",
            url: "https://example.com",
            surfaces: ["explorer-apps", "ecosystem-map"],
            ecosystemSection: "dapps",
        },
    ]);
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/config")) {
            return Promise.resolve(jsonResponse({ ok: true, submissionsEnabled: true }));
        }
        if (url.includes("explorer-apps.snapshot.json")) {
            return Promise.resolve(snapshot);
        }
        // Any configured remote registry URL fails, forcing the snapshot path.
        return Promise.resolve(jsonResponse({}, false));
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchMock });

    render(<App />);

    await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/bundled snapshot/i);
    });
    expect(screen.getByAltText("Demo dApp")).toBeInTheDocument();
});
