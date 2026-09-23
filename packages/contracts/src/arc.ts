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
  "arc.request.commented",
  "arc.request.voted",
  "arc.request.decided",
  "arc.request.letter_emailed",
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
  /** The association's own appeal wording, printed on every letter (AD2). */
  appealText: string | null;
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
  /** Comments the committee chose to show the homeowner. */
  messages: { body: string; createdAt: string }[];
  /** The decision, once there is one. The letter itself is at …/letter. */
  decision: {
    outcome: ArcDecisionOutcome;
    conditions: string | null;
    rationale: string | null;
    decidedAt: string;
    letterPath: string;
  } | null;
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
  appealText?: string | null;
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

// ── AD2: the review-board workflow ─────────────────────────

export const ARC_VOTES = ["approve", "approve_with_conditions", "deny", "abstain"] as const;
export type ArcVote = (typeof ARC_VOTES)[number];

export const ARC_DECISION_OUTCOMES = ["approved", "approved_with_conditions", "denied"] as const;
export type ArcDecisionOutcome = (typeof ARC_DECISION_OUTCOMES)[number];

export const ARC_DECISION_OUTCOME_LABELS: Record<ArcDecisionOutcome, string> = {
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  denied: "Denied",
};

export const ARC_COMMENT_VISIBILITIES = ["committee", "applicant"] as const;
export type ArcCommentVisibility = (typeof ARC_COMMENT_VISIBILITIES)[number];

/**
 * The appeal paragraph printed on a decision letter, by state. Statutory
 * wording is summarised, not quoted, and carries its citation; the
 * association's own `appealText` is printed after it (or instead of it, for
 * OTHER). Reviewed as legal content — see risks AD-A.
 */
export const ARC_APPEAL_LANGUAGE: Record<ArcState, { text: string; citation: string } | null> = {
  CA: {
    text:
      "If you disagree with this decision, you may ask the association's board of directors to reconsider it. " +
      "Reconsideration is heard at an open meeting of the board. Send your written request to the association " +
      "at the contact address below.",
    citation: "Cal. Civ. Code \u00a74765",
  },
  TX: {
    text:
      "If your application has been denied, you may request a hearing before the association's board of " +
      "directors. Send your written request to the association at the contact address below within 30 days " +
      "of the date of this letter. The board may affirm, change or overturn this decision.",
    citation: "Tex. Prop. Code \u00a7209.00505",
  },
  OTHER: null,
};

export interface PublicArcComment {
  id: string;
  authorSubjectId: string;
  body: string;
  visibility: ArcCommentVisibility;
  createdAt: string;
}

export interface PublicArcVote {
  voterSubjectId: string;
  vote: ArcVote;
  conditions: string | null;
  note: string | null;
  updatedAt: string;
}

export type ArcVoteTally = Record<ArcVote, number>;

export interface PublicArcDecision {
  id: string;
  outcome: ArcDecisionOutcome;
  conditions: string | null;
  rationale: string | null;
  voteTally: ArcVoteTally;
  letterSha256: string;
  letterPath: string;
  decidedBy: string | null;
  decidedAt: string;
  letterEmailedAt: string | null;
}

export interface CreateArcCommentRequest {
  body: string;
  visibility?: ArcCommentVisibility;
}
export interface ArcCommentResponse {
  comment: PublicArcComment;
}
export interface ListArcCommentsResponse {
  comments: PublicArcComment[];
}

export interface PutArcVoteRequest {
  vote: ArcVote;
  conditions?: string | null;
  note?: string | null;
}
export interface ArcVoteResponse {
  vote: PublicArcVote;
  tally: ArcVoteTally;
}
export interface ListArcVotesResponse {
  votes: PublicArcVote[];
  tally: ArcVoteTally;
}

export interface CreateArcDecisionRequest {
  outcome: ArcDecisionOutcome;
  conditions?: string | null;
  rationale?: string | null;
}
export interface ArcDecisionResponse {
  decision: PublicArcDecision;
}
