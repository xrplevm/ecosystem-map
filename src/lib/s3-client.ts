import {
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
    S3ServiceException,
} from "@aws-sdk/client-s3";

import { loadEnv } from "./env";
import type { ExplorerAppsJson } from "./explorer-apps-types";

/**
 * Thin wrapper around `@aws-sdk/client-s3` for the explorer-apps writer.
 *
 * Responsibilities:
 *   - Read/write `explorer-apps.json` with ETag conditional PUT (`If-Match`),
 *     so the Slack batch-approve handler can do a safe read-modify-write
 *     against a versioned bucket without an external lock.
 *   - Cache GETs of the canonical JSON in module memory for 60 s, with an
 *     explicit `bypassCache` escape hatch for callers (e.g. the modal
 *     handler) that need a fresh read inside a retry loop.
 *   - Upload logo assets and return their public URL using the standard
 *     virtual-hosted–style S3 endpoint.
 *
 * The handler that consumes this module is added in sub-task E. This file
 * intentionally knows nothing about Slack, Anthropic, or submission shape
 * beyond `ExplorerAppsJson`.
 */

const ETAG_MISMATCH_HTTP_STATUS = 412;
const DEFAULT_MAX_RETRIES = 3;
const CACHE_TTL_MS = 60_000;

export class S3ClientConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "S3ClientConfigError";
    }
}

export class EtagMismatchError extends Error {
    public readonly key: string;
    public readonly cause?: unknown;

    constructor(key: string, cause?: unknown) {
        super(`S3 PUT for key '${key}' rejected by If-Match: ETag changed concurrently`);
        this.name = "EtagMismatchError";
        this.key = key;
        this.cause = cause;
    }
}

export class S3ReadError extends Error {
    public readonly key: string;
    public readonly cause?: unknown;

    constructor(key: string, message: string, cause?: unknown) {
        super(message);
        this.name = "S3ReadError";
        this.key = key;
        this.cause = cause;
    }
}

export class EtagRetryExhaustedError extends Error {
    public readonly key: string;
    public readonly attempts: number;

    constructor(key: string, attempts: number) {
        super(
            `Exhausted ${attempts} retries on conditional PUT for key '${key}': ` +
            "concurrent writers keep invalidating the ETag",
        );
        this.name = "EtagRetryExhaustedError";
        this.key = key;
        this.attempts = attempts;
    }
}

interface CacheEntry {
    data: ExplorerAppsJson;
    etag: string;
    expiresAt: number;
}

const jsonCache: Map<string, CacheEntry> = new Map();

let cachedClient: S3Client | undefined;

function getS3Client(): S3Client {
    if (cachedClient !== undefined) return cachedClient;
    const env = loadEnv();
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        throw new S3ClientConfigError(
            "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for S3 write operations",
        );
    }
    cachedClient = new S3Client({
        region: env.AWS_REGION,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
    });
    return cachedClient;
}

/**
 * Test-only: drop the cached client + JSON cache so tests with mutated
 * `process.env` or fresh aws-sdk-client-mock instances see a clean slate.
 */
export function __resetS3StateForTests(): void {
    cachedClient = undefined;
    jsonCache.clear();
}

function resolveJsonKey(explicit?: string): string {
    if (explicit !== undefined && explicit !== "") return explicit;
    return loadEnv().S3_JSON_KEY;
}

function resolveBucket(): string {
    return loadEnv().S3_BUCKET;
}

function stripQuotes(etag: string): string {
    // S3 returns ETags wrapped in double quotes ('"abc"'); the IfMatch header
    // accepts either form but we normalize on output for caller ergonomics.
    if (etag.length >= 2 && etag.startsWith("\"") && etag.endsWith("\"")) {
        return etag.slice(1, -1);
    }
    return etag;
}

async function streamToString(body: unknown): Promise<string> {
    if (body == null) return "";
    // The AWS SDK v3 returns one of: a Web ReadableStream (Node 18+/edge),
    // a Node Readable, or a Blob. We support all three; the helper
    // `transformToString` exists on the v3 response type but is not part
    // of the public API surface we want to depend on.
    const maybeTransform = body as { transformToString?: () => Promise<string> };
    if (typeof maybeTransform.transformToString === "function") {
        return maybeTransform.transformToString();
    }
    if (typeof (body as { getReader?: unknown }).getReader === "function") {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
            const next = await reader.read();
            done = next.done;
            if (next.value) chunks.push(next.value);
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    }
    if (typeof (body as { on?: unknown }).on === "function") {
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const stream = body as NodeJS.ReadableStream;
            stream.on("data", (chunk: Buffer | string) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            });
            stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            stream.on("error", reject);
        });
    }
    throw new S3ReadError("(unknown)", "Unrecognized S3 GetObject body shape");
}

export interface GetJsonResult {
    data: ExplorerAppsJson;
    etag: string;
}

export interface GetJsonOptions {
    key?: string;
    bypassCache?: boolean;
}

