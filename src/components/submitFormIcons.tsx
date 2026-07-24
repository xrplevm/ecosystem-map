import React from "react";

/**
 * Minimal inline SVG icons for the submission form.
 *
 * They live here (not in a generic `icons/` dir) because they are only used
 * by the submission UI and are not part of any wider design system. Each one
 * is sized via the parent CSS (`width: 100%; height: 100%`) and inherits
 * `currentColor` from the label / button — no external icon library needed.
 *
 * Stroke widths are tuned for ~14px label icons; if a larger usage appears
 * later, prefer adding a new icon over rescaling these and breaking stroke.
 */

interface IconProps {
    className?: string;
    "aria-hidden"?: boolean;
}

const baseProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    viewBox: "0 0 20 20",
};

export const CardIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <rect x="3" y="4.5" width="14" height="11" rx="2" />
        <path d="M3 8.5h14" />
    </svg>
);

export const LayersIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <path d="M10 3 3 6.5 10 10l7-3.5L10 3Z" />
        <path d="M3 10l7 3.5L17 10" />
        <path d="M3 13.5l7 3.5 7-3.5" />
    </svg>
);

export const LinkIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1" />
        <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1" />
    </svg>
);

export const ChatIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <path d="M3.5 6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5l-3.5 3v-3h-.5a2 2 0 0 1-2-2V6Z" />
    </svg>
);

export const MailIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <rect x="3" y="5" width="14" height="10" rx="2" />
        <path d="m3.5 6 6.5 5 6.5-5" />
    </svg>
);

export const UserIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <circle cx="10" cy="7.5" r="3" />
        <path d="M4 16c0-2.8 2.7-5 6-5s6 2.2 6 5" />
    </svg>
);

export const UploadIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <path d="M10 14V4" />
        <path d="m6 8 4-4 4 4" />
        <path d="M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
);

export const CheckCircleIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <circle cx="10" cy="10" r="7.5" />
        <path d="m6.5 10.2 2.6 2.6 4.4-5" />
    </svg>
);

export const AlertCircleIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <circle cx="10" cy="10" r="7.5" />
        <path d="M10 6.5v4.5" />
        <path d="M10 13.5h.01" />
    </svg>
);

export const SparkleIcon: React.FC<IconProps> = (props) => (
    <svg {...baseProps} {...props} aria-hidden={props["aria-hidden"] ?? true}>
        <path d="M10 3v3" />
        <path d="M10 14v3" />
        <path d="M3 10h3" />
        <path d="M14 10h3" />
        <path d="m5.5 5.5 1.7 1.7" />
        <path d="m12.8 12.8 1.7 1.7" />
        <path d="m14.5 5.5-1.7 1.7" />
        <path d="m7.2 12.8-1.7 1.7" />
    </svg>
);
