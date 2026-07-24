import React, { useCallback, useMemo, useRef } from "react";

import type { ExplorerCategory } from "../lib/schemas/explorer-apps";

interface CategoryPickerProps {
    /** Currently selected categories. Controlled. Order is preserved. */
    value: ReadonlyArray<ExplorerCategory>;
    /** Fired when the user toggles a chip via click or Space/Enter. */
    onChange: (next: ExplorerCategory[]) => void;
    /** Optional blur passthrough for RHF integration. */
    onBlur?: () => void;
    /** Categories to render as chips. Order is preserved. */
    options: ReadonlyArray<ExplorerCategory>;
    /** Maximum number of simultaneously-selected categories. Chips beyond
     *  this cap become disabled until the user deselects one. */
    max: number;
    /** DOM id of the picker container, used by the outer label. */
    id: string;
    /**
     * id of the visible label element. Required for a11y — `role="group"`
     * has no implicit name. A `<label htmlFor>` cannot point at a `<div>` so
     * we explicitly wire `aria-labelledby` instead.
     */
    labelledBy: string;
    describedBy?: string;
    invalid?: boolean;
    disabled?: boolean;
}

/**
 * Accessible multi-select rendered as a row of pill chips.
 *
 * - `role="group"` on the container, `role="checkbox"` on each chip with
 *   `aria-checked={selected}`. This is the WAI-ARIA APG pattern for a set
 *   of independent toggle controls (in contrast to `radiogroup`, where
 *   exactly one option is selected at a time).
 * - Arrow keys move focus between chips without toggling — Space or Enter
 *   commit the toggle. This mirrors the WAI-ARIA "checkbox group" guidance
 *   and matches what the `SectionPicker` does for navigation.
 * - When `value.length === max`, all unselected chips become disabled with
 *   `aria-disabled="true"` so the user can't blow past the cap silently.
 */
const CategoryPicker: React.FC<CategoryPickerProps> = ({
    value,
    onChange,
    onBlur,
    options,
    max,
    id,
    labelledBy,
    describedBy,
    invalid,
    disabled,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Memoised so `toggle` doesn't see a brand-new Set every render. Cheap to
    // skip the rebuild when `value` is referentially stable — and avoids a
    // dependency footgun in the callback below.
    const selected = useMemo(() => new Set<ExplorerCategory>(value), [value]);
    const atCap = value.length >= max;

    const focusChipAt = useCallback((index: number) => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        const chips = container.querySelectorAll<HTMLButtonElement>("[role='checkbox']");
        const target = chips[index];
        target?.focus();
    }, []);

    const toggle = useCallback(
        (category: ExplorerCategory) => {
            if (disabled === true) {
                return;
            }
            if (selected.has(category)) {
                onChange(value.filter((c) => c !== category));
                return;
            }
            if (value.length >= max) {
                return;
            }
            onChange([...value, category]);
        },
        [disabled, max, onChange, selected, value],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (disabled === true) {
                return;
            }
            const target = e.target as HTMLElement;
            if (target.getAttribute("role") !== "checkbox") {
                return;
            }
            const container = containerRef.current;
            if (container === null) {
                return;
            }
            const chips = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='checkbox']"));
            const currentIndex = chips.indexOf(target as HTMLButtonElement);
            if (currentIndex === -1) {
                return;
            }
            const lastIndex = chips.length - 1;
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
            focusChipAt(nextIndex);
        },
        [disabled, focusChipAt],
    );

    return (
        <div
            ref={containerRef}
            id={id}
            className="submit-category-picker"
            role="group"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-invalid={invalid === true ? true : undefined}
            aria-disabled={disabled === true ? true : undefined}
            onKeyDown={handleKeyDown}
            onBlur={onBlur}
        >
            {options.map((category) => {
                const isSelected = selected.has(category);
                // Lock out unselected chips when at cap so keyboard + click
                // both communicate "cap reached" the same way.
                const isLocked = !isSelected && atCap;
                return (
                    <button
                        key={category}
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-disabled={isLocked || disabled === true ? true : undefined}
                        className="submit-category-chip"
                        disabled={disabled === true || isLocked}
                        onClick={() => toggle(category)}
                    >
                        {category}
                    </button>
                );
            })}
        </div>
    );
};

export default CategoryPicker;
