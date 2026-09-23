import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { toPublicChecklistItem } from "../present.js";
import { validateChecklistBody } from "../validate.js";

const NO_BOARD = "This organization has no review board yet";

export async function handleListChecklist(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.board.read", requestId))) return notFound(requestId);
  const includeArchived = new URL(request.url).searchParams.get("include_archived") === "true";
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const board = await db.arc.getBoardByOrg(orgId);
    if (!board) return errorResponse("not_found", NO_BOARD, 404, requestId);
    const items = await db.arc.listChecklist(board.id, includeArchived);
    return successResponse({ items: items.map(toPublicChecklistItem) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleCreateChecklistItem(
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
  const validation = validateChecklistBody(body, false);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.board.manage", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const board = await db.arc.getBoardByOrg(orgId);
    if (!board) return errorResponse("not_found", NO_BOARD, 404, requestId);
    const fields = validation.value;
    const item = await db.arc.createChecklistItem({
      id: crypto.randomUUID(),
      orgId,
      boardId: board.id,
      key: fields.key!,
      label: fields.label!,
      required: fields.required ?? true,
      categories: fields.categories ?? [],
      position: fields.position ?? 100,
      now: nowIso(),
    });
    if (!item) {
      return errorResponse("conflict", "A checklist item with that key already exists", 409, requestId, { field: "key" });
    }
    return successResponse({ item: toPublicChecklistItem(item) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleUpdateChecklistItem(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  itemId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const validation = validateChecklistBody(body, true);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "arc.board.manage", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const item = await db.arc.updateChecklistItem(orgId, itemId, { ...validation.value, now: nowIso() });
    if (!item) return notFound(requestId);
    return successResponse({ item: toPublicChecklistItem(item) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** Archive, never delete: a request decided against an item keeps its meaning. */
export async function handleArchiveChecklistItem(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  itemId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.board.manage", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const item = await db.arc.archiveChecklistItem(orgId, itemId, nowIso());
    if (!item) return notFound(requestId);
    return successResponse({ item: toPublicChecklistItem(item) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
