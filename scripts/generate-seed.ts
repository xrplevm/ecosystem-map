#!/usr/bin/env node
/**
 * `generate-seed` — offline merger that produces the phase-7h migration
 * seed by combining the canonical `explorer-apps.json` registry with the
 * legacy `src/data/ecosystem.json` hardcoded list.
 *
 * Run with:
 *   npm run generate-seed -- [--explorer-apps <path|url>] [--ecosystem <path>]
 *                            [--out <path>] [--report <path>]
 *
 * Defaults assume execution from the repo root.
 *
 * The script intentionally stays read-only with respect to the production
 * S3 bucket; the human reviewer inspects the generated seed and the
 * companion report, then triggers upload via the Slack flow defined in
 * sub-task E (`/explorer-admin → Apply seed`). See README "Seed migration".
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
    buildSeed,
    formatReport,
    type EcosystemEntryInput,
    type ExplorerAppsEntryInput,
} from "./lib/seed-builder";

const DEFAULT_EXPLORER_APPS_URL =
    "https://peersyst-development.s3.eu-west-1.amazonaws.com/explorer-apps.json";
const DEFAULT_ECOSYSTEM_PATH = "src/data/ecosystem.json";
const DEFAULT_OUT_PATH = "progress/seed-merged-explorer-apps.json";
const DEFAULT_REPORT_PATH = "progress/seed-migration-report.md";

interface CliOptions {
    explorerApps: string;
    ecosystem: string;
    out: string;
    report: string;
}

const HELP = `generate-seed — offline migration seed builder

Usage:
  tsx scripts/generate-seed.ts [options]

Options:
  --explorer-apps <path|url>   Source of the canonical registry.
                               Default: ${DEFAULT_EXPLORER_APPS_URL}
  --ecosystem <path>           Local ecosystem.json file.
                               Default: ${DEFAULT_ECOSYSTEM_PATH}
  --out <path>                 Output JSON path for the merged seed.
                               Default: ${DEFAULT_OUT_PATH}
  --report <path>              Output Markdown report path.
                               Default: ${DEFAULT_REPORT_PATH}
  -h, --help                   Show this help and exit.

Notes:
  - The script is read-only against S3. Review the generated seed and
    report before uploading via the Slack flow.
  - Mismatches between the two sources are reported but resolved silently
    in favour of explorer-apps (it is the source-of-truth registry).
`;

class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CliError";
    }
}

function parseArgs(argv: readonly string[]): CliOptions | "help" {
    const options: CliOptions = {
        explorerApps: DEFAULT_EXPLORER_APPS_URL,
        ecosystem: DEFAULT_ECOSYSTEM_PATH,
        out: DEFAULT_OUT_PATH,
        report: DEFAULT_REPORT_PATH,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help") {
            return "help";
        }
        const next = argv[i + 1];
        switch (arg) {
            case "--explorer-apps":
                if (!next) throw new CliError(`${arg} requires a value`);
                options.explorerApps = next;
                i += 1;
                break;
            case "--ecosystem":
                if (!next) throw new CliError(`${arg} requires a value`);
                options.ecosystem = next;
                i += 1;
                break;
            case "--out":
                if (!next) throw new CliError(`${arg} requires a value`);
                options.out = next;
                i += 1;
                break;
            case "--report":
                if (!next) throw new CliError(`${arg} requires a value`);
                options.report = next;
                i += 1;
                break;
            default:
                throw new CliError(`unknown argument: ${arg}`);
        }
    }
    return options;
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//u.test(value);
}

async function loadJson<T>(source: string, label: string): Promise<T> {
    if (isHttpUrl(source)) {
        const response = await fetch(source);
        if (!response.ok) {
            throw new CliError(
                `failed to fetch ${label} from ${source}: HTTP ${response.status}`,
            );
        }
        return (await response.json()) as T;
    }
    const absolute = path.resolve(source);
    const raw = await fs.readFile(absolute, "utf8");
    try {
        return JSON.parse(raw) as T;
    } catch (cause) {
        throw new CliError(
            `failed to parse ${label} at ${absolute}: ${(cause as Error).message}`,
        );
    }
}

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
    const absolute = path.resolve(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
}

async function main(argv: readonly string[]): Promise<void> {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
        process.stdout.write(HELP);
        return;
    }
    const options = parsed;

    const explorerApps = await loadJson<ExplorerAppsEntryInput[]>(
        options.explorerApps,
        "explorer-apps",
    );
    const ecosystem = await loadJson<EcosystemEntryInput[]>(options.ecosystem, "ecosystem");

    if (!Array.isArray(explorerApps)) {
        throw new CliError("explorer-apps source did not parse to an array");
    }
    if (!Array.isArray(ecosystem)) {
        throw new CliError("ecosystem source did not parse to an array");
    }

    const { entries, report } = buildSeed(explorerApps, ecosystem);

    await writeFileEnsuringDir(options.out, `${JSON.stringify(entries, null, 2)}\n`);
    await writeFileEnsuringDir(options.report, formatReport(report));

    // Summary on stdout — operator-friendly. Avoids `console.log` spam by
    // using a single multi-line write so test harnesses can capture it
    // verbatim if needed.
    process.stdout.write(
        [
            `seed written → ${options.out}`,
            `report written → ${options.report}`,
            `counts: explorer-apps=${report.explorerAppsCount}` +
                ` ecosystem=${report.ecosystemCount}` +
                ` merged=${report.mergedCount}` +
                ` matches=${report.matches.length}` +
                ` creates=${report.creates.length}` +
                ` mismatches=${report.mismatches.length}` +
                ` skipped=${report.skipped.length}`,
            "",
        ].join("\n"),
    );
}

main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`generate-seed: ${message}\n`);
    process.exitCode = 1;
});
