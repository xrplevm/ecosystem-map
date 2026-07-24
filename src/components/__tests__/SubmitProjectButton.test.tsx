import React from "react";
import { render, screen } from "@testing-library/react";

import SubmitProjectButton from "../SubmitProjectButton";

/**
 * The button asks `GET /api/config` whether the in-app submission flow is
 * usable (Slack configured server-side). When it isn't — or while the probe
 * is in flight, or if it fails — the primary CTA must link straight to the
 * public Airtable form instead of opening the modal.
 */
function mockConfig(submissionsEnabled: boolean): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true, submissionsEnabled }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }),
    );
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("SubmitProjectButton", () => {
    test("links straight to Airtable when submissions are disabled", async () => {
        mockConfig(false);
        render(<SubmitProjectButton />);

        const cta = await screen.findByRole("link", { name: /submit your project/i });
        expect(cta).toHaveAttribute("href", expect.stringContaining("airtable.com"));
        // No redundant secondary "Or submit via Airtable" link in this mode.
        expect(screen.queryByText(/or submit via/i)).not.toBeInTheDocument();
    });

    test("opens the in-app form when submissions are enabled", async () => {
        mockConfig(true);
        render(<SubmitProjectButton />);

        // Primary CTA becomes a real button (opens the modal), and the
        // secondary Airtable link is shown underneath.
        const cta = await screen.findByRole("button", { name: /submit your project/i });
        expect(cta).toBeInTheDocument();
        expect(screen.getByText(/or submit via/i)).toBeInTheDocument();
    });

    test("falls back to the Airtable link when the config probe fails", async () => {
        jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
        render(<SubmitProjectButton />);

        const cta = await screen.findByRole("link", { name: /submit your project/i });
        expect(cta).toHaveAttribute("href", expect.stringContaining("airtable.com"));
    });
});
