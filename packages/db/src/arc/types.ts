// Architectural review (arc) bounded context — row shapes and repository seam.
//
// Timestamps are ISO-8601 strings end to end: D1 stores TEXT, the wire carries
// strings, and nothing in this context does date arithmetic on a `Date` that a
// string comparison of ISO dates would not do as well.

export interface ArcBoard {
  id: string;
  orgId: string;
  publicSlug: string;
  associationName: string;
  state: string;
  reviewDays: number;
  contactEmail: string;
  escalationEmail: string | null;
  formEnabled: boolean;
  appealText: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertArcBoardInput {
  id: string;
  orgId: string;
  publicSlug: string;
  associationName: string;
  state: string;
  reviewDays: number;
  contactEmail: string;
  escalationEmail: string | null;
  formEnabled: boolean;
  appealText: string | null;
  createdBy: string | null;
  now: string;
}

export interface ArcChecklistItem {
  id: string;
  orgId: string;
  boardId: string;
  key: string;
  label: string;
  required: boolean;
  /** Categories the item gates; empty means every category. */
  categories: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateArcChecklistItemInput {
  id: string;
  orgId: string;
  boardId: string;
  key: string;
  label: string;
  required: boolean;
  categories: string[];
  position: number;
  now: string;
}

export interface UpdateArcChecklistItemInput {
  label?: string | undefined;
  required?: boolean | undefined;
  categories?: string[] | undefined;
  position?: number | undefined;
  now: string;
}

export interface ArcRequest {
  id: string;
  orgId: string;
  boardId: string;
  number: number;
  category: string;
  title: string;
  description: string;
  propertyAddress: string;
  applicantName: string;
  applicantEmail: string;
  status: string;
  submittedAt: string;
  clockStartedAt: string | null;
  decisionDueOn: string | null;
  decidedAt: string | null;
  deadlineRule: string | null;
  deadlineMissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateArcRequestInput {
  id: string;
  orgId: string;
  boardId: string;
  number: number;
  category: string;
  title: string;
  description: string;
  propertyAddress: string;
  applicantName: string;
  applicantEmail: string;
  statusTokenHash: string;
  now: string;
}

export interface ArcDocument {
  id: string;
  orgId: string;
  requestId: string;
  checklistKey: string | null;
  objectKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
}

export type CreateArcDocumentInput = ArcDocument;

export interface ListArcRequestsFilter {
  status?: string | undefined;
  /** Only running requests due on or before this ISO date, soonest first (AD3). */
  dueOnOrBefore?: string | undefined;
  limit: number;
  /** Keyset cursor: requests created strictly before this (createdAt, id). */
  before?: { createdAt: string; id: string } | undefined;
}

export interface ArcComment {
  id: string;
  orgId: string;
  requestId: string;
  authorSubjectId: string;
  body: string;
  visibility: string;
  createdAt: string;
}

export type CreateArcCommentInput = ArcComment;

export interface ArcVoteRow {
  id: string;
  orgId: string;
  requestId: string;
  voterSubjectId: string;
  vote: string;
  conditions: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertArcVoteInput {
  id: string;
  orgId: string;
  requestId: string;
  voterSubjectId: string;
  vote: string;
  conditions: string | null;
  note: string | null;
  now: string;
}

export interface ArcDecision {
  id: string;
  orgId: string;
  requestId: string;
  outcome: string;
  conditions: string | null;
  rationale: string | null;
  voteTally: Record<string, number>;
  letterObjectKey: string;
  letterSha256: string;
  decidedBy: string | null;
  decidedAt: string;
  letterEmailedAt: string | null;
}

export interface CreateArcDecisionInput extends Omit<ArcDecision, "letterEmailedAt"> {
  letterTokenHash: string;
}

export interface ArcRepository {
  getBoardByOrg(orgId: string): Promise<ArcBoard | null>;
  getBoardBySlug(slug: string): Promise<ArcBoard | null>;
  getBoardById(boardId: string): Promise<ArcBoard | null>;
  /** Create-or-update by org. Throws a unique violation when the slug is taken by another org. */
  upsertBoard(input: UpsertArcBoardInput): Promise<{ board: ArcBoard; created: boolean }>;