export async function getJson(options: GetJsonOptions = {}): Promise<GetJsonResult> {
    const key = resolveJsonKey(options.key);
    const bypassCache = options.bypassCache === true;
    const now = Date.now();
    if (!bypassCache) {
        const hit = jsonCache.get(key);
        if (hit !== undefined && hit.expiresAt > now) {
            return { data: hit.data, etag: hit.etag };
        }
    }

    const client = getS3Client();
    let response;
    try {
        response = await client.send(new GetObjectCommand({ Bucket: resolveBucket(), Key: key }));
    } catch (err) {
        throw new S3ReadError(key, `S3 GetObject failed for '${key}': ${describeAwsError(err)}`, err);
    }

    const rawEtag = response.ETag;
    if (rawEtag === undefined) {
        // Note: the browser-side consumer falls back to
        // `public/explorer-apps.snapshot.json` in
        // `src/lib/explorer-apps-source.ts`. This server-side client treats a
        // missing ETag as an unrecoverable read error.
        throw new S3ReadError(key, `S3 GetObject for '${key}' returned no ETag`);
    }

    const bodyText = await streamToString(response.Body);
    let data: ExplorerAppsJson;
    try {
        data = JSON.parse(bodyText) as ExplorerAppsJson;
    } catch (err) {
        throw new S3ReadError(key, `S3 GetObject for '${key}' returned non-JSON body`, err);
    }

    const etag = stripQuotes(rawEtag);
    jsonCache.set(key, { data, etag, expiresAt: now + CACHE_TTL_MS });
    return { data, etag };
}

export interface PutJsonResult {
    etag: string;
}

/**
 * Conditional PUT of the canonical JSON. On HTTP 412 (PreconditionFailed)
 * the bucket's current ETag has moved on since `etag` was read; callers
 * should retry the read-modify-write or surface the conflict.
 */
export async function putJsonIfMatch(
    key: string,
    data: ExplorerAppsJson,
    etag: string,
): Promise<PutJsonResult> {
    const client = getS3Client();
    const body = JSON.stringify(data, null, 4) + "\n";
    let response;
    try {
        response = await client.send(
            new PutObjectCommand({
                Bucket: resolveBucket(),
                Key: key,
                Body: body,
                ContentType: "application/json; charset=utf-8",
                IfMatch: etag,
            }),
        );
    } catch (err) {
        if (isEtagMismatch(err)) {
            // Drop the cached read for this key so the next getJson() refetches
            // the post-mutation state — otherwise withEtagRetry would loop
            // against stale data.
            jsonCache.delete(key);
            throw new EtagMismatchError(key, err);
        }
        throw err;
    }

    const rawEtag = response.ETag;
    if (rawEtag === undefined) {
        throw new S3ReadError(key, `S3 PutObject for '${key}' returned no ETag`);
    }
    const newEtag = stripQuotes(rawEtag);
    jsonCache.set(key, { data, etag: newEtag, expiresAt: Date.now() + CACHE_TTL_MS });
    return { etag: newEtag };
}

function isEtagMismatch(err: unknown): boolean {
    if (err instanceof S3ServiceException) {
        if (err.name === "PreconditionFailed") return true;
        if (err.$metadata?.httpStatusCode === ETAG_MISMATCH_HTTP_STATUS) return true;
    }
    if (err && typeof err === "object") {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === ETAG_MISMATCH_HTTP_STATUS) return true;
        const name = (err as { name?: string }).name;
        if (name === "PreconditionFailed") return true;
    }
    return false;
}

function describeAwsError(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
}

export interface EtagRetryOptions {
    key?: string;
    maxRetries?: number;
}

export interface EtagRetryResult {
    etag: string;
}

export type EtagRetryOperation = (
    current: GetJsonResult,
) => Promise<{ data: ExplorerAppsJson }> | { data: ExplorerAppsJson };

/**
 * Read-modify-write helper with bounded retry on ETag mismatch.
 *
 * Each attempt does:
 *   1. `getJson({ bypassCache: true })` — fresh read.
 *   2. `await operation(current)` — caller computes the next snapshot.
 *   3. `putJsonIfMatch(key, next.data, current.etag)`.
 *
 * On `EtagMismatchError` we retry up to `maxRetries` (default 3) total
 * attempts. After that we throw `EtagRetryExhaustedError` so the caller
 * can surface the conflict to the operator instead of looping forever.
 */
export async function withEtagRetry(
    operation: EtagRetryOperation,
    options: EtagRetryOptions = {},
): Promise<EtagRetryResult> {
    const key = resolveJsonKey(options.key);
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const current = await getJson({ key, bypassCache: true });
        const next = await operation(current);
        try {
            const { etag } = await putJsonIfMatch(key, next.data, current.etag);
            return { etag };
        } catch (err) {
            if (err instanceof EtagMismatchError) {
                // Loop and re-read; the caller's operation re-runs against
                // the post-conflict snapshot.
                continue;
            }
            throw err;
        }
    }
    throw new EtagRetryExhaustedError(key, maxRetries);
}

export interface PutLogoResult {
    url: string;
}

/**
 * Logo upload. Logos are append-only by id (renaming a dApp = delete + add)
 * so there is no IfMatch contention; this is a plain PutObject. Returns
 * the public virtual-hosted URL the consumer will fetch.
 */
export async function putLogo(
    key: string,
    body: Buffer,
    contentType: string,
): Promise<PutLogoResult> {
    const client = getS3Client();
    const env = loadEnv();
    await client.send(
        new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
        }),
    );
    const url = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
    return { url };
}
