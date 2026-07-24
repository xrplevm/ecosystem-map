import type { IncomingHttpHeaders } from "http";
import type { Readable } from "stream";

import Busboy from "busboy";

import { SubmissionError, SubmissionErrorCode } from "./errors";

/**
 * Minimal multipart parser tailored to the submission form.
 *
 * The form has a fixed shape: a handful of small text fields plus a single
 * file field named `logo`. We stream into Busboy, cap the file bytes against
 * `maxFileBytes` to refuse oversize uploads before they ever hit Slack, and
 * return a plain object the handler can validate with Zod.
 */

/**
 * Headroom for the fixed text fields plus up to CATEGORIES_MAX category
 * occurrences and a couple of future-proof slots — anything beyond that
 * is almost certainly malformed and should be rejected.
 */
const MAX_FIELDS = 32;

/**
 * A parsed multipart field. Repeated field names collapse to an array so
 * callers can handle multi-select inputs (e.g. `categories=Bridge` posted
 * once per chosen value) without re-parsing the raw body. Single-value
 * fields stay as plain strings to keep the common case ergonomic.
 */
export type MultipartFieldValue = string | string[];

export interface ParsedMultipart {
    fields: Record<string, MultipartFieldValue>;
    file?: {
        fieldname: string;
        filename: string;
        mimeType: string;
        bytes: Buffer;
    };
}

export async function parseMultipart(args: {
    headers: IncomingHttpHeaders;
    stream: Readable;
    maxFileBytes: number;
    fileFieldName: string;
}): Promise<ParsedMultipart> {
    return new Promise<ParsedMultipart>((resolve, reject) => {
        let busboy: Busboy.Busboy;
        try {
            busboy = Busboy({
                headers: args.headers,
                limits: {
                    fileSize: args.maxFileBytes,
                    files: 1,
                    fields: MAX_FIELDS,
                },
            });
        } catch (err) {
            reject(
                new SubmissionError(
                    SubmissionErrorCode.INVALID_PAYLOAD,
                    `Invalid multipart request: ${err instanceof Error ? err.message : String(err)}`,
                ),
            );
            return;
        }

        const fields: Record<string, MultipartFieldValue> = {};
        let fileResult: ParsedMultipart["file"] | undefined;
        let rejected = false;

        const fail = (err: Error): void => {
            if (rejected) {
                return;
            }
            rejected = true;
            reject(err);
        };

        busboy.on("field", (name, value) => {
            const existing = fields[name];
            if (existing === undefined) {
                fields[name] = value;
                return;
            }
            // Promote to array on the second occurrence; preserve order so a
            // multi-select like `categories=Bridge&categories=DeFi` keeps the
            // submitter's pick order.
            if (Array.isArray(existing)) {
                existing.push(value);
                return;
            }
            fields[name] = [existing, value];
        });

        busboy.on("file", (name, fileStream, info) => {
            if (name !== args.fileFieldName) {
                // Drain unknown file streams so Busboy can finish.
                fileStream.resume();
                return;
            }
            const chunks: Buffer[] = [];
            let truncated = false;
            fileStream.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            fileStream.on("limit", () => {
                truncated = true;
            });
            fileStream.on("end", () => {
                if (truncated) {
                    fail(
                        new SubmissionError(
                            SubmissionErrorCode.LOGO_TOO_LARGE,
                            `Logo exceeds the ${args.maxFileBytes}-byte limit`,
                        ),
                    );
                    return;
                }
                fileResult = {
                    fieldname: name,
                    filename: info.filename,
                    mimeType: info.mimeType,
                    bytes: Buffer.concat(chunks),
                };
            });
            fileStream.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
        });

        busboy.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
        busboy.on("close", () => {
            if (rejected) {
                return;
            }
            resolve({ fields, file: fileResult });
        });

        args.stream.pipe(busboy);
    });
}
