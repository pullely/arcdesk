import { arcRequestReference } from "@saas/contracts/arc";
import type { ArcDecision, ArcRequest } from "@saas/db/arc";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Db } from "../context.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { orgPublicId, requestPublicId } from "../ids.js";
import { renderLetter } from "../letter.js";
import { sendDecided } from "../notify.js";
import { tally, toPublicComment, toPublicDecision, toPublicVote } from "../present.js";
import { generateStatusToken, hashStatusToken, isWellFormedToken, sha256Hex } from "../token.js";
import { validateCommentBody, validateDecisionBody, validateVoteBody } from "../validate.js";
import { loadByToken } from "./public.js";

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

function clockNotStarted(requestId: string): Response {
  return errorResponse("conflict", "The request is not complete yet — the committee acts once the clock has started", 409, requestId, {
    reason: "clock_not_started",
  });
}

function alreadyDecided(requestId: string): Response {
  return errorResponse("conflict", "This request has already been decided", 409, requestId, { reason: "already_decided" });
}

/** Guard for anything the committee does to a request: it must be running. */
function openForReview(request: ArcRequest, requestId: string): Response | null {
  if (request.status === "incomplete") return clockNotStarted(requestId);
  if (request.status !== "under_review") return alreadyDecided(requestId);
  return null;
}

function actorOf(actor: ActorContext): { type: string; id: string } {
  return { type: actor.subjectType, id: actor.subjectId };
}

async function withRequest(
  env: Env,
  requestId: string,
  orgId: string,
  arcRequestId: string,
  fn: (db: Db, request: ArcRequest) => Promise<Response>,
): Promise<Response> {
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const found = await db.arc.getRequest(orgId, arcRequestId);
    if (!found) return notFound(requestId);
    return await fn(db, found);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

// ── Comments ─────────────────────────────────────────────────

export async function handleListComments(env: Env, requestId: string, actor: ActorContext, orgId: string, arcRequestId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const comments = await db.arc.listComments(found.id);
    return successResponse({ comments: comments.map(toPublicComment) }, requestId);
  });
}

export async function handleCreateComment(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  arcRequestId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateCommentBody(parsed.body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.request.comment", requestId))) return notFound(requestId);

  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const now = nowIso();
    const comment = await db.arc.createComment({
      id: crypto.randomUUID(),
      orgId,
      requestId: found.id,
      authorSubjectId: actor.subjectId,
      body: validation.value.body,
      visibility: validation.value.visibility,
      createdAt: now,
    });
    const reference = arcRequestReference(found.number);
    await recordAudit(db.executor, {
      type: "arc.request.commented",
      orgId,
      actor: actorOf(actor),
      requestId,
      subjectKind: "arc_request",
      subjectId: found.id,
      subjectName: reference,
      description: `Commented on ${reference}${comment.visibility === "applicant" ? " (shown to the homeowner)" : ""}`,
      payload: { requestId: requestPublicId(found.id), visibility: comment.visibility },
      occurredAt: now,
    });
    return successResponse({ comment: toPublicComment(comment) }, requestId, 201);
  });
}

// ── Votes ────────────────────────────────────────────────────

export async function handleListVotes(env: Env, requestId: string, actor: ActorContext, orgId: string, arcRequestId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const votes = await db.arc.listVotes(found.id);
    return successResponse({ votes: votes.map(toPublicVote), tally: tally(votes) }, requestId);
  });
}

/** Upsert the caller's own vote. One row per (request, voter): a re-vote replaces. */
export async function handlePutVote(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  arcRequestId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateVoteBody(parsed.body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.request.vote", requestId))) return notFound(requestId);

  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const refusal = openForReview(found, requestId);
    if (refusal) return refusal;
    const now = nowIso();
    const vote = await db.arc.upsertVote({
      id: crypto.randomUUID(),
      orgId,
      requestId: found.id,
      voterSubjectId: actor.subjectId,
      ...validation.value,
      now,
    });
    const votes = await db.arc.listVotes(found.id);
    const reference = arcRequestReference(found.number);
    await recordAudit(db.executor, {
      type: "arc.request.voted",
      orgId,
      actor: actorOf(actor),
      requestId,
      subjectKind: "arc_request",
      subjectId: found.id,
      subjectName: reference,
      description: `Voted "${vote.vote.replace(/_/g, " ")}" on ${reference}`,
      payload: { requestId: requestPublicId(found.id), vote: vote.vote },
      occurredAt: now,
    });
    return successResponse({ vote: toPublicVote(vote), tally: tally(votes) }, requestId);
  });
}

// ── The decision ─────────────────────────────────────────────

/**
 * Record the decision. In order: refuse what may not be decided; freeze the
 * tally; render the letter and put it in R2 under a key that names the
 * decision; write the one decision row (UNIQUE request_id — a racing second
 * decision loses here and its letter object is removed); close the request;
 * audit; email. The email is advisory: the letter in R2, hashed in D1, is the
 * record, and the status page serves it whatever the mail did.
 */
