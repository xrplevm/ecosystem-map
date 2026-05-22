/**
 * Typed error hierarchy for the submission backend.
 *
 * Each subclass carries a stable string `code` so handlers can map it to an
 * HTTP status without sniffing message text. Messages are safe to log but
 * MUST NOT contain secrets (tokens, signing secrets).
 */

export enum SubmissionErrorCode {
    INVALID_PAYLOAD = "INVALID_PAYLOAD",
    INVALID_LOGO_TYPE = "INVALID_LOGO_TYPE",
    LOGO_TOO_LARGE = "LOGO_TOO_LARGE",
    LOGO_MISSING = "LOGO_MISSING",
    SECTION_INVALID = "SECTION_INVALID",
    UPSTREAM_SLACK = "UPSTREAM_SLACK",
}

export enum SlackVerifyErrorCode {
    MISSING_HEADERS = "MISSING_HEADERS",
    BAD_TIMESTAMP = "BAD_TIMESTAMP",
    TIMESTAMP_EXPIRED = "TIMESTAMP_EXPIRED",
    BAD_SIGNATURE = "BAD_SIGNATURE",
}

export class SubmissionError extends Error {
    public readonly code: SubmissionErrorCode;
    public readonly suggestion?: string;

    constructor(code: SubmissionErrorCode, message: string, suggestion?: string) {
        super(message);
        this.name = "SubmissionError";
        this.code = code;
        this.suggestion = suggestion;
    }
}

export class SlackVerifyError extends Error {
    public readonly code: SlackVerifyErrorCode;

    constructor(code: SlackVerifyErrorCode, message: string) {
        super(message);
        this.name = "SlackVerifyError";
        this.code = code;
    }
}

export class EnvValidationError extends Error {
    public readonly issues: ReadonlyArray<string>;

    constructor(issues: ReadonlyArray<string>) {
        super(`Environment validation failed: ${issues.join("; ")}`);
        this.name = "EnvValidationError";
        this.issues = issues;
    }
}
