import { useEffect, useState } from "react";

const CONFIG_URL = "/api/config";

export interface SubmissionsEnabledState {
    /** True once the backend confirms the in-app submission flow is usable. */
    enabled: boolean;
    /** True while the probe is in flight; callers should treat it as "not yet". */
    loading: boolean;
}

/**
 * Probes `GET /api/config` once on mount to learn whether the in-app
 * submission form is usable (i.e. Slack is configured server-side).
 *
 * Fail-safe by design: while loading, on a network error, on a non-OK
 * response, or on a body without `submissionsEnabled === true`, `enabled`
 * stays false so the caller falls back to the Airtable link rather than
 * opening a form whose POST would fail.
 */
export function useSubmissionsEnabled(): SubmissionsEnabledState {
    const [state, setState] = useState<SubmissionsEnabledState>({ enabled: false, loading: true });

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            let enabled = false;
            try {
                const res = await fetch(CONFIG_URL, { headers: { Accept: "application/json" } });
                if (res.ok) {
                    const body: unknown = await res.json();
                    enabled =
                        typeof body === "object" &&
                        body !== null &&
                        (body as { submissionsEnabled?: unknown }).submissionsEnabled === true;
                }
            } catch {
                // Network/parse failure → stay disabled (Airtable fallback).
                enabled = false;
            }
            if (!cancelled) {
                setState({ enabled, loading: false });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return state;
}
