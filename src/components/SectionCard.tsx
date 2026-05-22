import React from "react";

import "./SectionCard.css";
import type { ExplorerApp } from "../lib/explorer-apps-types";
import type { SectionDef } from "../data/types";

interface SectionCardProps {
    section: SectionDef;
    entries: ExplorerApp[];
}

const SectionCard: React.FC<SectionCardProps> = ({ section, entries }) => {
    const cssKey = "section-" + section.title.replace(/\s+/g, "");

    return (
        <div className={`section-card ${cssKey}`}>
            <div className="section-title">{section.title}</div>
            <div className="logo-grid">
                {entries.map((entry) => {
                    if (!entry.url) {
                        return null;
                    }
                    return (
                        <div className="logo-wrapper" key={entry.id}>
                            <a href={entry.url} target="_blank" rel="noopener noreferrer">
                                <img src={entry.logo} alt={entry.title} className="logo-image" />
                            </a>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default SectionCard;
