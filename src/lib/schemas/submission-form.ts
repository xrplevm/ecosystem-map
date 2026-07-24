import { z } from "zod";

import { SubmissionSchema, SUBMISSION_LIMITS } from "./submission";

/**
 * Frontend-only superset of `SubmissionSchema` that also validates the
 * uploaded logo (a browser `File`). The backend handles its own MIME + byte
 * check on the multipart stream — this schema exists so the form can refuse
 * a clearly invalid file before consuming a serverless invocation.
 *
 * The base submission shape is intentionally reused, not redeclared: if a
 * limit ever moves (e.g. DESCRIPTION_MAX), both sides update together.
 */

export const ALLOWED_LOGO_MIME = [
    "image/png",
    "image/jpeg",
    "image/svg+xml",
    "image/webp",
] as const;

export type AllowedLogoMime = (typeof ALLOWED_LOGO_MIME)[number];

export const LOGO_MAX_BYTES = 500_000;

const LogoFileSchema = z
    .instanceof(File, { message: "Logo is required" })
    .refine((f) => f.size > 0, "Logo file is empty")
    .refine((f) => f.size <= LOGO_MAX_BYTES, `Logo must be ${Math.floor(LOGO_MAX_BYTES / 1000)}KB or less`)
    .refine(
        (f) => (ALLOWED_LOGO_MIME as readonly string[]).includes(f.type),
        "Logo must be PNG, JPEG, SVG, or WebP",
    );

export const SubmissionFormSchema = SubmissionSchema.extend({
    logo: LogoFileSchema,
});

export type SubmissionFormValues = z.infer<typeof SubmissionFormSchema>;

export const SUBMISSION_FORM_LIMITS = {
    ...SUBMISSION_LIMITS,
    LOGO_MAX_BYTES,
} as const;
