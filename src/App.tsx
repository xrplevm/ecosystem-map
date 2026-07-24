import React, { useCallback, useEffect, useMemo, useState } from "react";

import "./App.css";
import BrandLines from "./components/BrandLines";
import Header from "./components/Header";
import SectionCard from "./components/SectionCard";
import SubmitProjectButton from "./components/SubmitProjectButton";
import { SECTIONS } from "./data/sections";
import type { SectionId } from "./data/types";
import {
    type LoadResult,
    groupByEcosystemSection,
    loadExplorerApps,
} from "./lib/explorer-apps-source";
import type { ExplorerApp } from "./lib/explorer-apps-types";

const FOOTER_REVEAL_DELAY_MS = 500;

type EntriesBySection = Partial<Record<SectionId, ExplorerApp[]>>;

type LoadStatus =
    | { kind: "loading" }
    | { kind: "ready"; result: LoadResult }
    | { kind: "error"; message: string };

function toEntriesBySection(apps: ExplorerApp[]): EntriesBySection {
    const grouped = groupByEcosystemSection(apps);
    const out: EntriesBySection = {};
    grouped.forEach((entries, sectionId) => {
        out[sectionId] = entries;
    });
    return out;
}

function App() {
    const [showFooter, setShowFooter] = useState(true);
    const [status, setStatus] = useState<LoadStatus>({ kind: "loading" });
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setStatus({ kind: "loading" });
        loadExplorerApps({ bypassCache: reloadToken > 0 })
            .then((result) => {
                if (!cancelled) {
                    setStatus({ kind: "ready", result });
                }
            })
            .catch((error: unknown) => {
                if (cancelled) {
                    return;
                }
                const message = error instanceof Error ? error.message : "Unknown error";
                setStatus({ kind: "error", message });
            });
        return () => {
            cancelled = true;
        };
    }, [reloadToken]);

    const entriesBySection = useMemo<EntriesBySection>(() => {
        if (status.kind !== "ready") {
            return {};
        }
        return toEntriesBySection(status.result.apps);
    }, [status]);

    useEffect(() => {
        let timeoutId: ReturnType<typeof setTimeout>;
        const handleScroll = () => {
            setShowFooter(false);
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                setShowFooter(true);
            }, FOOTER_REVEAL_DELAY_MS);
        };
        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
            clearTimeout(timeoutId);
        };
    }, []);

    const retry = useCallback(() => setReloadToken((token) => token + 1), []);

    return (
        <div className="App">
            <BrandLines />

            <div className="cards-layout">
                <div className="header-grid-item">
                    <Header />
                </div>
                {SECTIONS.map((section) => (
                    <SectionCard key={section.id} section={section} entries={entriesBySection[section.id] ?? []} />
                ))}
            </div>

            {status.kind === "error" && (
                <div className="app-load-banner app-load-banner-error" role="alert">
                    <span>Could not load the ecosystem registry: {status.message}.</span>
                    <button type="button" onClick={retry}>
                        Retry
                    </button>
                </div>
            )}

            <footer className={`app-footer${showFooter ? " visible" : " hidden"}`}>
                <div className="app-footer-content">
                    <div>
                        <SubmitProjectButton />
                    </div>
                    <div>
                        Follow&nbsp;
                        <a href="https://x.com/intent/follow?screen_name=Peersyst" target="_blank" rel="noopener noreferrer">
                            Peersyst
                        </a>
                        &nbsp;on&nbsp;𝕏
                    </div>
                    <div>
                        Join&nbsp;
                        <a href="https://discord.gg/xrplevm" target="_blank" rel="noopener noreferrer">
                            Discord
                        </a>
                    </div>
                </div>
            </footer>
        </div>
    );
}

export default App;
