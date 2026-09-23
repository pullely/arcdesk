import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import { ARC_DECISION_OUTCOME_LABELS, arcRequestReference, type ArcDecisionOutcome } from "@saas/contracts/arc";
import type { ArcBoard, ArcDecision, ArcRequest } from "@saas/db/arc";
import type { Env } from "./env.js";
import { requestPublicId } from "./ids.js";

/**
 * Email the homeowner their status link. The link IS the message here — the
 * same exception the baseline makes for a magic-link code — and it is the only
 * copy the homeowner gets: the database keeps nothing but its hash. Advisory:
 * a failed send never fails the submission (the response carries the link too).
 */
export async function sendRequestReceived(
  env: Env,
  requestId: string,
  board: ArcBoard,
  request: ArcRequest,
  statusUrl: string,
): Promise<boolean> {
  const result = await enqueueNotification(
    env,
    {
      internalActor: "arc-worker",
      actorSubjectType: "system",
      actorSubjectId: "arc-public-form",
      requestId,
    },
    {
      orgId: request.orgId,
      category: "product",
      templateKey: "arc.request.received",
      templateData: {
        associationName: board.associationName,
        reference: arcRequestReference(request.number),
        title: request.title,
        propertyAddress: request.propertyAddress,
        statusUrl,
        clockStarted: request.clockStartedAt !== null,
      },
      recipient: { channel: "email", address: request.applicantEmail.toLowerCase() },
      idempotencyKey: buildIdempotencyKey("arc.request.received", requestPublicId(request.id)),
    },
  );
  return result.ok;
}

/**
 * Email the homeowner the decision, with a link to the letter. The link is a
 * capability for the letter alone (its own token, hashed on the decision
 * row), because the status token was never stored and cannot be re-sent.
 */
export async function sendDecided(
  env: Env,
  requestId: string,
  board: ArcBoard,
  request: ArcRequest,
  decision: ArcDecision,
  letterUrl: string,
): Promise<boolean> {
  const result = await enqueueNotification(
    env,
    { internalActor: "arc-worker", actorSubjectType: "system", actorSubjectId: "arc-worker", requestId },
    {
      orgId: request.orgId,
      category: "product",
      templateKey: "arc.request.decided",
      templateData: {
        associationName: board.associationName,
        reference: arcRequestReference(request.number),
        title: request.title,
        propertyAddress: request.propertyAddress,
        outcome: ARC_DECISION_OUTCOME_LABELS[decision.outcome as ArcDecisionOutcome] ?? decision.outcome,
        conditions: decision.conditions,
        letterUrl,
      },
      recipient: { channel: "email", address: request.applicantEmail.toLowerCase() },
      idempotencyKey: buildIdempotencyKey("arc.request.decided", requestPublicId(request.id)),
    },
  );
  return result.ok;
}

export interface ReminderFacts {
  rung: number;
  daysRemaining: number;
  basis: string;
  deemedApproved: boolean;
  address: string;
  role: "contact" | "escalation";
}

/** One rung of the deadline ladder, to one board address. */
export async function sendDeadlineReminder(
  env: Env,
  requestId: string,
  board: ArcBoard,
  request: ArcRequest,
  facts: ReminderFacts,
): Promise<boolean> {
  const result = await enqueueNotification(
    env,
    { internalActor: "arc-worker", actorSubjectType: "system", actorSubjectId: "arc-clock", requestId },
    {
      orgId: request.orgId,
      category: "product",
      templateKey: "arc.deadline.reminder",
      templateData: {
        associationName: board.associationName,
        reference: arcRequestReference(request.number),
        title: request.title,
        propertyAddress: request.propertyAddress,
        dueOn: request.decisionDueOn,
        daysRemaining: facts.daysRemaining,
        missed: facts.rung < 0,
        deemedApproved: facts.deemedApproved,
        basis: facts.basis,
      },
      recipient: { channel: "email", address: facts.address.toLowerCase() },
      idempotencyKey: buildIdempotencyKey("arc.deadline.reminder", requestPublicId(request.id), String(facts.rung), facts.role),
    },
  );
  return result.ok;
}
