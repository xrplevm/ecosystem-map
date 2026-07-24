import type { VercelRequest, VercelResponse } from "@vercel/node";

import { isSubmissionsConfigured } from "../src/lib/env";

/**
 * GET /api/config — public capability probe for the static frontend.
 *
 * The CRA bundle can't read server-only env vars (SLACK_BOT_TOKEN et al.), so
 * it asks here whether the in-app submission flow is usable. When Slack isn't
 * configured, `submissionsEnabled` is false and the frontend routes the
 * "Submit your project" CTA to the public Airtable form instead of opening the
 * in-app modal — whose POST to `/api/submit` would be guaranteed to fail.
 *
 * No secrets are ever returned: the response is a single boolean.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED" });
        return;
    }
    res.status(200).json({ ok: true, submissionsEnabled: isSubmissionsConfigured() });
}

function setCorsHeaders(res: VercelResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
}
