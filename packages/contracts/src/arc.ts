/**
 * Architectural review (`arc`) bounded context — the association's review
 * board, its document checklist, the homeowner's request and the documents
 * uploaded against it. The organization IS the association; the committee is
 * its members. The homeowner has no account: a status token is their key.
 */

export const ARC_STATES = ["CA", "TX", "OTHER"] as const;
export type ArcState = (typeof ARC_STATES)[number];

export const ARC_REQUEST_CATEGORIES = [
  "solar",
  "ev_charger",
  "exterior_paint",
  "fence",
  "roofing",
  "landscaping",
  "addition",
  "other",
] as const;
export type ArcRequestCategory = (typeof ARC_REQUEST_CATEGORIES)[number];

export const ARC_REQUEST_CATEGORY_LABELS: Record<ArcRequestCategory, string> = {
  solar: "Solar energy system",
  ev_charger: "EV charging station",
  exterior_paint: "Exterior paint or colour change",
  fence: "Fence or wall",
  roofing: "Roofing",
  landscaping: "Landscaping or hardscape",
  addition: "Addition or structural change",
  other: "Something else",
};

export const ARC_REQUEST_STATUSES = [
  "incomplete",
  "under_review",
  "approved",
  "approved_with_conditions",
  "denied",
  "withdrawn",
] as const;
export type ArcRequestStatus = (typeof ARC_REQUEST_STATUSES)[number];

/** Document types a homeowner may upload. Everything else is refused. */
export const ARC_UPLOAD_CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type ArcUploadContentType = (typeof ARC_UPLOAD_CONTENT_TYPES)[number];

/** Per-file ceiling for a homeowner upload (20 MB). */
export const ARC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The checklist a new board starts with. `categories: []` means "every
 * request"; otherwise the item gates only requests in those categories.
 */
export const ARC_DEFAULT_CHECKLIST: readonly {
  key: string;
  label: string;
  required: boolean;
  categories: readonly ArcRequestCategory[];
}[] = [
  { key: "site_plan", label: "Site plan showing the change and setbacks", required: true, categories: [] },
  { key: "elevations", label: "Elevation drawings or photos of the affected elevation", required: true, categories: [] },
  { key: "materials", label: "Materials and colours (samples, spec sheet or photos)", required: false, categories: [] },
  { key: "contractor_licence", label: "Contractor licence and insurance", required: false, categories: [] },
  { key: "panel_layout", label: "Panel layout on the roof plan", required: true, categories: ["solar"] },
  { key: "panel_spec", label: "Panel and inverter spec sheets", required: true, categories: ["solar"] },
  { key: "electrical_plan", label: "Electrical plan and charger location", required: true, categories: ["ev_charger"] },
];

export const ARC_EVENT_TYPES = [
  "arc.board.updated",
  "arc.request.submitted",
  "arc.request.document_uploaded",
  "arc.request.clock_started",
] as const;
export type ArcEventType = (typeof ARC_EVENT_TYPES)[number];

// ── Wire shapes ─────────────────────────────────────────────

export interface PublicArcBoard {
  id: string;
  orgId: string;
  publicSlug: string;
  associationName: string;
  state: ArcState;
  reviewDays: number;
  contactEmail: string;
  escalationEmail: string | null;
  formEnabled: boolean;
  formUrlPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicArcChecklistItem {
  id: string;
  key: string;
  label: string;
  required: boolean;
  categories: ArcRequestCategory[];
  position: number;
  archived: boolean;
}

export interface PublicArcDocument {
  id: string;
  checklistKey: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
}

export interface ArcChecklistState {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
}

export interface PublicArcRequest {
  id: string;
  orgId: string;
  number: number;
  reference: string;
  category: ArcRequestCategory;
  title: string;
  description: string;
  propertyAddress: string;
  applicantName: string;
  applicantEmail: string;
  status: ArcRequestStatus;
  submittedAt: string;
  clockStartedAt: string | null;
  decisionDueOn: string | null;
  decidedAt: string | null;
  checklistComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArcRequestDetail {
  request: PublicArcRequest;
  checklist: ArcChecklistState[];
  documents: PublicArcDocument[];
}

/** What the homeowner's status page sees. No emails, no internal ids. */
export interface ArcPublicStatus {
  reference: string;
  associationName: string;
  category: ArcRequestCategory;
  title: string;
  propertyAddress: string;
  status: ArcRequestStatus;
  submittedAt: string;
  clockStartedAt: string | null;
  decisionDueOn: string | null;
  decidedAt: string | null;
  checklist: ArcChecklistState[];
  documents: { checklistKey: string | null; filename: string; byteSize: number; uploadedAt: string }[];
}

export interface ArcPublicBoard {
  associationName: string;
  publicSlug: string;
  state: ArcState;
  categories: { key: ArcRequestCategory; label: string }[];
  checklist: { key: string; label: string; required: boolean; categories: ArcRequestCategory[] }[];
}

// ── Requests and responses ──────────────────────────────────

export interface PutArcBoardRequest {
  associationName: string;
  publicSlug: string;
  state?: ArcState;
  reviewDays?: number;
  contactEmail: string;
  escalationEmail?: string | null;
  formEnabled?: boolean;
}
export interface GetArcBoardResponse {
  board: PublicArcBoard;
}
export type PutArcBoardResponse = GetArcBoardResponse;

export interface CreateArcChecklistItemRequest {
  key: string;
  label: string;
  required?: boolean;
  categories?: ArcRequestCategory[];
  position?: number;
}
export interface UpdateArcChecklistItemRequest {
  label?: string;
  required?: boolean;
  categories?: ArcRequestCategory[];
  position?: number;
}
export interface ArcChecklistItemResponse {
  item: PublicArcChecklistItem;
}
export interface ListArcChecklistResponse {
  items: PublicArcChecklistItem[];
}

export interface ListArcRequestsResponse {
  requests: PublicArcRequest[];
}
export type GetArcRequestResponse = ArcRequestDetail;

export interface SubmitArcRequestRequest {
  category: ArcRequestCategory;
  title: string;
  description?: string;
  propertyAddress: string;
  applicantName: string;
  applicantEmail: string;
}
export interface SubmitArcRequestResponse {
  status: ArcPublicStatus;
  /** Shown once. Only its SHA-256 is stored. */
  statusToken: string;
  statusUrlPath: string;
}
export interface UploadArcDocumentResponse {
  document: PublicArcDocument;
  status: ArcPublicStatus;
  /** True when this upload was the one that started the decision clock. */
  clockStarted: boolean;
}
export interface GetArcPublicStatusResponse {
  status: ArcPublicStatus;
}
export interface GetArcPublicBoardResponse {
  board: ArcPublicBoard;
}

/** `AR-0042` — the reference a homeowner and the committee both quote. */
export function arcRequestReference(number: number): string {
  return `AR-${String(number).padStart(4, "0")}`;
}
