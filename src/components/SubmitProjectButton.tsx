import React, { useCallback, useState } from "react";

import "./SubmitProjectForm.css";
import { SparkleIcon } from "./submitFormIcons";
import SubmitProjectModal from "./SubmitProjectModal";

const AIRTABLE_FALLBACK_URL = "https://airtable.com/appDFL9N9MDWj0Ywd/shrl5nsqAhtghUN8I";

const SubmitProjectButton: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);

    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);

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
