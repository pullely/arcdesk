import { ARC_REQUEST_STATUSES } from "@saas/contracts/arc";
import type { ArcRequest } from "@saas/db/arc";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Db } from "../context.js";
import { allowed } from "../authz.js";
import { openDb } from "../context.js";
import { notFound, pagedResponse, successResponse, unavailable, validationError } from "../http.js";
import { checklistState, isChecklistComplete, toPublicDocument, toPublicRequest } from "../present.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function encodeCursor(r: ArcRequest): string {
  return btoa(JSON.stringify({ c: r.createdAt, i: r.id })).replace(/=+$/, "");
}

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(atob(raw)) as { c?: unknown; i?: unknown };
    if (typeof parsed.c === "string" && typeof parsed.i === "string") return { createdAt: parsed.c, id: parsed.i };
  } catch {
    // fall through
  }
  return null;
}

/** Checklist state for a batch of requests, reading each board's checklist once. */
async function completeness(db: Db, requests: readonly ArcRequest[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const boards = new Map<string, Awaited<ReturnType<Db["arc"]["listChecklist"]>>>();
  for (const r of requests) {
    if (r.clockStartedAt !== null) {
      out.set(r.id, true);
      continue;
    }
    let items = boards.get(r.boardId);
    if (!items) {
      items = await db.arc.listChecklist(r.boardId, false);
      boards.set(r.boardId, items);
    }
    const docs = await db.arc.listDocuments(r.id);
    out.set(r.id, isChecklistComplete(checklistState(items, r.category, docs)));
  }
  return out;
}

export async function handleListRequests(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const status = params.get("status") ?? undefined;
  if (status !== undefined && !(ARC_REQUEST_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`One of ${ARC_REQUEST_STATUSES.join(", ")}`] });
  }
  const limitRaw = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
  const dueWithinRaw = params.get("due_within");
  let dueOnOrBefore: string | undefined;
  if (dueWithinRaw !== null) {
    const n = Number(dueWithinRaw);
    if (!Number.isInteger(n) || n < 0 || n > 365) return validationError(requestId, { due_within: ["Whole days, 0–365"] });
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    dueOnOrBefore = d.toISOString().slice(0, 10);
  }
  const cursorRaw = params.get("cursor");
  const before = cursorRaw ? decodeCursor(cursorRaw) : undefined;
  if (cursorRaw && !before) return validationError(requestId, { cursor: ["Malformed cursor"] });

  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const rows = await db.arc.listRequests(orgId, { status, dueOnOrBefore, limit: limit + 1, before: before ?? undefined });
    const page = rows.slice(0, limit);
    const complete = await completeness(db, page);
    const next = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;
    return pagedResponse(
      { requests: page.map((r) => toPublicRequest(r, complete.get(r.id) ?? false)) },
      requestId,
      next,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleGetRequest(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  arcRequestId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const found = await db.arc.getRequest(orgId, arcRequestId);
    if (!found) return notFound(requestId);
    const [items, docs] = await Promise.all([
      db.arc.listChecklist(found.boardId, false),
      db.arc.listDocuments(found.id),
    ]);
    const state = checklistState(items, found.category, docs);
    return successResponse(
      {
        request: toPublicRequest(found, found.clockStartedAt !== null || isChecklistComplete(state)),
        checklist: state,
        documents: docs.map(toPublicDocument),
      },
      requestId,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** Stream a stored document out of R2 to a committee member. */
export async function handleGetDocument(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  arcRequestId: string,
  documentId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "arc.request.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db || !env.ARC_DOCS) return unavailable(requestId);
  try {
    const doc = await db.arc.getDocument(orgId, arcRequestId, documentId);
    if (!doc) return notFound(requestId);
    const object = await env.ARC_DOCS.get(doc.objectKey);
    if (!object) return notFound(requestId);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": doc.contentType,
        "content-length": String(doc.byteSize),
        "content-disposition": `inline; filename="${doc.filename}"`,
        "x-content-sha256": doc.sha256,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
