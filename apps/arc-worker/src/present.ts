import type {
  ArcChecklistState,
  ArcDecisionOutcome,
  ArcVote,
  ArcVoteTally,
  ArcCommentVisibility,
  PublicArcComment,
  PublicArcDecision,
  PublicArcVote,
  ArcPublicBoard,
  ArcPublicStatus,
  ArcRequestCategory,
  ArcRequestStatus,
  ArcState,
  PublicArcBoard,
  PublicArcChecklistItem,
  PublicArcDocument,
  PublicArcRequest,
} from "@saas/contracts/arc";
import {
  ARC_REQUEST_CATEGORIES,
  ARC_REQUEST_CATEGORY_LABELS,
  arcRequestReference,
} from "@saas/contracts/arc";
import type {
  ArcBoard,
  ArcChecklistItem,
  ArcComment,
  ArcDecision,
  ArcDocument,
  ArcRequest,
  ArcVoteRow,
} from "@saas/db/arc";
import {
  boardPublicId,
  checklistItemPublicId,
  commentPublicId,
  decisionPublicId,
  documentPublicId,
  orgPublicId,
  requestPublicId,
} from "./ids.js";

export function formPath(slug: string): string {
  return `/arc/f/${slug}`;
}

export function statusPath(token: string): string {
  return `/arc/s/${token}`;
}