  listChecklist(boardId: string, includeArchived: boolean): Promise<ArcChecklistItem[]>;
  getChecklistItem(orgId: string, itemId: string): Promise<ArcChecklistItem | null>;
  /** Returns null when the key already exists on the board. */
  createChecklistItem(input: CreateArcChecklistItemInput): Promise<ArcChecklistItem | null>;
  updateChecklistItem(orgId: string, itemId: string, patch: UpdateArcChecklistItemInput): Promise<ArcChecklistItem | null>;
  archiveChecklistItem(orgId: string, itemId: string, now: string): Promise<ArcChecklistItem | null>;

  /** Advance the board's request sequence and return the number allocated. */
  allocateRequestNumber(boardId: string): Promise<number>;
  createRequest(input: CreateArcRequestInput): Promise<ArcRequest>;
  getRequest(orgId: string, requestId: string): Promise<ArcRequest | null>;
  getRequestByTokenHash(tokenHash: string): Promise<ArcRequest | null>;
  listRequests(orgId: string, filter: ListArcRequestsFilter): Promise<ArcRequest[]>;

  createDocument(input: CreateArcDocumentInput): Promise<ArcDocument>;
  listDocuments(requestId: string): Promise<ArcDocument[]>;
  getDocument(orgId: string, requestId: string, documentId: string): Promise<ArcDocument | null>;

  /**
   * Start the decision clock if — and only if — the request is still
   * `incomplete` and every required, applicable, non-archived checklist item
   * has a document. One conditional statement, so two concurrent final
   * uploads cannot both start it. Returns the updated request, or null when
   * nothing changed.
   */
  tryStartClock(requestId: string, now: string): Promise<ArcRequest | null>;

  // ── AD2 ──
  createComment(input: CreateArcCommentInput): Promise<ArcComment>;
  listComments(requestId: string, visibility?: string): Promise<ArcComment[]>;
  /** Insert or replace the voter's vote — UNIQUE (request_id, voter_subject_id). */
  upsertVote(input: UpsertArcVoteInput): Promise<ArcVoteRow>;
  listVotes(requestId: string): Promise<ArcVoteRow[]>;
  /** Returns null when the request already has a decision. */
  createDecision(input: CreateArcDecisionInput): Promise<ArcDecision | null>;
  getDecision(requestId: string): Promise<ArcDecision | null>;
  getDecisionByLetterTokenHash(tokenHash: string): Promise<ArcDecision | null>;
  markLetterEmailed(decisionId: string, at: string): Promise<void>;
  /** Close an under-review request with its outcome; null when it was not under review. */
  closeRequest(requestId: string, status: string, decidedAt: string): Promise<ArcRequest | null>;

  // ── AD3 ──
  /** Record the due date and the rule it came from. First write wins: a due date never moves. */
  setDeadline(requestId: string, dueOn: string, rule: string): Promise<ArcRequest | null>;
  /** Every request whose clock is running (under review), with or without a due date yet. */
  listRunning(limit: number): Promise<ArcRequest[]>;
  /** Incomplete requests, for the nightly pass that heals a clock start a crash interrupted. */
  listIncomplete(limit: number): Promise<ArcRequest[]>;
  /** Insert a reminder rung; false when that rung was already sent. */
  claimReminder(input: { id: string; orgId: string; requestId: string; offsetDays: number; recipients: string; sentAt: string }): Promise<boolean>;
  /** Flag the missed deadline once; null when it was already flagged or the request is no longer running. */
  markMissed(requestId: string, at: string): Promise<ArcRequest | null>;
  listReminders(requestId: string): Promise<{ offsetDays: number; recipients: string; sentAt: string }[]>;
}
