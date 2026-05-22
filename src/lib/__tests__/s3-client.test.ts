/**
 * @jest-environment node
 */
import { GetObjectCommand, GetObjectCommandOutput, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { __resetEnvCacheForTests } from "../env";
import {
    EtagMismatchError,
    EtagRetryExhaustedError,
    S3ClientConfigError,
    __resetS3StateForTests,
    getJson,
    putJsonIfMatch,
    putLogo,
    withEtagRetry,
} from "../s3-client";
import type { ExplorerAppsJson } from "../explorer-apps-types";

const s3Mock = mockClient(S3Client);

const SAMPLE_ENTRIES: ExplorerAppsJson = [
    {
        id: "acme-bridge",
        external: true,
        title: "Acme Bridge",
        logo: "https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-dapp-acme-bridge.png",
        shortDescription: "Fast cross-chain bridge.",
        categories: ["Bridge"],
        author: "Acme Labs",
        url: "https://acme.example",
    },
];

/**
 * The v3 SDK types `Body` as a `StreamingBlobPayloadOutputTypes` (a Node
 * stream / web stream / Blob with the `SdkStreamMixin`). For unit tests
 * we only need the `transformToString` channel that the production code
 * uses, so we synthesize a minimal shape and cast via the SDK's own
 * response type — avoids depending on `@smithy/util-stream`.
 */
function bodyFrom(json: unknown): GetObjectCommandOutput["Body"] {
    const text = JSON.stringify(json);
    const fake = {
        transformToString: async () => text,
    };
    // Cast through unknown because the structural type from the SDK
    // includes Node/web stream methods we don't need to fake here.
    return fake as unknown as GetObjectCommandOutput["Body"];
}

function preconditionFailed(): S3ServiceException {
    return new S3ServiceException({
        name: "PreconditionFailed",
        $fault: "client",
        $metadata: { httpStatusCode: 412 },
        message: "At least one of the pre-conditions you specified did not hold",
    });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    s3Mock.reset();
    __resetEnvCacheForTests();
    __resetS3StateForTests();
    process.env = { ...ORIGINAL_ENV };
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_SIGNING_SECRET = "x".repeat(32);
    process.env.SLACK_APPROVAL_CHANNEL = "C01234ABCD";
    process.env.AWS_REGION = "eu-west-1";
    process.env.S3_BUCKET = "peersyst-development";
    process.env.S3_JSON_KEY = "explorer-apps.json";
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secretsecret";
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe("getJson", () => {
    it("fetches and parses the canonical JSON, returning unquoted ETag", async () => {
        s3Mock.on(GetObjectCommand).resolves({
            ETag: '"abc123"',
            Body: bodyFrom(SAMPLE_ENTRIES),
        });
        const result = await getJson();
        expect(result.etag).toBe("abc123");
        expect(result.data).toEqual(SAMPLE_ENTRIES);
    });

    it("serves a second call from the in-memory cache without hitting S3", async () => {
        s3Mock.on(GetObjectCommand).resolves({
            ETag: '"abc123"',
            Body: bodyFrom(SAMPLE_ENTRIES),
        });
        await getJson();
        await getJson();
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    });

    it("bypasses the cache when bypassCache=true", async () => {
        s3Mock.on(GetObjectCommand).resolves({
            ETag: '"abc123"',
            Body: bodyFrom(SAMPLE_ENTRIES),
        });
        await getJson();
        await getJson({ bypassCache: true });
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(2);
    });
});

describe("putJsonIfMatch", () => {
    it("returns the new ETag on success", async () => {
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"new-etag"' });
        const result = await putJsonIfMatch("explorer-apps.json", SAMPLE_ENTRIES, "old-etag");
        expect(result.etag).toBe("new-etag");
        const calls = s3Mock.commandCalls(PutObjectCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.IfMatch).toBe("old-etag");
        expect(calls[0].args[0].input.ContentType).toBe("application/json; charset=utf-8");
    });

    it("throws EtagMismatchError on HTTP 412", async () => {
        s3Mock.on(PutObjectCommand).rejects(preconditionFailed());
        await expect(
            putJsonIfMatch("explorer-apps.json", SAMPLE_ENTRIES, "stale"),
        ).rejects.toBeInstanceOf(EtagMismatchError);
    });
});

describe("withEtagRetry", () => {
    it("commits in one round-trip on the happy path", async () => {
        s3Mock.on(GetObjectCommand).resolves({
            ETag: '"e1"',
            Body: bodyFrom(SAMPLE_ENTRIES),
        });
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"e2"' });

        const result = await withEtagRetry(async (current) => ({
            data: [...current.data, { ...SAMPLE_ENTRIES[0], id: "second" }],
        }));

        expect(result.etag).toBe("e2");
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });

    it("re-reads and replays when the first PUT fails on 412", async () => {
        s3Mock
            .on(GetObjectCommand)
            .resolvesOnce({
                ETag: '"e1"',
                Body: bodyFrom(SAMPLE_ENTRIES),
            })
            .resolves({
                ETag: '"e2"',
                Body: bodyFrom(SAMPLE_ENTRIES),
            });
        s3Mock
            .on(PutObjectCommand)
            .rejectsOnce(preconditionFailed())
            .resolves({ ETag: '"e3"' });

        let invocations = 0;
        const result = await withEtagRetry(async (current) => {
            invocations += 1;
            return { data: [...current.data] };
        });

        expect(invocations).toBe(2);
        expect(result.etag).toBe("e3");
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(2);
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2);
    });

    it("throws EtagRetryExhaustedError after 3 failed attempts", async () => {
        s3Mock.on(GetObjectCommand).resolves({
            ETag: '"e1"',
            Body: bodyFrom(SAMPLE_ENTRIES),
        });
        s3Mock.on(PutObjectCommand).rejects(preconditionFailed());

        await expect(
            withEtagRetry(async (current) => ({ data: [...current.data] })),
        ).rejects.toBeInstanceOf(EtagRetryExhaustedError);

        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3);
    });
});

describe("putLogo", () => {
    it("uploads the logo and returns the virtual-hosted public URL", async () => {
        s3Mock.on(PutObjectCommand).resolves({ ETag: '"logo-etag"' });
        const result = await putLogo(
            "explorer-dapp-acme-bridge.png",
            Buffer.from([1, 2, 3]),
            "image/png",
        );
        expect(result.url).toBe(
            "https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-dapp-acme-bridge.png",
        );
        const calls = s3Mock.commandCalls(PutObjectCommand);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].input.IfMatch).toBeUndefined();
        expect(calls[0].args[0].input.ContentType).toBe("image/png");
    });
});

describe("missing credentials", () => {
    it("throws S3ClientConfigError when access keys are absent", async () => {
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        __resetEnvCacheForTests();
        __resetS3StateForTests();

        await expect(getJson()).rejects.toBeInstanceOf(S3ClientConfigError);
    });
});
