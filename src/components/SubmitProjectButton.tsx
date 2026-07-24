import React, { useCallback, useState } from "react";

import { useSubmissionsEnabled } from "../lib/useSubmissionsEnabled";
import "./SubmitProjectForm.css";
import { SparkleIcon } from "./submitFormIcons";
import SubmitProjectModal from "./SubmitProjectModal";

const AIRTABLE_FALLBACK_URL = "https://airtable.com/appDFL9N9MDWj0Ywd/shrl5nsqAhtghUN8I";

const SubmitProjectButton: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const { enabled, loading } = useSubmissionsEnabled();

    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);

    // Until the backend confirms the in-app flow is usable (Slack configured),
    // the primary CTA links straight to the public Airtable form. This keeps the
    // default — and any misconfigured or offline deploy — from opening a modal
    // whose POST to `/api/submit` would fail. The secondary "Or submit via
    // Airtable" link is dropped here since the button already points there.
    if (loading || !enabled) {
        return (
            <div className="submit-cta">
                <a
                    className="submit-cta-button"
                    href={AIRTABLE_FALLBACK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <span className="submit-cta-button-icon" aria-hidden="true">
                        <SparkleIcon />
                    </span>
                    Submit your project
                </a>
            </div>
        );
    }

    return (
        <div className="submit-cta">
            <button type="button" className="submit-cta-button" onClick={open}>
                <span className="submit-cta-button-icon" aria-hidden="true">
                    <SparkleIcon />
                </span>
                Submit your project
            </button>
            <div className="submit-cta-fallback">
                Or submit via{" "}
                <a href={AIRTABLE_FALLBACK_URL} target="_blank" rel="noopener noreferrer">
                    Airtable
                </a>
            </div>
            <SubmitProjectModal isOpen={isOpen} onClose={close} />
        </div>
    );
};

export default SubmitProjectButton;
