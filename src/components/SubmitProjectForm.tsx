import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import "./SubmitProjectForm.css";
import CategoryPicker from "./CategoryPicker";
import LogoUploadField from "./LogoUploadField";
import SectionPicker from "./SectionPicker";
import {
    AlertCircleIcon,
    CardIcon,
    ChatIcon,
    CheckCircleIcon,
    LayersIcon,
    LinkIcon,
    MailIcon,
    UserIcon,
} from "./submitFormIcons";
import { SECTIONS } from "../data/sections";
import { SubmissionErrorCode } from "../lib/errors";
import { CATEGORY_OPTIONS } from "../lib/schemas/explorer-apps";
import {
    SubmissionFormSchema,
    SUBMISSION_FORM_LIMITS,
    type SubmissionFormValues,
} from "../lib/schemas/submission-form";

interface SubmitProjectFormProps {
    onSuccess?: (result: { submissionId: string; slug: string }) => void;
}

type BannerState =
    | { variant: "idle" }
    | { variant: "success" }
    | { variant: "error"; message: string };

interface BackendErrorBody {
    ok: false;
    code?: string;
    message?: string;
}

const SUCCESS_BANNER_MS = 6000;
const SUBMIT_ENDPOINT = "/api/submit";
// Roughly 85% of `DESCRIPTION_MAX` — the counter turns warn-coloured to
// let the user know they're near the cap without yet failing validation.
const DESCRIPTION_WARN_THRESHOLD = 275;

// Codes we have a friendly copy for. `Partial<Record<…>>` ties the lookup to
// the backend enum so adding a new `SubmissionErrorCode` surfaces an obvious
// "no entry here, falls back to the default copy" rather than a stringly
// typed mystery. Codes not listed here intentionally fall through.
const ERROR_COPY_BY_CODE: Partial<Record<SubmissionErrorCode, string>> = {
    [SubmissionErrorCode.LOGO_TOO_LARGE]: "Logo must be under 500KB.",
    [SubmissionErrorCode.INVALID_LOGO_TYPE]: "Logo must be PNG, JPEG, SVG, or WebP.",
    [SubmissionErrorCode.LOGO_MISSING]: "Logo is required.",
    [SubmissionErrorCode.INVALID_PAYLOAD]: "Some fields are invalid. Double-check the form and try again.",
};
const DEFAULT_ERROR_COPY = "Submission failed. Please try again later.";
const NETWORK_ERROR_COPY = "Couldn't reach the server. Check your connection and retry.";
const SUCCESS_COPY =
    "Submitted! Maintainers will review on Slack. You'll get a GitHub PR notification if approved.";

function copyForBackendError(body: BackendErrorBody | undefined): string {
    const code = body?.code;
    if (code === undefined) {
        return DEFAULT_ERROR_COPY;
    }
    // The backend code is a free-form string at the wire boundary; we narrow
    // to the enum via lookup. Any unknown code falls back to the default.
    const copy = ERROR_COPY_BY_CODE[code as SubmissionErrorCode];
    return copy ?? DEFAULT_ERROR_COPY;
}

async function parseErrorBody(res: Response): Promise<BackendErrorBody | undefined> {
    try {
        const body = (await res.json()) as BackendErrorBody;
        return body;
    } catch {
        return undefined;
    }
}

type DescriptionCounterState = "ok" | "warn" | "over";

function counterState(length: number, max: number): DescriptionCounterState {
    if (length > max) {
        return "over";
    }
    if (length >= DESCRIPTION_WARN_THRESHOLD) {
        return "warn";
    }
    return "ok";
}

