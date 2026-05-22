import React, { useCallback, useEffect, useRef, useState } from "react";

import { ALLOWED_LOGO_MIME, LOGO_MAX_BYTES } from "../lib/schemas/submission-form";
import { UploadIcon } from "./submitFormIcons";

interface LogoUploadFieldProps {
    id: string;
    value: File | undefined;
    onChange: (file: File | undefined) => void;
    onBlur: () => void;
    errorId?: string;
    /**
     * Drives the red border via [data-invalid]. We do NOT forward this as
     * aria-invalid because aria-invalid is not supported on role="button"
     * (jsx-a11y/role-supports-aria-props). The error message itself is
     * announced via the aria-live region wired to errorId in the parent.
     */
    invalid: boolean;
    disabled?: boolean;
}

const ACCEPT_ATTR = ALLOWED_LOGO_MIME.join(",");
const LOGO_MAX_KB = Math.floor(LOGO_MAX_BYTES / 1000);

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function prettyMime(type: string): string {
    if (type === "") {
        return "unknown type";
    }
    // Strip the leading "image/" so the secondary line reads "PNG" / "SVG+XML"
    // rather than the noisier full MIME. Falls back to the raw string for
    // anything that doesn't match the prefix (defensive — accept attr filters
    // to image/* already).
    if (type.startsWith("image/")) {
        return type.slice("image/".length).toUpperCase();
    }
    return type;
}

const LogoUploadField: React.FC<LogoUploadFieldProps> = ({
    id,
    value,
    onChange,
    onBlur,
    errorId,
    invalid,
    disabled,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        if (value === undefined) {
            setPreviewUrl(undefined);
            return;
        }
        const url = URL.createObjectURL(value);
        setPreviewUrl(url);
        return () => {
            URL.revokeObjectURL(url);
        };
    }, [value]);

    const openPicker = useCallback(() => {
        if (disabled === true) {
            return;
        }
        inputRef.current?.click();
    }, [disabled]);

    const handleInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            onChange(file);
            // Reset so re-selecting the same file fires onChange again.
            e.target.value = "";
        },
        [onChange],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openPicker();
            }
        },
        [openPicker],
    );

    const handleDragOver = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            if (disabled === true) {
                return;
            }
            setIsDragging(true);
        },
        [disabled],
    );

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setIsDragging(false);
            if (disabled === true) {
                return;
            }
            const file = e.dataTransfer.files?.[0];
            if (file !== undefined) {
                onChange(file);
            }
        },
        [onChange, disabled],
    );

    const handleRemove = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onChange(undefined);
        },
        [onChange],
    );

    const handleRemoveKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
        // Stop propagation so the dropzone's Enter/Space handler doesn't
        // re-open the picker after the remove keystroke.
        e.stopPropagation();
    }, []);

    return (
        <div
            className="submit-logo-dropzone"
            data-has-file={value !== undefined}
            data-dragging={isDragging}
            data-invalid={invalid}
            role="button"
            tabIndex={disabled === true ? -1 : 0}
            aria-disabled={disabled}
            aria-describedby={errorId}
            aria-label="Upload project logo"
            onClick={openPicker}
            onKeyDown={handleKeyDown}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onBlur={onBlur}
        >
            <input
                ref={inputRef}
                id={id}
                type="file"
                accept={ACCEPT_ATTR}
                className="submit-logo-hidden-input"
                onChange={handleInputChange}
                disabled={disabled}
                tabIndex={-1}
                aria-hidden="true"
            />
            <div className="submit-logo-preview">
                {value !== undefined && previewUrl !== undefined ? (
                    <img src={previewUrl} alt="Selected logo preview" />
                ) : (
                    <span className="submit-logo-preview-icon" aria-hidden="true">
                        <UploadIcon />
                    </span>
                )}
            </div>
            <div className="submit-logo-body">
                {value === undefined ? (
                    <>
                        <span className="submit-logo-primary">Drop a logo or click to browse</span>
                        <span className="submit-logo-secondary">
                            PNG, JPG, SVG, or WebP · up to {LOGO_MAX_KB}KB
                        </span>
                    </>
                ) : (
                    <>
                        <span className="submit-logo-primary">{value.name}</span>
                        <span className="submit-logo-secondary">
                            {formatBytes(value.size)} · {prettyMime(value.type)}
                        </span>
                        <button
                            type="button"
                            className="submit-logo-remove"
                            onClick={handleRemove}
                            onKeyDown={handleRemoveKeyDown}
                            disabled={disabled}
                        >
                            Remove
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default LogoUploadField;
