import { createHmac } from "crypto";

import { SlackVerifyError, SlackVerifyErrorCode } from "../errors";
import { verifySlackSignature } from "../slack";

const SIGNING_SECRET = "x".repeat(32);

function signRequest(rawBody: string, timestamp: string, secret = SIGNING_SECRET): string {
    const base = `v0:${timestamp}:${rawBody}`;
    return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
    const nowSeconds = 1_700_000_000;

    it("accepts a fresh, correctly signed request", () => {
        const rawBody = "payload=%7B%22ok%22%3Atrue%7D";
        const timestamp = String(nowSeconds);
        const signature = signRequest(rawBody, timestamp);
        expect(() =>
            verifySlackSignature({
                rawBody,
                timestamp,
                signature,
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        ).not.toThrow();
    });

    it("rejects a tampered body", () => {
        const timestamp = String(nowSeconds);
        const signature = signRequest("original", timestamp);
        expect(() =>
            verifySlackSignature({
                rawBody: "tampered",
                timestamp,
                signature,
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        ).toThrow(SlackVerifyError);
    });

    it("rejects a signature with the wrong secret", () => {
        const rawBody = "payload=x";
        const timestamp = String(nowSeconds);
        const signature = signRequest(rawBody, timestamp, "y".repeat(32));
        const err = captureError(() =>
            verifySlackSignature({
                rawBody,
                timestamp,
                signature,
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        );
        expect(err).toBeInstanceOf(SlackVerifyError);
        expect((err as SlackVerifyError).code).toBe(SlackVerifyErrorCode.BAD_SIGNATURE);
    });

    it("rejects timestamps older than the replay window", () => {
        const rawBody = "payload=x";
        const oldTimestamp = String(nowSeconds - 6 * 60); // 6 minutes ago
        const signature = signRequest(rawBody, oldTimestamp);
        const err = captureError(() =>
            verifySlackSignature({
                rawBody,
                timestamp: oldTimestamp,
                signature,
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        );
        expect(err).toBeInstanceOf(SlackVerifyError);
        expect((err as SlackVerifyError).code).toBe(SlackVerifyErrorCode.TIMESTAMP_EXPIRED);
    });

    it("rejects timestamps that drift into the future", () => {
        const rawBody = "payload=x";
        const futureTimestamp = String(nowSeconds + 6 * 60);
        const signature = signRequest(rawBody, futureTimestamp);
        const err = captureError(() =>
            verifySlackSignature({
                rawBody,
                timestamp: futureTimestamp,
                signature,
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        );
        expect(err).toBeInstanceOf(SlackVerifyError);
        expect((err as SlackVerifyError).code).toBe(SlackVerifyErrorCode.TIMESTAMP_EXPIRED);
    });

    it("rejects non-numeric timestamps", () => {
        const rawBody = "payload=x";
        const err = captureError(() =>
            verifySlackSignature({
                rawBody,
                timestamp: "not-a-number",
                signature: signRequest(rawBody, "not-a-number"),
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        );
        expect(err).toBeInstanceOf(SlackVerifyError);
        expect((err as SlackVerifyError).code).toBe(SlackVerifyErrorCode.BAD_TIMESTAMP);
    });

    it("rejects missing headers", () => {
        const err = captureError(() =>
            verifySlackSignature({
                rawBody: "x",
                timestamp: "",
                signature: "",
                signingSecret: SIGNING_SECRET,
                nowSeconds,
            }),
        );
        expect(err).toBeInstanceOf(SlackVerifyError);
        expect((err as SlackVerifyError).code).toBe(SlackVerifyErrorCode.MISSING_HEADERS);
    });
});

function captureError(fn: () => void): unknown {
    try {
        fn();
        return undefined;
    } catch (err) {
        return err;
    }
}