const SubmitProjectForm: React.FC<SubmitProjectFormProps> = ({ onSuccess }) => {
    const baseId = useId();
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [banner, setBanner] = useState<BannerState>({ variant: "idle" });

    const {
        register,
        control,
        handleSubmit,
        formState: { errors, isSubmitting },
        watch,
        reset,
    } = useForm<SubmissionFormValues>({
        resolver: zodResolver(SubmissionFormSchema),
        mode: "onBlur",
        reValidateMode: "onChange",
        defaultValues: {
            name: "",
            section: SECTIONS[0]?.id,
            url: "",
            description: "",
            longDescription: "",
            categories: [],
            author: "",
            site: "",
            github: "",
            submitterEmail: "",
            submitterName: "",
        },
    });

    useEffect(() => {
        return () => {
            if (successTimerRef.current !== undefined) {
                clearTimeout(successTimerRef.current);
            }
        };
    }, []);

    const description = watch("description") ?? "";
    const descriptionLen = description.length;
    const descriptionState = counterState(descriptionLen, SUBMISSION_FORM_LIMITS.DESCRIPTION_MAX);

    const onSubmit = useCallback(
        async (values: SubmissionFormValues): Promise<void> => {
            setBanner({ variant: "idle" });

            const formData = new FormData();
            formData.append("name", values.name);
            formData.append("section", values.section);
            formData.append("url", values.url);
            if (values.description !== undefined && values.description !== "") {
                formData.append("description", values.description);
            }
            if (values.longDescription !== undefined && values.longDescription !== "") {
                formData.append("longDescription", values.longDescription);
            }
            // The multipart parser promotes repeated keys to an array, so each
            // category is appended individually. Pick order is preserved.
            if (values.categories !== undefined) {
                for (const category of values.categories) {
                    formData.append("categories", category);
                }
            }
            if (values.author !== undefined && values.author !== "") {
                formData.append("author", values.author);
            }
            if (values.site !== undefined && values.site !== "") {
                formData.append("site", values.site);
            }
            if (values.github !== undefined && values.github !== "") {
                formData.append("github", values.github);
            }
            formData.append("submitterEmail", values.submitterEmail);
            if (values.submitterName !== undefined && values.submitterName !== "") {
                formData.append("submitterName", values.submitterName);
            }
            formData.append("logo", values.logo);

            let res: Response;
            try {
                res = await fetch(SUBMIT_ENDPOINT, {
                    method: "POST",
                    body: formData,
                });
            } catch (err) {
                console.error("[submit-form] network error", err);
                setBanner({ variant: "error", message: NETWORK_ERROR_COPY });
                return;
            }

            if (!res.ok) {
                const body = await parseErrorBody(res);
                setBanner({ variant: "error", message: copyForBackendError(body) });
                return;
            }

            let body: { ok: true; submissionId: string; slug: string };
            try {
                // defense-in-depth: backend currently always returns JSON; this
                // guard exists for future schema evolution (e.g. 204 No Content).
                body = (await res.json()) as { ok: true; submissionId: string; slug: string };
            } catch (err) {
                console.error("[submit-form] malformed success body", err);
                setBanner({ variant: "error", message: DEFAULT_ERROR_COPY });
                return;
            }

            setBanner({ variant: "success" });
            reset();
            onSuccess?.({ submissionId: body.submissionId, slug: body.slug });

            if (successTimerRef.current !== undefined) {
                clearTimeout(successTimerRef.current);
            }
            successTimerRef.current = setTimeout(() => {
                setBanner({ variant: "idle" });
            }, SUCCESS_BANNER_MS);
        },
        [onSuccess, reset],
    );

    const dismissBanner = useCallback(() => {
        if (successTimerRef.current !== undefined) {
            clearTimeout(successTimerRef.current);
            successTimerRef.current = undefined;
        }
        setBanner({ variant: "idle" });
    }, []);

    const nameErrId = `${baseId}-name-error`;
    const sectionErrId = `${baseId}-section-error`;
    const urlErrId = `${baseId}-url-error`;
    const descriptionErrId = `${baseId}-description-error`;
    const descriptionHelperId = `${baseId}-description-helper`;
    const longDescriptionErrId = `${baseId}-long-description-error`;
    const categoriesErrId = `${baseId}-categories-error`;
    const categoriesLabelId = `${baseId}-categories-label`;
    const authorErrId = `${baseId}-author-error`;
    const siteErrId = `${baseId}-site-error`;
    const githubErrId = `${baseId}-github-error`;
    const emailErrId = `${baseId}-email-error`;
    const submitterNameErrId = `${baseId}-submitter-name-error`;
    const logoErrId = `${baseId}-logo-error`;

    return (
        <form className="submit-form" onSubmit={handleSubmit(onSubmit)} noValidate>
            {banner.variant !== "idle" && (
                <div
                    className="submit-banner"
                    data-variant={banner.variant}
                    role={banner.variant === "error" ? "alert" : "status"}
                    aria-live={banner.variant === "error" ? "assertive" : "polite"}
                >
                    <span className="submit-banner-icon" aria-hidden="true">
                        {banner.variant === "success" ? <CheckCircleIcon /> : <AlertCircleIcon />}
                    </span>
                    <span className="submit-banner-content">
                        {banner.variant === "success" ? SUCCESS_COPY : banner.message}
                    </span>
                    <button
                        type="button"
                        className="submit-banner-dismiss"
                        onClick={dismissBanner}
                        aria-label="Dismiss notification"
                    >
                        &times;
                    </button>
                </div>
            )}

            <div className="submit-form-section">
                <h3 className="submit-form-section-title">About your project</h3>
                <div className="submit-form-grid">
                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-name`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><CardIcon /></span>
                            Project name
                            <span className="submit-field-required" aria-hidden="true">*</span>
                        </label>
                        <input
                            id={`${baseId}-name`}
                            type="text"
                            className="submit-field-input"
                            placeholder="Acme Wallet"
                            maxLength={SUBMISSION_FORM_LIMITS.NAME_MAX}
                            autoComplete="off"
                            aria-invalid={errors.name !== undefined}
                            aria-describedby={nameErrId}
                            disabled={isSubmitting}
                            {...register("name")}
                        />
                        <span className="submit-field-helper">How it'll appear on the card.</span>
                        <div id={nameErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.name?.message}
                        </div>
                    </div>

                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-url`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><LinkIcon /></span>
                            Project URL
                            <span className="submit-field-required" aria-hidden="true">*</span>
                        </label>
                        <input
                            id={`${baseId}-url`}
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            placeholder="https://yourapp.xyz"
                            className="submit-field-input"
                            maxLength={SUBMISSION_FORM_LIMITS.HTTPS_URL_MAX}
                            aria-invalid={errors.url !== undefined}
                            aria-describedby={urlErrId}
                            disabled={isSubmitting}
                            {...register("url")}
                        />
                        <span className="submit-field-helper">
                            The link users click from your logo on the map.
                        </span>
                        <div id={urlErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.url?.message}
                        </div>
                    </div>

                    <div className="submit-field submit-field--full">
                        <span
                            id={`${baseId}-section-label`}
                            className="submit-field-label"
                        >
                            <span className="submit-field-label-icon" aria-hidden="true"><LayersIcon /></span>
                            Section
                            <span className="submit-field-required" aria-hidden="true">*</span>
                        </span>
                        <Controller
                            control={control}
                            name="section"
                            render={({ field }) => (
                                <SectionPicker
                                    id={`${baseId}-section`}
                                    sections={SECTIONS}
                                    value={field.value}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    labelledBy={`${baseId}-section-label`}
                                    describedBy={sectionErrId}
                                    invalid={errors.section !== undefined}
                                    disabled={isSubmitting}
                                />
                            )}
                        />
                        <span className="submit-field-helper">Where it fits in the ecosystem map.</span>
                        <div id={sectionErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.section?.message}
                        </div>
                    </div>

                    <div className="submit-field submit-field--full">
                        <label className="submit-field-label" htmlFor={`${baseId}-description`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><ChatIcon /></span>
                            Description
                        </label>
                        <div className="submit-field-textarea-row">
                            <textarea
                                id={`${baseId}-description`}
                                className="submit-field-textarea"
                                placeholder="One or two lines about what your project does."
                                maxLength={SUBMISSION_FORM_LIMITS.DESCRIPTION_MAX}
                                aria-invalid={errors.description !== undefined}
                                aria-describedby={`${descriptionHelperId} ${descriptionErrId}`}
                                disabled={isSubmitting}
                                {...register("description")}
                            />
                            <span
                                className="submit-field-counter"
                                data-state={descriptionState}
                                aria-hidden="true"
                            >
                                {descriptionLen} / {SUBMISSION_FORM_LIMITS.DESCRIPTION_MAX}
                            </span>
                        </div>
                        <span id={descriptionHelperId} className="submit-field-helper">
                            Optional — the card tagline. Max{" "}
                            {SUBMISSION_FORM_LIMITS.DESCRIPTION_MAX} characters.
                        </span>
                        <div id={descriptionErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.description?.message}
                        </div>
                    </div>

                    <div className="submit-field submit-field--full">
                        <label className="submit-field-label" htmlFor={`${baseId}-long-description`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><ChatIcon /></span>
                            Long description
                        </label>
                        <textarea
                            id={`${baseId}-long-description`}
                            className="submit-field-textarea"
                            placeholder="A longer paragraph for the detail view (optional)."
                            maxLength={SUBMISSION_FORM_LIMITS.LONG_DESCRIPTION_MAX}
                            aria-invalid={errors.longDescription !== undefined}
                            aria-describedby={longDescriptionErrId}
                            disabled={isSubmitting}
                            {...register("longDescription")}
                        />
                        <span className="submit-field-helper">
                            Optional. Up to {SUBMISSION_FORM_LIMITS.LONG_DESCRIPTION_MAX} characters; surfaced in the explorer detail view.
                        </span>
                        <div id={longDescriptionErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.longDescription?.message}
                        </div>
                    </div>

                    <div className="submit-field submit-field--full">
                        <span id={categoriesLabelId} className="submit-field-label">
                            <span className="submit-field-label-icon" aria-hidden="true"><LayersIcon /></span>
                            Categories
                        </span>
                        <Controller
                            control={control}
                            name="categories"
                            render={({ field }) => (
                                <CategoryPicker
                                    id={`${baseId}-categories`}
                                    options={CATEGORY_OPTIONS}
                                    max={SUBMISSION_FORM_LIMITS.CATEGORIES_MAX}
                                    value={field.value ?? []}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    labelledBy={categoriesLabelId}
                                    describedBy={categoriesErrId}
                                    invalid={errors.categories !== undefined}
                                    disabled={isSubmitting}
                                />
                            )}
                        />
                        <span className="submit-field-helper">
                            Optional. Up to {SUBMISSION_FORM_LIMITS.CATEGORIES_MAX} tags from the curated list.
                        </span>
                        <div id={categoriesErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.categories?.message}
                        </div>
                    </div>

                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-author`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><UserIcon /></span>
                            Author
                        </label>
                        <input
                            id={`${baseId}-author`}
                            type="text"
                            className="submit-field-input"
                            placeholder="Team or company name (optional)"
                            maxLength={SUBMISSION_FORM_LIMITS.AUTHOR_MAX}
                            autoComplete="organization"
                            aria-invalid={errors.author !== undefined}
                            aria-describedby={authorErrId}
                            disabled={isSubmitting}
                            {...register("author")}
                        />
                        <span className="submit-field-helper">Optional. Credited on the project card.</span>
                        <div id={authorErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.author?.message}
                        </div>
                    </div>

                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-site`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><LinkIcon /></span>
                            Marketing site
                        </label>
                        <input
                            id={`${baseId}-site`}
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            placeholder="https://yourproject.xyz (optional)"
                            className="submit-field-input"
                            maxLength={SUBMISSION_FORM_LIMITS.SITE_URL_MAX}
                            aria-invalid={errors.site !== undefined}
                            aria-describedby={siteErrId}
                            disabled={isSubmitting}
                            {...register("site")}
                        />
                        <span className="submit-field-helper">
                            Optional. Falls back to the project URL if blank.
                        </span>
                        <div id={siteErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.site?.message}
                        </div>
                    </div>

                    <div className="submit-field submit-field--full">
                        <label className="submit-field-label" htmlFor={`${baseId}-github`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><LinkIcon /></span>
                            GitHub
                        </label>
                        <input
                            id={`${baseId}-github`}
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            placeholder="https://github.com/your-org/repo (optional)"
                            className="submit-field-input"
                            maxLength={SUBMISSION_FORM_LIMITS.GITHUB_URL_MAX}
                            aria-invalid={errors.github !== undefined}
                            aria-describedby={githubErrId}
                            disabled={isSubmitting}
                            {...register("github")}
                        />
                        <span className="submit-field-helper">Optional. Public repo or org.</span>
                        <div id={githubErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.github?.message}
                        </div>
                    </div>
                </div>
            </div>

            <div className="submit-form-section">
                <h3 className="submit-form-section-title">Branding</h3>
                <div className="submit-field submit-field--full">
                    <label className="submit-field-label" htmlFor={`${baseId}-logo`}>
                        Logo
                        <span className="submit-field-required" aria-hidden="true">*</span>
                    </label>
                    <Controller
                        control={control}
                        name="logo"
                        render={({ field }) => (
                            <LogoUploadField
                                id={`${baseId}-logo`}
                                value={field.value}
                                onChange={field.onChange}
                                onBlur={field.onBlur}
                                errorId={logoErrId}
                                invalid={errors.logo !== undefined}
                                disabled={isSubmitting}
                            />
                        )}
                    />
                    <div id={logoErrId} className="submit-field-error" role="alert" aria-live="polite">
                        {errors.logo?.message}
                    </div>
                </div>
            </div>

            <div className="submit-form-section">
                <h3 className="submit-form-section-title">Submitter</h3>
                <div className="submit-form-grid">
                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-email`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><MailIcon /></span>
                            Your email
                            <span className="submit-field-required" aria-hidden="true">*</span>
                        </label>
                        <input
                            id={`${baseId}-email`}
                            type="email"
                            inputMode="email"
                            autoComplete="email"
                            placeholder="you@yourapp.xyz"
                            className="submit-field-input"
                            aria-invalid={errors.submitterEmail !== undefined}
                            aria-describedby={emailErrId}
                            disabled={isSubmitting}
                            {...register("submitterEmail")}
                        />
                        <span className="submit-field-helper">
                            Used only if the maintainers need to clarify something.
                        </span>
                        <div id={emailErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.submitterEmail?.message}
                        </div>
                    </div>

                    <div className="submit-field">
                        <label className="submit-field-label" htmlFor={`${baseId}-submitter-name`}>
                            <span className="submit-field-label-icon" aria-hidden="true"><UserIcon /></span>
                            Your name
                        </label>
                        <input
                            id={`${baseId}-submitter-name`}
                            type="text"
                            autoComplete="name"
                            placeholder="Optional"
                            className="submit-field-input"
                            maxLength={SUBMISSION_FORM_LIMITS.SUBMITTER_NAME_MAX}
                            aria-invalid={errors.submitterName !== undefined}
                            aria-describedby={submitterNameErrId}
                            disabled={isSubmitting}
                            {...register("submitterName")}
                        />
                        <span className="submit-field-helper">Credited in the PR commit message.</span>
                        <div id={submitterNameErrId} className="submit-field-error" role="alert" aria-live="polite">
                            {errors.submitterName?.message}
                        </div>
                    </div>
                </div>
            </div>

            <div className="submit-form-actions">
                <p className="submit-form-disclaimer">
                    By submitting, you confirm the logo and links are yours to share. Maintainers
                    review every submission before it goes live on the map.
                </p>
                <div className="submit-form-actions-row">
                    <button type="submit" className="submit-submit-button" disabled={isSubmitting}>
                        {isSubmitting && <span className="submit-spinner" aria-hidden="true" />}
                        {isSubmitting ? "Posting to Slack for review..." : "Submit project"}
                    </button>
                </div>
            </div>
        </form>
    );
};

export default SubmitProjectForm;
