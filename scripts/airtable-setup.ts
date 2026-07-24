#!/usr/bin/env tsx
/**
 * airtable-setup — idempotently provision the submission-pipeline fields on the
 * Airtable table that backs dApp submissions (design spec
 * `docs/superpowers/specs/2026-06-16-airtable-staged-submissions-design.md`).
 *
 * Field choice lists are imported from the app schemas so Airtable stays in
 * sync with the code (sections + categories).
 *
 * Requires a Personal Access Token (`AIRTABLE_API_KEY`) with both
 * `schema.bases:read` and `schema.bases:write` on the base — the create-field
 * endpoint resolves the table via the schema surface, which needs read, so
 * write alone returns 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND. The script
 * creates each field and treats a duplicate-name error as "already exists",
 * so it is safe to re-run.
 *
 * Run:
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… AIRTABLE_TABLE_ID=… npm run airtable:setup
 */
import { SECTION_IDS } from "../src/lib/schemas/ecosystem";
import { EXPLORER_CATEGORIES } from "../src/lib/schemas/explorer-apps";

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_ID = process.env.AIRTABLE_TABLE_ID;

if (!API_KEY || !BASE_ID || !TABLE_ID) {
    console.error("Missing AIRTABLE_API_KEY / AIRTABLE_BASE_ID / AIRTABLE_TABLE_ID in the environment.");
    process.exit(1);
}

interface FieldDef {
    name: string;
    type: string;
    options?: { choices: Array<{ name: string }> };
}

const select = (names: readonly string[]) => ({ choices: names.map((name) => ({ name })) });

/** New fields the submission pipeline needs (existing columns are left alone). */
const FIELDS: FieldDef[] = [
    { name: "Section", type: "singleSelect", options: select(SECTION_IDS) },
    { name: "Long description", type: "multilineText" },
    { name: "Categories", type: "multipleSelects", options: select(EXPLORER_CATEGORIES) },
    { name: "Author", type: "singleLineText" },
    { name: "Site", type: "url" },
    { name: "GitHub", type: "url" },
    { name: "Submitter name", type: "singleLineText" },
    { name: "Status", type: "singleSelect", options: select(["Pending", "Approved", "Rejected"]) },
    { name: "Registry id", type: "singleLineText" },
    { name: "Logo URL", type: "url" },
];

const ENDPOINT = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${TABLE_ID}/fields`;

type Result = "created" | "exists" | "error";

async function createField(field: FieldDef): Promise<Result> {
    const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(field),
    });
    if (res.ok) return "created";
    const text = await res.text();
    if (res.status === 403) {
        throw new Error("PERMISSION");
    }
    if (res.status === 422 && /duplicate|unique|already|same name/i.test(text)) {
        return "exists";
    }
    console.error(`    HTTP ${res.status}: ${text}`);
    return "error";
}

async function main(): Promise<void> {
    console.log(`Provisioning ${FIELDS.length} fields on table ${TABLE_ID} …`);
    let created = 0;
    let exists = 0;
    let errors = 0;
    for (const field of FIELDS) {
        let result: Result;
        try {
            result = await createField(field);
        } catch (err) {
            if ((err as Error).message === "PERMISSION") {
                console.error(
                    "\nHTTP 403 — the token needs BOTH `schema.bases:read` and " +
                        "`schema.bases:write` (write alone can't resolve the table).\n" +
                        "Add the missing scope at https://airtable.com/create/tokens, then re-run " +
                        "`npm run airtable:setup`.",
                );
                process.exit(2);
            }
            throw err;
        }
        const mark = result === "created" ? "+" : result === "exists" ? "·" : "x";
        console.log(`  ${mark} ${field.name} (${result})`);
        if (result === "created") created += 1;
        else if (result === "exists") exists += 1;
        else errors += 1;
    }
    console.log(`\nDone: ${created} created, ${exists} already existed, ${errors} errors.`);
    process.exit(errors > 0 ? 1 : 0);
}

void main();
