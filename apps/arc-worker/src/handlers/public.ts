import {
  ARC_UPLOAD_CONTENT_TYPES,
  ARC_UPLOAD_MAX_BYTES,
  arcRequestReference,
  type ArcPublicStatus,
} from "@saas/contracts/arc";
import type { ArcBoard, ArcRequest } from "@saas/db/arc";
import type { Env } from "../env.js";
import type { Db } from "../context.js";
import { HOMEOWNER_ACTOR, recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { documentPublicId, requestPublicId } from "../ids.js";
import { sendRequestReceived } from "../notify.js";
import { applyDeadline } from "../clock.js";
import {
  applies,
  checklistState,
  statusPath,
  toArcPublicBoard,
  toPublicDocument,
  toPublicStatus,
} from "../present.js";
import { generateStatusToken, hashStatusToken, isWellFormedToken, sha256Hex } from "../token.js";
import { sanitizeFilename, validateSubmitBody } from "../validate.js";

/** The checklist key that means "an extra attachment, not a checklist item". */
export const EXTRA_DOCUMENT_KEY = "_extra";

const OPEN_STATUSES = new Set(["incomplete", "under_review"]);

/** A board the public may see: it exists and its form is switched on. */
export async function loadOpenBoard(db: Db, slug: string): Promise<ArcBoard | null> {
  const board = await db.arc.getBoardBySlug(slug.toLowerCase());
  return board && board.formEnabled ? board : null;
}

/** Resolve a status token to its request and board; null for anything unknown or malformed. */
export async function loadByToken(db: Db, token: string): Promise<{ request: ArcRequest; board: ArcBoard } | null> {
  if (!isWellFormedToken(token)) return null;
  const request = await db.arc.getRequestByTokenHash(await hashStatusToken(token));
  if (!request) return null;
  const board = await db.arc.getBoardById(request.boardId);
  return board ? { request, board } : null;
}

export async function buildStatus(db: Db, board: ArcBoard, request: ArcRequest, token: string): Promise<ArcPublicStatus> {
  const [items, docs, messages, decision] = await Promise.all([
    db.arc.listChecklist(board.id, false),
    db.arc.listDocuments(request.id),
    db.arc.listComments(request.id, "applicant"),
    db.arc.getDecision(request.id),
  ]);
  return toPublicStatus(board, request, checklistState(items, request.category, docs), docs, messages, decision, token);
}

export async function handlePublicBoard(env: Env, requestId: string, slug: string): Promise<Response> {
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const board = await loadOpenBoard(db, slug);
    if (!board) return notFound(requestId);
    const items = await db.arc.listChecklist(board.id, false);
    return successResponse({ board: toArcPublicBoard(board, items) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * A homeowner files a request. It is born `incomplete`; the clock starts only
 * when the checklist is — which, for a category with no required documents,
 * is at once.
 */
export async function handleSubmit(
  request: Request,
  env: Env,
  requestId: string,
  slug: string,
  publicOrigin: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const validation = validateSubmitBody(body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  const fields = validation.value;

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const board = await loadOpenBoard(db, slug);
    if (!board) return notFound(requestId);

    const now = nowIso();
    const token = generateStatusToken();
    const number = await db.arc.allocateRequestNumber(board.id);
    let created = await db.arc.createRequest({
      id: crypto.randomUUID(),
      orgId: board.orgId,
      boardId: board.id,
      number,
      ...fields,
      statusTokenHash: await hashStatusToken(token),
      now,
    });
    const started = await db.arc.tryStartClock(created.id, now);
    if (started) created = await applyDeadline(db, board, started);

    const reference = arcRequestReference(created.number);
    await recordAudit(db.executor, {
      type: "arc.request.submitted",
      orgId: board.orgId,
      actor: HOMEOWNER_ACTOR,
      requestId,
      subjectKind: "arc_request",
      subjectId: created.id,
      subjectName: reference,
      description: `${reference} submitted for ${created.propertyAddress} (${created.category})`,
      payload: { requestId: requestPublicId(created.id), reference, category: created.category, clockStarted: !!started },
      occurredAt: now,
    });
    if (started) await auditClockStarted(db, board, created, requestId, now);

    const statusUrl = `${publicOrigin}${statusPath(token)}`;
    await sendRequestReceived(env, requestId, board, created, statusUrl);

    return successResponse(
      { status: await buildStatus(db, board, created, token), statusToken: token, statusUrlPath: statusPath(token) },
      requestId,
      201,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

async function auditClockStarted(db: Db, board: ArcBoard, request: ArcRequest, requestId: string, now: string): Promise<void> {
  const reference = arcRequestReference(request.number);
  await recordAudit(db.executor, {
    type: "arc.request.clock_started",
    orgId: board.orgId,
    actor: HOMEOWNER_ACTOR,
    requestId,
    subjectKind: "arc_request",
    subjectId: request.id,
    subjectName: reference,
    description: `${reference} is complete — the decision clock started`,
    payload: { requestId: requestPublicId(request.id), reference, clockStartedAt: request.clockStartedAt },
    occurredAt: now,
  });
}

export async function handlePublicStatus(env: Env, requestId: string, token: string): Promise<Response> {
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const found = await loadByToken(db, token);
    if (!found) return notFound(requestId);
    return successResponse({ status: await buildStatus(db, found.board, found.request, token) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * Upload one document against a checklist item. The body is the file. It is
 * read whole (the cap is 20 MB, well inside a Worker's memory), hashed, put in
 * R2 under a key no other document can have, recorded, and then the clock is
 * offered the chance to start.
 */
export async function handleUpload(
  request: Request,
  env: Env,
  requestId: string,
  token: string,
  checklistKey: string,
): Promise<Response> {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(ARC_UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return errorResponse("unsupported", `Upload a PDF, PNG or JPEG (got ${contentType || "no content type"})`, 415, requestId);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > ARC_UPLOAD_MAX_BYTES) {
    return errorResponse("validation_failed", "Files are limited to 20 MB", 413, requestId);
  }

  const db = openDb(env);
  if (!db || !env.ARC_DOCS) return unavailable(requestId);
  try {
    const found = await loadByToken(db, token);
    if (!found) return notFound(requestId);
    const { board } = found;
    let arcRequest = found.request;
    if (!OPEN_STATUSES.has(arcRequest.status)) {
      return errorResponse("conflict", "This request has been decided and is closed to uploads", 409, requestId, {
        reason: "request_closed",
      });
    }

    let key: string | null = null;
    if (checklistKey !== EXTRA_DOCUMENT_KEY) {
      const items = await db.arc.listChecklist(board.id, false);
      const item = items.find((i) => i.key === checklistKey);
      if (!item || !applies(item, arcRequest.category)) {
        return errorResponse("not_found", "That checklist item does not apply to this request", 404, requestId);
      }
      key = item.key;
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return validationError(requestId, { body: ["The file is empty"] });
    if (bytes.byteLength > ARC_UPLOAD_MAX_BYTES) {
      return errorResponse("validation_failed", "Files are limited to 20 MB", 413, requestId);
    }
    const sha256 = await sha256Hex(bytes);
    const documentId = crypto.randomUUID();
    const objectKey = `orgs/${board.orgId}/requests/${arcRequest.id}/${documentId}`;
    const filename = sanitizeFilename(
      request.headers.get("x-filename") ?? new URL(request.url).searchParams.get("filename"),
    );

    await env.ARC_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { sha256, requestId: requestPublicId(arcRequest.id), filename },
    });

    const now = nowIso();
    const doc = await db.arc.createDocument({
      id: documentId,
      orgId: board.orgId,
      requestId: arcRequest.id,
      checklistKey: key,
      objectKey,
      filename,
      contentType,
      byteSize: bytes.byteLength,
      sha256,
      uploadedAt: now,
    });

    const reference = arcRequestReference(arcRequest.number);
    await recordAudit(db.executor, {
      type: "arc.request.document_uploaded",
      orgId: board.orgId,
      actor: HOMEOWNER_ACTOR,
      requestId,
      subjectKind: "arc_request",
      subjectId: arcRequest.id,
      subjectName: reference,
      description: `${reference}: ${filename} uploaded${key ? ` for "${key}"` : ""}`,
      payload: { requestId: requestPublicId(arcRequest.id), documentId: documentPublicId(doc.id), checklistKey: key, byteSize: doc.byteSize, sha256 },
      occurredAt: now,
    });

    const started = await db.arc.tryStartClock(arcRequest.id, now);
    if (started) {
      arcRequest = await applyDeadline(db, board, started);
      await auditClockStarted(db, board, started, requestId, now);
    }

    return successResponse(
      { document: toPublicDocument(doc), status: await buildStatus(db, board, arcRequest, token), clockStarted: !!started },
      requestId,
      201,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
