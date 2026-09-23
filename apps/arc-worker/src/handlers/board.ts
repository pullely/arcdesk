import { ARC_DEFAULT_CHECKLIST } from "@saas/contracts/arc";
import { isUniqueViolation } from "@saas/db/d1";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, boardPublicId } from "../ids.js";
import { toPublicBoard } from "../present.js";
import { validateBoardBody } from "../validate.js";

export async function handleGetBoard(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.board.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const board = await db.arc.getBoardByOrg(orgId);
    if (!board) return errorResponse("not_found", "This organization has no review board yet", 404, requestId);
    return successResponse({ board: toPublicBoard(board) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * Create-or-update the organization's board. Creating one seeds the default
 * checklist, so a new association has a working form in one call.
 */
export async function handlePutBoard(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const validation = validateBoardBody(body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.board.manage", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    let result;
    try {
      result = await db.arc.upsertBoard({
        id: crypto.randomUUID(),
        orgId,
        ...validation.value,
        createdBy: actorSubjectUuid(actor.subjectId),
        now,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return errorResponse("conflict", "That form address is already taken", 409, requestId, {
          field: "publicSlug",
        });
      }
      throw err;
    }
    const { board, created } = result;

    if (created) {
      let position = 0;
      for (const item of ARC_DEFAULT_CHECKLIST) {
        await db.arc.createChecklistItem({
          id: crypto.randomUUID(),
          orgId,
          boardId: board.id,
          key: item.key,
          label: item.label,
          required: item.required,
          categories: [...item.categories],
          position: position++ * 10,
          now,
        });
      }
    }

    await recordAudit(db.executor, {
      type: "arc.board.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "arc_board",
      subjectId: board.id,
      subjectName: board.associationName,
      description: created
        ? `Opened the review board for ${board.associationName}`
        : `Updated the review board for ${board.associationName}`,
      payload: { boardId: boardPublicId(board.id), created, publicSlug: board.publicSlug, state: board.state },
      occurredAt: now,
    });

    return successResponse({ board: toPublicBoard(board) }, requestId, created ? 201 : 200);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