export async function handleCreateDecision(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  arcRequestId: string,
  publicOrigin: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateDecisionBody(parsed.body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.request.decide", requestId))) return notFound(requestId);
  if (!env.ARC_DOCS) return unavailable(requestId);
  const bucket = env.ARC_DOCS;

  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const refusal = openForReview(found, requestId);
    if (refusal) return refusal;
    const board = await db.arc.getBoardById(found.boardId);
    if (!board) return unavailable(requestId);

    const now = nowIso();
    const votes = await db.arc.listVotes(found.id);
    const frozen = tally(votes);
    const { outcome, conditions, rationale } = validation.value;

    const letter = renderLetter({ board, request: found, outcome, conditions, rationale, tally: frozen, decidedAt: now });
    const letterSha256 = await sha256Hex(letter);
    const decisionId = crypto.randomUUID();
    const objectKey = `orgs/${orgId}/requests/${found.id}/decision-${decisionId}.pdf`;
    await bucket.put(objectKey, letter, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { sha256: letterSha256, requestId: requestPublicId(found.id) },
    });

    const letterToken = generateStatusToken();
    const decision = await db.arc.createDecision({
      id: decisionId,
      orgId,
      requestId: found.id,
      outcome,
      conditions,
      rationale,
      voteTally: frozen,
      letterObjectKey: objectKey,
      letterSha256,
      letterTokenHash: await hashStatusToken(letterToken),
      decidedBy: actor.subjectId,
      decidedAt: now,
    });
    if (!decision) {
      await bucket.delete(objectKey).catch(() => undefined);
      return alreadyDecided(requestId);
    }
    const closed = await db.arc.closeRequest(found.id, outcome, now);

    const reference = arcRequestReference(found.number);
    await recordAudit(db.executor, {
      type: "arc.request.decided",
      orgId,
      actor: actorOf(actor),
      requestId,
      subjectKind: "arc_request",
      subjectId: found.id,
      subjectName: reference,
      description: `${reference} decided: ${outcome.replace(/_/g, " ")}`,
      payload: { requestId: requestPublicId(found.id), outcome, letterSha256, voteTally: frozen },
      occurredAt: now,
    });

    const letterUrl = `${publicOrigin}/v1/public/arc/letters/${letterToken}`;
    let emailed: ArcDecision = decision;
    if (await sendDecided(env, requestId, board, closed ?? found, decision, letterUrl)) {
      await db.arc.markLetterEmailed(decision.id, now);
      emailed = { ...decision, letterEmailedAt: now };
      await recordAudit(db.executor, {
        type: "arc.request.letter_emailed",
        orgId,
        actor: actorOf(actor),
        requestId,
        subjectKind: "arc_request",
        subjectId: found.id,
        subjectName: reference,
        description: `Decision letter for ${reference} emailed to the applicant`,
        payload: { requestId: requestPublicId(found.id) },
        occurredAt: now,
      });
    }

    return successResponse(
      { decision: toPublicDecision(emailed, orgPublicId(orgId), requestPublicId(found.id)) },
      requestId,
      201,
    );
  });
}

export async function handleGetDecision(env: Env, requestId: string, actor: ActorContext, orgId: string, arcRequestId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const decision = await db.arc.getDecision(found.id);
    if (!decision) return errorResponse("not_found", "No decision yet", 404, requestId);
    return successResponse({ decision: toPublicDecision(decision, orgPublicId(orgId), requestPublicId(found.id)) }, requestId);
  });
}

async function streamLetter(env: Env, requestId: string, decision: ArcDecision, reference: string): Promise<Response> {
  const object = await env.ARC_DOCS!.get(decision.letterObjectKey);
  if (!object) return notFound(requestId);
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${reference}-decision.pdf"`,
      "x-content-sha256": decision.letterSha256,
      "cache-control": "private, no-store",
    },
  });
}

/** The committee's copy of the letter. */
export async function handleGetLetter(env: Env, requestId: string, actor: ActorContext, orgId: string, arcRequestId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  if (!env.ARC_DOCS) return unavailable(requestId);
  return withRequest(env, requestId, orgId, arcRequestId, async (db, found) => {
    const decision = await db.arc.getDecision(found.id);
    if (!decision) return errorResponse("not_found", "No decision yet", 404, requestId);
    return streamLetter(env, requestId, decision, arcRequestReference(found.number));
  });
}

/** The homeowner's copy, by their status token. */
export async function handlePublicLetterByStatus(env: Env, requestId: string, token: string): Promise<Response> {
  const db = openDb(env);
  if (!db || !env.ARC_DOCS) return unavailable(requestId);
  try {
    const found = await loadByToken(db, token);
    if (!found) return notFound(requestId);
    const decision = await db.arc.getDecision(found.request.id);
    if (!decision) return notFound(requestId);
    return await streamLetter(env, requestId, decision, arcRequestReference(found.request.number));
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** The link in the decision email: a capability for the letter alone. */
export async function handlePublicLetterByToken(env: Env, requestId: string, letterToken: string): Promise<Response> {
  if (!isWellFormedToken(letterToken)) return notFound(requestId);
  const db = openDb(env);
  if (!db || !env.ARC_DOCS) return unavailable(requestId);
  try {
    const decision = await db.arc.getDecisionByLetterTokenHash(await hashStatusToken(letterToken));
    if (!decision) return notFound(requestId);
    const request = await db.arc.getRequest(decision.orgId, decision.requestId);
    return await streamLetter(env, requestId, decision, request ? arcRequestReference(request.number) : "decision");
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
