import { loadEnv } from "./env";
import type { ExplorerApp } from "./explorer-apps-types";
import type { SectionId } from "./schemas/ecosystem";
import { slugify } from "./slug";

/**
 * Typed `fetch` client for the Airtable submission queue.
 *
 * Airtable is the staging store for dApp submissions: `/api/submit` writes a
 * `Status = Pending` row (logo as an attachment) and **nothing touches S3**
 * until a reviewer approves it via `/explorer-admin`. This module is the
 * single I/O seam — tests stub `globalThis.fetch` without an Airtable SDK.
 *
 * Field addressing:
 *   - The attachment field is addressed by its STABLE id (`ICON_FIELD_ID`).
 *     In the base UI it is a template leftover literally named "Assignee";
 *     uploads target the id so a future rename can't break them.
 *   - Every other field is addressed by name — those names are owned by
 *     `scripts/airtable-setup.ts`, which provisions them on the table.
 *
 * Prerequisite: the table must carry the provisioned fields (Section, Long
 * description, Categories, Author, Site, GitHub, Submitter name, Status,
 * Registry id, Logo URL). Run `npm run airtable:setup` once with a PAT that
 * has Creator access to the base.
 */

const API_BASE = "https://api.airtable.com/v0";
const CONTENT_BASE = "https://content.airtable.com/v0";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 50;

/** Stable id of the attachment field (UI name: "Assignee"). */
export const ICON_FIELD_ID = "fldind6amgF8zBmR6";

const FIELD = {
    name: "Name",
    website: "Website",
    shortDescription: "Description",
    longDescription: "Long description",
    categories: "Categories",
    author: "Author",
    site: "Site",
    github: "GitHub",
    submitterName: "Submitter name",
    submitterEmail: "Contact email",
    section: "Section",
    status: "Status",
    registryId: "Registry id",
    logoUrl: "Logo URL",
    /** Attachment field, read path only — upload path uses ICON_FIELD_ID. */
    icon: "Assignee",
} as const;

export const STATUS = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
} as const;
export type SubmissionStatus = (typeof STATUS)[keyof typeof STATUS];

export class AirtableError extends Error {
    public readonly status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = "AirtableError";
        this.status = status;
    }
}

interface AirtableConfig {
    apiKey: string;
    baseId: string;
    tableId: string;
}

function config(): AirtableConfig {
    const env = loadEnv();
    if (!env.AIRTABLE_API_KEY) {
        throw new AirtableError("AIRTABLE_API_KEY is required for Airtable operations");
    }
    return {
        apiKey: env.AIRTABLE_API_KEY,
        baseId: env.AIRTABLE_BASE_ID,
        tableId: env.AIRTABLE_TABLE_ID,
    };
}

async function airtableFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text !== "") {
        try {
            json = JSON.parse(text) as Record<string, unknown>;
        } catch {
            json = {};
        }
    }
    if (!res.ok) {
        const err = json.error as { message?: string; type?: string } | string | undefined;
        const detail =
            typeof err === "string"
                ? err
                : err?.message ?? err?.type ?? text.slice(0, 200);
        throw new AirtableError(
            `Airtable ${init.method ?? "GET"} failed: HTTP ${res.status} ${detail}`,
            res.status,
        );
    }
    return json;
}

function authHeaders(apiKey: string, json = true): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
}

// ---------------------------------------------------------------------------
// create + attachment upload (submit path)
// ---------------------------------------------------------------------------

export interface SubmissionFields {
    name: string;
    url: string;
    /** Short tagline → registry `shortDescription`. */
    shortDescription: string;
    section: SectionId;
    /** Human-readable category labels (the `ExplorerCategory` enum values). */
    categories?: string[];
    longDescription?: string;
    author?: string;
    site?: string;
    github?: string;
    submitterEmail: string;
    submitterName?: string;
}

/** Create a `Status = Pending` submission row. Returns the new record id. */
export async function createSubmissionRecord(s: SubmissionFields): Promise<string> {
    const { apiKey, baseId, tableId } = config();
    const fields: Record<string, unknown> = {
        [FIELD.name]: s.name,
        [FIELD.website]: s.url,
        [FIELD.shortDescription]: s.shortDescription,
        [FIELD.section]: s.section,
        [FIELD.submitterEmail]: s.submitterEmail,
        [FIELD.status]: STATUS.pending,
    };
    if (s.longDescription !== undefined) fields[FIELD.longDescription] = s.longDescription;
    if (s.categories !== undefined && s.categories.length > 0) fields[FIELD.categories] = s.categories;
    if (s.author !== undefined) fields[FIELD.author] = s.author;
    if (s.site !== undefined) fields[FIELD.site] = s.site;
    if (s.github !== undefined) fields[FIELD.github] = s.github;
    if (s.submitterName !== undefined) fields[FIELD.submitterName] = s.submitterName;

    const json = await airtableFetch(`${API_BASE}/${baseId}/${tableId}`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ fields, typecast: true }),
    });
    if (typeof json.id !== "string") {
        throw new AirtableError("Airtable create returned no record id");
    }
    return json.id;
}

/**
 * Upload raw logo bytes into the record's attachment field via Airtable's
 * content-upload endpoint (no intermediate hosting, no S3). 5 MB cap — well
 * above the submission form's 500 KB limit.
 */
export async function uploadIcon(
    recordId: string,
    bytes: Buffer,
    contentType: string,
    filename: string,
): Promise<void> {
    const { apiKey, baseId } = config();
    await airtableFetch(`${CONTENT_BASE}/${baseId}/${recordId}/${ICON_FIELD_ID}/uploadAttachment`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ contentType, file: bytes.toString("base64"), filename }),
    });
}

