import { __resetEnvCacheForTests, isSubmissionsConfigured } from "../env";

/**
 * `isSubmissionsConfigured()` backs `GET /api/config`, which the static
 * frontend uses to decide between the in-app submission form and the Airtable
 * fallback. The only required-without-default env fields are the three Slack
 * vars, so this is effectively a "is Slack configured?" probe.
 */
const SLACK_KEYS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_APPROVAL_CHANNEL"] as const;

describe("isSubmissionsConfigured", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of SLACK_KEYS) {
            saved[key] = process.env[key];
        }
        __resetEnvCacheForTests();
    });

    afterEach(() => {
        for (const key of SLACK_KEYS) {
            if (saved[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = saved[key];
            }
        }
        __resetEnvCacheForTests();
    });

    test("returns false when the Slack env vars are absent", () => {
        for (const key of SLACK_KEYS) {
            delete process.env[key];
        }
        expect(isSubmissionsConfigured()).toBe(false);
    });

    test("returns false when a Slack var is present but invalid", () => {
        process.env.SLACK_BOT_TOKEN = "not-an-xoxb-token";
        process.env.SLACK_SIGNING_SECRET = "x".repeat(32);
        process.env.SLACK_APPROVAL_CHANNEL = "C01234ABCD";
        expect(isSubmissionsConfigured()).toBe(false);
    });

    test("returns true when the Slack env vars are present and valid", () => {
        process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
        process.env.SLACK_SIGNING_SECRET = "x".repeat(32);
        process.env.SLACK_APPROVAL_CHANNEL = "C01234ABCD";
        expect(isSubmissionsConfigured()).toBe(true);
    });
});