export function toPublicBoard(board: ArcBoard): PublicArcBoard {
  return {
    id: boardPublicId(board.id),
    orgId: orgPublicId(board.orgId),
    publicSlug: board.publicSlug,
    associationName: board.associationName,
    state: board.state as ArcState,
    reviewDays: board.reviewDays,
    contactEmail: board.contactEmail,
    escalationEmail: board.escalationEmail,
    formEnabled: board.formEnabled,
    appealText: board.appealText,
    formUrlPath: formPath(board.publicSlug),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

export function toPublicChecklistItem(item: ArcChecklistItem): PublicArcChecklistItem {
  return {
    id: checklistItemPublicId(item.id),
    key: item.key,
    label: item.label,
    required: item.required,
    categories: item.categories as ArcRequestCategory[],
    position: item.position,
    archived: item.archivedAt !== null,
  };
}

/** Does this checklist item apply to a request in `category`? */
export function applies(item: ArcChecklistItem, category: string): boolean {
  if (item.archivedAt !== null) return false;
  return item.categories.length === 0 || item.categories.includes(category);
}

/**
 * The checklist as the request sees it: only items that apply to its
 * category, each marked satisfied when a document carries its key. This is the
 * same rule `tryStartClock` evaluates in SQL; the two are tested together.
 */
export function checklistState(
  items: readonly ArcChecklistItem[],
  category: string,
  documents: readonly ArcDocument[],
): ArcChecklistState[] {
  const uploaded = new Set(documents.map((d) => d.checklistKey).filter((k): k is string => k !== null));
  return items
    .filter((item) => applies(item, category))
    .map((item) => ({
      key: item.key,
      label: item.label,
      required: item.required,
      satisfied: uploaded.has(item.key),
    }));
}

export function isChecklistComplete(state: readonly ArcChecklistState[]): boolean {
  return state.every((s) => !s.required || s.satisfied);
}

export function toPublicRequest(request: ArcRequest, checklistComplete: boolean): PublicArcRequest {
  return {
    id: requestPublicId(request.id),
    orgId: orgPublicId(request.orgId),
    number: request.number,
    reference: arcRequestReference(request.number),
    category: request.category as ArcRequestCategory,
    title: request.title,
    description: request.description,
    propertyAddress: request.propertyAddress,
    applicantName: request.applicantName,
    applicantEmail: request.applicantEmail,
    status: request.status as ArcRequestStatus,
    submittedAt: request.submittedAt,
    clockStartedAt: request.clockStartedAt,
    decisionDueOn: request.decisionDueOn,
    decidedAt: request.decidedAt,
    checklistComplete,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export function toPublicDocument(doc: ArcDocument): PublicArcDocument {
  return {
    id: documentPublicId(doc.id),
    checklistKey: doc.checklistKey,
    filename: doc.filename,
    contentType: doc.contentType,
    byteSize: doc.byteSize,
    sha256: doc.sha256,
    uploadedAt: doc.uploadedAt,
  };
}

/** The homeowner's view. No emails, no internal ids, no committee notes. */
export function toPublicStatus(
  board: ArcBoard,
  request: ArcRequest,
  checklist: ArcChecklistState[],
  documents: readonly ArcDocument[],
  messages: readonly ArcComment[] = [],
  decision: ArcDecision | null = null,
  token = "",
): ArcPublicStatus {
  return {
    reference: arcRequestReference(request.number),
    associationName: board.associationName,
    category: request.category as ArcRequestCategory,
    title: request.title,
    propertyAddress: request.propertyAddress,
    status: request.status as ArcRequestStatus,
    submittedAt: request.submittedAt,
    clockStartedAt: request.clockStartedAt,
    decisionDueOn: request.decisionDueOn,
    decidedAt: request.decidedAt,
    checklist,
    documents: documents.map((d) => ({
      checklistKey: d.checklistKey,
      filename: d.filename,
      byteSize: d.byteSize,
      uploadedAt: d.uploadedAt,
    })),
    messages: messages.map((m) => ({ body: m.body, createdAt: m.createdAt })),
    decision: decision
      ? {
          outcome: decision.outcome as ArcDecisionOutcome,
          conditions: decision.conditions,
          rationale: decision.rationale,
          decidedAt: decision.decidedAt,
          letterPath: `/v1/public/arc/requests/${token}/letter`,
        }
      : null,
  };
}

export function toArcPublicBoard(board: ArcBoard, items: readonly ArcChecklistItem[]): ArcPublicBoard {
  return {
    associationName: board.associationName,
    publicSlug: board.publicSlug,
    state: board.state as ArcState,
    categories: ARC_REQUEST_CATEGORIES.map((key) => ({ key, label: ARC_REQUEST_CATEGORY_LABELS[key] })),
    checklist: items
      .filter((i) => i.archivedAt === null)
      .map((i) => ({
        key: i.key,
        label: i.label,
        required: i.required,
        categories: i.categories as ArcRequestCategory[],
      })),
  };
}

export function emptyTally(): ArcVoteTally {
  return { approve: 0, approve_with_conditions: 0, deny: 0, abstain: 0 };
}

export function tally(votes: readonly ArcVoteRow[]): ArcVoteTally {
  const t = emptyTally();
  for (const v of votes) if (v.vote in t) t[v.vote as ArcVote] += 1;
  return t;
}

export function toPublicComment(c: ArcComment): PublicArcComment {
  return {
    id: commentPublicId(c.id),
    authorSubjectId: c.authorSubjectId,
    body: c.body,
    visibility: c.visibility as ArcCommentVisibility,
    createdAt: c.createdAt,
  };
}

export function toPublicVote(v: ArcVoteRow): PublicArcVote {
  return { voterSubjectId: v.voterSubjectId, vote: v.vote as ArcVote, conditions: v.conditions, note: v.note, updatedAt: v.updatedAt };
}

export function toPublicDecision(d: ArcDecision, orgPublic: string, requestPublic: string): PublicArcDecision {
  return {
    id: decisionPublicId(d.id),
    outcome: d.outcome as ArcDecisionOutcome,
    conditions: d.conditions,
    rationale: d.rationale,
    voteTally: { ...emptyTally(), ...d.voteTally },
    letterSha256: d.letterSha256,
    letterPath: `/v1/organizations/${orgPublic}/arc/requests/${requestPublic}/letter`,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    letterEmailedAt: d.letterEmailedAt,
  };
}
