import React, { useCallback, useEffect, useId, useRef } from "react";

import "./SubmitProjectForm.css";
import SubmitProjectForm from "./SubmitProjectForm";

interface SubmitProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
}

/**
 * Focusable elements that the modal's focus trap considers tabbable.
 * Conservative selector — RHF controls (input, select, textarea, button) and
 * the dropzone (role=button with tabindex=0) all match.
 */
const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElementsIn(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
        // querySelector ignores `disabled` on custom elements but covers the
        // standard inputs. Also drop visually hidden file inputs that we mark
        // aria-hidden on purpose.
        return el.getAttribute("aria-hidden") !== "true";
    });
}

const SubmitProjectModal: React.FC<SubmitProjectModalProps> = ({ isOpen, onClose }) => {
    const titleId = useId();
    const subtitleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

        // Defer to next tick so the dialog content is mounted before we look
        // for focusables.
        const initialFocusTimer = setTimeout(() => {
            const dialog = dialogRef.current;
            if (dialog === null) {
                return;
            }
            const focusables = focusableElementsIn(dialog);
            const first = focusables.find((el) => !el.classList.contains("submit-modal-close"));
            (first ?? focusables[0])?.focus();
        }, 0);

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            clearTimeout(initialFocusTimer);
            document.body.style.overflow = previousOverflow;
            previouslyFocusedRef.current?.focus();
        };
    }, [isOpen]);

    // Tracks the form's unsaved-changes state so close actions can confirm
    // before discarding input.
    const isDirtyRef = useRef(false);
    const handleDirtyChange = useCallback((dirty: boolean) => {
        isDirtyRef.current = dirty;
    }, []);
    const requestClose = useCallback(() => {
        if (
            isDirtyRef.current &&
            !window.confirm("Discard your submission? Your unsaved changes will be lost.")
        ) {
            return;
        }
        onClose();
    }, [onClose]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                requestClose();
                return;
            }
            if (e.key !== "Tab") {
                return;
            }
            const dialog = dialogRef.current;
            if (dialog === null) {
                return;
            }
            const focusables = focusableElementsIn(dialog);
            if (focusables.length === 0) {
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
                if (active === first || !dialog.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
                return;
            }
            if (active === last) {
                e.preventDefault();
                first.focus();
            }
        },
        [requestClose],
    );

    const handleOverlayMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            // Only close if the click started on the overlay itself, not when
            // a drag selection ends there. Comparing target === currentTarget
            // is the standard way to ignore bubbling from the dialog children.
            if (e.target === e.currentTarget) {
                requestClose();
            }
        },
        [requestClose],
    );

    const stopMouseDownPropagation = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        // Defense-in-depth: the overlay's target===currentTarget guard already
        // ignores bubbled clicks, but if a future restyle shrinks the overlay
        // padding to 0 the modal children would cover 100% of the area and
        // any miss-click would fall through. Stopping propagation here keeps
        // the close-on-overlay-click contract stable across CSS changes.
        e.stopPropagation();
    }, []);

    if (!isOpen) {
        return null;
    }

    return (
        <div
            className="submit-overlay"
            onMouseDown={handleOverlayMouseDown}
            onKeyDown={handleKeyDown}
            role="presentation"
        >
            <div
                ref={dialogRef}
                className="submit-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={subtitleId}
                onMouseDown={stopMouseDownPropagation}
            >
                <div className="submit-modal-header">
                    <div className="submit-modal-heading">
                        <h2 id={titleId} className="submit-modal-title">
                            Add your project to the XRPL EVM ecosystem
                        </h2>
                        <p id={subtitleId} className="submit-modal-subtitle">
                            Reviewed by maintainers in Slack — usually within 24h.
                        </p>
                    </div>
                    <button
                        type="button"
                        className="submit-modal-close"
                        onClick={requestClose}
                        aria-label="Close submission form"
                    >
                        &times;
                    </button>
                </div>
                <SubmitProjectForm onDirtyChange={handleDirtyChange} />
            </div>
        </div>
    );
};

export default SubmitProjectModal;
