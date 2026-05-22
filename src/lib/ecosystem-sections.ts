import { SECTIONS } from "../data/sections";
import type { SectionDef, SectionId } from "../data/types";

/**
 * Display metadata for the ecosystem-map sections shown to humans.
 *
 * The slug stored in `ExplorerApp.ecosystemSection` is one of the SectionId
 * values defined in `src/data/sections.ts`. This module re-exposes that
 * mapping in a shape oriented at consumers who only need the title.
 *
 * Kept small on purpose — section ids are a closed enum, so a Map suffices
 * and there is no need for a dynamic registry.
 */

export const SECTION_TITLES: ReadonlyMap<SectionId, string> = new Map(
    SECTIONS.map((section): [SectionId, string] => [section.id, section.title]),
);

export function getSectionDef(id: SectionId): SectionDef | undefined {
    return SECTIONS.find((section) => section.id === id);
}

export { SECTIONS };
