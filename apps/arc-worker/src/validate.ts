import {
  ARC_REQUEST_CATEGORIES,
  ARC_STATES,
  type ArcRequestCategory,
  type ArcState,
} from "@saas/contracts/arc";

export type Validation<T> = { valid: true; value: T } | { valid: false; fields: Record<string, string[]> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Collector {
  fields: Record<string, string[]> = {};
  add(field: string, message: string): void {
    (this.fields[field] ??= []).push(message);
  }
  get ok(): boolean {
    return Object.keys(this.fields).length === 0;
  }
}

function text(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; max: number },
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  if (typeof v !== "string") {
    c.add(field, "Must be a string");
    return undefined;
  }
  const trimmed = v.trim();
  if (opts.required && trimmed.length === 0) c.add(field, "Required");
  if (trimmed.length > opts.max) c.add(field, `At most ${opts.max} characters`);
  return trimmed;
}

function email(c: Collector, body: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const v = text(c, body, field, { required, max: 254 });
  if (v !== undefined && !EMAIL_RE.test(v)) c.add(field, "Not an email address");
  return v?.toLowerCase();
}

function categories(c: Collector, value: unknown, field: string): ArcRequestCategory[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
    c.add(field, "Must be an array of categories");
    return undefined;
  }
  const bad = value.filter((x) => !(ARC_REQUEST_CATEGORIES as readonly string[]).includes(x as string));
  if (bad.length > 0) c.add(field, `Unknown categories: ${bad.join(", ")}`);
  return value as ArcRequestCategory[];
}

export interface BoardFields {
  associationName: string;
  publicSlug: string;
  state: ArcState;
  reviewDays: number;
  contactEmail: string;
  escalationEmail: string | null;
  formEnabled: boolean;
}

export function validateBoardBody(body: unknown): Validation<BoardFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const associationName = text(c, body, "associationName", { required: true, max: 160 });
  const publicSlug = text(c, body, "publicSlug", { required: true, max: 48 })?.toLowerCase();
  if (publicSlug !== undefined && !SLUG_RE.test(publicSlug)) {
    c.add("publicSlug", "3–48 lowercase letters, digits and hyphens");
  }
  const state = body.state ?? "CA";
  if (typeof state !== "string" || !(ARC_STATES as readonly string[]).includes(state)) {
    c.add("state", `One of ${ARC_STATES.join(", ")}`);
  }
  const reviewDays = body.reviewDays ?? 30;
  if (typeof reviewDays !== "number" || !Number.isInteger(reviewDays) || reviewDays < 1 || reviewDays > 365) {
    c.add("reviewDays", "A whole number of days from 1 to 365");
  }
  const contactEmail = email(c, body, "contactEmail", true);
  const escalationEmail = email(c, body, "escalationEmail", false);
  const formEnabled = body.formEnabled ?? true;
  if (typeof formEnabled !== "boolean") c.add("formEnabled", "Must be a boolean");
  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: {
      associationName: associationName!,
      publicSlug: publicSlug!,
      state: state as ArcState,
      reviewDays: reviewDays as number,
      contactEmail: contactEmail!,
      escalationEmail: escalationEmail ?? null,
      formEnabled: formEnabled as boolean,
    },
  };
}

export interface ChecklistFields {
  key?: string;
  label?: string;
  required?: boolean;
  categories?: ArcRequestCategory[];
  position?: number;
}

export function validateChecklistBody(body: unknown, partial: boolean): Validation<ChecklistFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const out: ChecklistFields = {};
  if (!partial) {
    const key = text(c, body, "key", { required: true, max: 40 });
    if (key !== undefined && !KEY_RE.test(key)) c.add("key", "Lowercase letters, digits and underscores, starting with a letter");
    if (key !== undefined) out.key = key;
  } else if (body.key !== undefined) {
    c.add("key", "The key of a checklist item cannot change");
  }
  const label = text(c, body, "label", { required: !partial, max: 200 });
  if (label !== undefined) out.label = label;
  if (body.required !== undefined) {
    if (typeof body.required !== "boolean") c.add("required", "Must be a boolean");
    else out.required = body.required;
  }
  const cats = categories(c, body.categories, "categories");
  if (cats !== undefined) out.categories = cats;
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0 || body.position > 1000) {
      c.add("position", "A whole number from 0 to 1000");
    } else out.position = body.position;
  }
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: out };
}

export interface SubmitFields {
  category: ArcRequestCategory;
  title: string;
  description: string;
  propertyAddress: string;
  applicantName: string;
  applicantEmail: string;
}

export function validateSubmitBody(body: unknown): Validation<SubmitFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const category = body.category;
  if (typeof category !== "string" || !(ARC_REQUEST_CATEGORIES as readonly string[]).includes(category)) {
    c.add("category", `One of ${ARC_REQUEST_CATEGORIES.join(", ")}`);
  }
  const title = text(c, body, "title", { required: true, max: 160 });
  const description = text(c, body, "description", { required: false, max: 5000 });
  const propertyAddress = text(c, body, "propertyAddress", { required: true, max: 300 });
  const applicantName = text(c, body, "applicantName", { required: true, max: 160 });
  const applicantEmail = email(c, body, "applicantEmail", true);
  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: {
      category: category as ArcRequestCategory,
      title: title!,
      description: description ?? "",
      propertyAddress: propertyAddress!,
      applicantName: applicantName!,
      applicantEmail: applicantEmail!,
    },
  };
}

/** A filename safe to echo back and to put in a Content-Disposition header. */
export function sanitizeFilename(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120);
  return clean.length > 0 ? clean : "document";
}
