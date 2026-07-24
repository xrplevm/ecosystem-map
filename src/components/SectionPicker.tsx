import React, { useCallback, useRef } from "react";

import type { SectionDef, SectionId } from "../data/types";

interface SectionPickerProps {
    /** Currently selected section id. Controlled. */
    value: SectionId;
    /** Fired when the user picks a different section via click, Enter/Space, or arrows. */
    onChange: (next: SectionId) => void;
    /** Optional blur passthrough for RHF integration. */
    onBlur?: () => void;
    /** Sections to render as pills. Order is preserved. */
    sections: ReadonlyArray<SectionDef>;
    /** DOM id of the picker container, used by the outer label and by RHF. */
    id: string;
    /**
     * id of the visible label element. Required for a11y — `role="radiogroup"`
     * has no implicit name. A `<label htmlFor>` cannot point at a `<div>` so
     * we explicitly wire `aria-labelledby` instead.
     */
    labelledBy: string;
    /** Wired up to the field-level error region for additional context. */
    describedBy?: string;
    invalid?: boolean;
    disabled?: boolean;
}

/**
 * Accessible radio group rendered as a row of pill buttons.
 *
 * - `role="radiogroup"` on the container, `role="radio"` on each pill.
 * - Roving tabindex: only the selected pill is focusable by Tab; arrows
 *   move focus and selection between pills (WAI-ARIA APG radio pattern).
 * - Enter / Space activate the focused pill (mostly a no-op since arrows
 *   already commit, but kept for parity with native radios).
 */
const SectionPicker: React.FC<SectionPickerProps> = ({
    value,
    onChange,
    onBlur,
    sections,
    id,
    labelledBy,
    describedBy,
    invalid,
    disabled,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);

    const focusPillAt = useCallback((index: number) => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        const pills = container.querySelectorAll<HTMLButtonElement>("[role='radio']");
        const target = pills[index];
        target?.focus();
    }, []);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (disabled === true) {
                return;
            }
            const currentIndex = sections.findIndex((s) => s.id === value);
            if (currentIndex === -1) {
                return;
            }
            const lastIndex = sections.length - 1;
            let nextIndex: number | undefined;

            switch (e.key) {
                case "ArrowRight":
                case "ArrowDown":
                    nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
                    break;
                case "ArrowLeft":
                case "ArrowUp":
                    nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
                    break;
                case "Home":
                    nextIndex = 0;
                    break;
                case "End":
                    nextIndex = lastIndex;
                    break;
                default:
                    return;
            }

            e.preventDefault();
            const next = sections[nextIndex];
            if (next === undefined) {
                return;
            }
            onChange(next.id);
            focusPillAt(nextIndex);
        },
        [disabled, focusPillAt, onChange, sections, value],
    );

    return (
        <div
            ref={containerRef}
            id={id}
            className="submit-section-picker"
            role="radiogroup"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-invalid={invalid === true ? true : undefined}
            aria-disabled={disabled === true ? true : undefined}
            onKeyDown={handleKeyDown}
            onBlur={onBlur}
        >
            {sections.map((section) => {
                const isSelected = section.id === value;
                return (
                    <button
                        key={section.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        className="submit-section-pill"
                        disabled={disabled}
                        onClick={() => onChange(section.id)}
                    >
                        {section.title}
                    </button>
                );
            })}
        </div>
    );
};

export default SectionPicker;
