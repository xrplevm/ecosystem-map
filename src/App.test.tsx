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

beforeEach(() => {
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: jest.fn().mockResolvedValue(jsonResponse([])),
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
    const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, false))
        .mockResolvedValueOnce(
            jsonResponse([
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
            ]),
        );
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchMock });

    render(<App />);

    await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/bundled snapshot/i);
    });
    expect(screen.getByAltText("Demo dApp")).toBeInTheDocument();
});
