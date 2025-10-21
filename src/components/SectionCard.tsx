import React from "react";
import "./SectionCard.css";
import logoLinks from "./logoLinks";

interface SectionCardProps {
  title: string;
  logos: string[]; // array of filenames (e.g. "validators-1.png")
}

const SECTION_IMAGE_MAP: Record<string, string> = {
  Explorers: "explorers",
  Oracles: "oracles",
  Indexers: "indexers",
  dApps: "dapps",
  Validators: "validators",
  Providers: "providers",
  Bridges: "bridges",
  Core: "core",
  Auditors: "auditors",
  Wallets: "wallets",
  DAOs: "daos",
};

const SectionCard: React.FC<SectionCardProps> = ({ title, logos }) => {
  // Derive a safe CSS className from the title (e.g. "Validators" → "section-Validators")
  const cssKey = "section-" + title.replace(/\s+/g, "");
  const sectionFolder = SECTION_IMAGE_MAP[title] || title.toLowerCase();

  return (
    <div className={`section-card ${cssKey}`}>
      <div className="section-title">{title}</div>
      <div className="logo-grid">
        {logos.map((filename, idx) => {
          const link = logoLinks[filename];
          const imgElement = (
            <img
              src={`/assets/sections/${sectionFolder}/${filename}`}
              alt={filename}
              className="logo-image"
            />
          );
          return (
            <div className="logo-wrapper" key={idx}>
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {imgElement}
                </a>
              ) : (
                imgElement
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SectionCard;
