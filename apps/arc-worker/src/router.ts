import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleGetBoard, handlePutBoard } from "./handlers/board.js";
import {
  handleArchiveChecklistItem,
  handleCreateChecklistItem,
  handleListChecklist,
  handleUpdateChecklistItem,
} from "./handlers/checklist.js";
import { handleGetDocument, handleGetRequest, handleListRequests } from "./handlers/requests.js";
import { handlePublicBoard, handlePublicStatus, handleSubmit, handleUpload } from "./handlers/public.js";
import { handleFormPage, handleStatusPage } from "./handlers/pages.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import {
  generateRequestId,
  parseChecklistItemPublicId,
  parseDocumentPublicId,
  parseOrgPublicId,
  parseRequestPublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set — never as a token.
 * The public lane carries no actor at all; api-edge strips these headers there.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

/** The origin the homeowner reached us on, for the links we email them. */
function publicOrigin(request: Request): string {
  const forwarded = request.headers.get("x-public-origin");
  if (forwarded && /^https?:\/\/[\w.-]+(:\d+)?$/.test(forwarded)) return forwarded;
  return new URL(request.url).origin;
}

// Authenticated — /v1/organizations/{org}/arc/…
const BOARD_RE = /^\/v1\/organizations\/([^/]+)\/arc\/board$/;
const CHECKLIST_RE = /^\/v1\/organizations\/([^/]+)\/arc\/checklist$/;
const CHECKLIST_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/arc\/checklist\/([^/]+)$/;
const REQUESTS_RE = /^\/v1\/organizations\/([^/]+)\/arc\/requests$/;
const REQUEST_RE = /^\/v1\/organizations\/([^/]+)\/arc\/requests\/([^/]+)$/;
const REQUEST_DOCUMENT_RE = /^\/v1\/organizations\/([^/]+)\/arc\/requests\/([^/]+)\/documents\/([^/]+)$/;

// Public — no account
const PUBLIC_BOARD_RE = /^\/v1\/public\/arc\/boards\/([a-z0-9-]{1,48})$/;
const PUBLIC_SUBMIT_RE = /^\/v1\/public\/arc\/boards\/([a-z0-9-]{1,48})\/requests$/;
const PUBLIC_STATUS_RE = /^\/v1\/public\/arc\/requests\/([A-Za-z0-9_-]{1,64})$/;
const PUBLIC_UPLOAD_RE = /^\/v1\/public\/arc\/requests\/([A-Za-z0-9_-]{1,64})\/documents\/([a-z_][a-z0-9_]{0,39})$/;
const FORM_PAGE_RE = /^\/arc\/f\/([a-z0-9-]{1,48})$/;
const STATUS_PAGE_RE = /^\/arc\/s\/([A-Za-z0-9_-]{1,64})$/;

function unauthenticated(requestId: string): Response {
  return errorResponse("unauthenticated", "Authentication required", 401, requestId);
}

async function routePublic(request: Request, env: Env, requestId: string, path: string): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  if ((m = path.match(FORM_PAGE_RE))) {
    return request.method === "GET" ? handleFormPage(env, m[1]!) : methodNotAllowed(requestId);
  }
  if ((m = path.match(STATUS_PAGE_RE))) {
    return request.method === "GET" ? handleStatusPage(env, m[1]!) : methodNotAllowed(requestId);
  }
  if ((m = path.match(PUBLIC_SUBMIT_RE))) {
    return request.method === "POST"
      ? handleSubmit(request, env, requestId, m[1]!, publicOrigin(request))
      : methodNotAllowed(requestId);
  }
  if ((m = path.match(PUBLIC_BOARD_RE))) {
    return request.method === "GET" ? handlePublicBoard(env, requestId, m[1]!) : methodNotAllowed(requestId);
  }
  if ((m = path.match(PUBLIC_UPLOAD_RE))) {
    return request.method === "PUT" ? handleUpload(request, env, requestId, m[1]!, m[2]!) : methodNotAllowed(requestId);
  }
  if ((m = path.match(PUBLIC_STATUS_RE))) {
    return request.method === "GET" ? handlePublicStatus(env, requestId, m[1]!) : methodNotAllowed(requestId);
  }
  return null;
}

async function routeOrg(request: Request, env: Env, requestId: string, path: string): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  const method = request.method;

  if ((m = path.match(REQUEST_DOCUMENT_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const req = parseRequestPublicId(m[2]!);
    const doc = parseDocumentPublicId(m[3]!);
    if (!org || !req || !doc) return notFound(requestId);
    if (method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleGetDocument(env, requestId, actor, org, req, doc);
  }
  if ((m = path.match(REQUEST_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const req = parseRequestPublicId(m[2]!);
    if (!org || !req) return notFound(requestId);
    if (method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleGetRequest(env, requestId, actor, org, req);
  }
  if ((m = path.match(REQUESTS_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleListRequests(request, env, requestId, actor, org);
  }
  if ((m = path.match(CHECKLIST_ITEM_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const item = parseChecklistItemPublicId(m[2]!);
    if (!org || !item) return notFound(requestId);
    if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return method === "PATCH"
      ? handleUpdateChecklistItem(request, env, requestId, actor, org, item)
      : handleArchiveChecklistItem(env, requestId, actor, org, item);
  }
  if ((m = path.match(CHECKLIST_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET" && method !== "POST") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleListChecklist(request, env, requestId, actor, org)
      : handleCreateChecklistItem(request, env, requestId, actor, org);
  }
  if ((m = path.match(BOARD_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET" && method !== "PUT") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleGetBoard(env, requestId, actor, org)
      : handlePutBoard(request, env, requestId, actor, org);
  }
  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const response =
      (await routePublic(request, env, requestId, url.pathname)) ??
      (await routeOrg(request, env, requestId, url.pathname));
    return response ?? notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