/** Best-effort delete — used to roll back a record whose icon upload failed. */
export async function deleteRecord(recordId: string): Promise<void> {
    const { apiKey, baseId, tableId } = config();
    await airtableFetch(`${API_BASE}/${baseId}/${tableId}/${recordId}`, {
        method: "DELETE",
        headers: authHeaders(apiKey, false),
    });
}

// ---------------------------------------------------------------------------
// list pending (approval path)
// ---------------------------------------------------------------------------

/**
 * An `ExplorerApp` with the logo deferred until S3 upload at approval, and
 * `surfaces` deferred to the reviewer's per-row choice in `/explorer-admin`.
 * `ecosystemSection` is always carried (from the row's Section); the approval
 * step drops it when the chosen surfaces don't include `"ecosystem-map"`.
 */
export type ExplorerAppCandidate = Omit<ExplorerApp, "logo" | "surfaces">;

export interface PendingSubmission {
    recordId: string;
    candidate: ExplorerAppCandidate;
    /** Short-lived Airtable attachment URL; re-read per batch before download. */
    logoUrl?: string;
}

interface AirtableRecord {
    id: string;
    fields: Record<string, unknown>;
}

/** List rows where `Status = Pending`, mapped to registry candidates. */
export async function listPendingSubmissions(limit = DEFAULT_PAGE_SIZE): Promise<PendingSubmission[]> {
    const { apiKey, baseId, tableId } = config();
    const formula = encodeURIComponent(`{${FIELD.status}}='${STATUS.pending}'`);
    const url = `${API_BASE}/${baseId}/${tableId}?filterByFormula=${formula}&pageSize=${limit}`;
    const json = await airtableFetch(url, { method: "GET", headers: authHeaders(apiKey, false) });
    const records = (Array.isArray(json.records) ? json.records : []) as AirtableRecord[];
    const out: PendingSubmission[] = [];
    for (const rec of records) {
        const mapped = mapRecord(rec);
        if (mapped !== null) out.push(mapped);
    }
    return out;
}

function readString(fields: Record<string, unknown>, key: string): string | undefined {
    const v = fields[key];
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
}

function readAttachmentUrl(v: unknown): string | undefined {
    if (Array.isArray(v) && v.length > 0) {
        const first = v[0] as { url?: unknown } | null;
        if (first !== null && typeof first === "object" && typeof first.url === "string") {
            return first.url;
        }
    }
    return undefined;
}

/**
 * Build a registry candidate from a record. Returns `null` for rows missing a
 * required field (incomplete drafts) so they're skipped rather than crashing
 * the whole list. The candidate is re-validated with the Zod schema at
 * approval before any S3 write.
 */
function mapRecord(rec: AirtableRecord): PendingSubmission | null {
    const f = rec.fields;
    const name = readString(f, FIELD.name);
    const url = readString(f, FIELD.website);
    const shortDescription = readString(f, FIELD.shortDescription);
    const section = readString(f, FIELD.section);
    if (name === undefined || url === undefined || shortDescription === undefined || section === undefined) {
        return null;
    }
    const id = slugify(name);
    if (id === "") return null;

    const rawCategories = Array.isArray(f[FIELD.categories])
        ? (f[FIELD.categories] as unknown[]).filter((c): c is string => typeof c === "string")
        : [];
    const categories =
        rawCategories.length > 0
            ? rawCategories.map((c) => slugify(c)).filter((c) => c !== "")
            : [section];

    const candidate: ExplorerAppCandidate = {
        id,
        external: true,
        title: name,
        shortDescription,
        categories: categories.length > 0 ? categories : [section],
        author: readString(f, FIELD.author) ?? readString(f, FIELD.submitterName) ?? "Unknown",
        url,
        // surfaces are chosen by the reviewer at approval; ecosystemSection is
        // carried here and dropped at approval for dApps-only targets.
        ecosystemSection: section,
    };
    const longDescription = readString(f, FIELD.longDescription);
    if (longDescription !== undefined) candidate.description = longDescription;
    const site = readString(f, FIELD.site);
    if (site !== undefined) candidate.site = site;
    const github = readString(f, FIELD.github);
    if (github !== undefined) candidate.github = github;

    return { recordId: rec.id, candidate, logoUrl: readAttachmentUrl(f[FIELD.icon]) };
}

// ---------------------------------------------------------------------------
// status transitions (approve / reject)
// ---------------------------------------------------------------------------

export async function setStatus(
    recordId: string,
    status: SubmissionStatus,
    extra?: { registryId?: string; logoUrl?: string },
): Promise<void> {
    const { apiKey, baseId, tableId } = config();
    const fields: Record<string, unknown> = { [FIELD.status]: status };
    if (extra?.registryId !== undefined) fields[FIELD.registryId] = extra.registryId;
    if (extra?.logoUrl !== undefined) fields[FIELD.logoUrl] = extra.logoUrl;
    await airtableFetch(`${API_BASE}/${baseId}/${tableId}/${recordId}`, {
        method: "PATCH",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ fields, typecast: true }),
    });
}

/**
 * Download an attachment's bytes from its (short-lived) Airtable URL. No auth
 * header — the URL is a pre-signed `*.airtableusercontent.com` link.
 */
export async function downloadAttachment(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        throw new AirtableError(`Attachment download failed: HTTP ${res.status}`, res.status);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
