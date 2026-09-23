import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Architectural review (arc-worker). Two lanes behind one binding:
//
//   - the ORG lane, /v1/organizations/{org}/arc/…, authenticated like every
//     other org route (resolveActor → actor headers);
//   - the PUBLIC lane — the homeowner's form, status page, submit and upload —
//     which has no account at all. It never resolves an actor, strips any
//     actor header a caller tries to smuggle in, and is rate-limited under its
//     own family, keyed by client IP (no bearer ⇒ anon:<family>:<ip>).

const ORG_ARC_RE =
  /^\/v1\/organizations\/[^/]+\/arc\/(?:board|checklist(?:\/[^/]+)?|requests(?:\/[^/]+(?:\/documents\/[^/]+|\/comments|\/votes|\/votes\/me|\/decision|\/letter)?)?)$/;

const PUBLIC_API_RE =
  /^\/v1\/public\/arc\/(?:boards\/[^/]+(?:\/requests)?|requests\/[^/]+(?:\/documents\/[^/]+|\/letter)?|letters\/[^/]+)$/;
const PUBLIC_PAGE_RE = /^\/arc\/(?:f|s)\/[^/]+$/;

const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key", "x-filename"];
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isArcRoute(pathname: string): boolean {
  return ORG_ARC_RE.test(pathname) || isArcPublicRoute(pathname);
}

export function isArcPublicRoute(pathname: string): boolean {
  return PUBLIC_API_RE.test(pathname) || PUBLIC_PAGE_RE.test(pathname);
}

async function forward(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
  actor: { subjectId: string; subjectType: string; email: string } | null,
  timings: ReturnType<typeof createTimings>,
): Promise<Response> {
  const headers = new Headers();
  headers.set("x-request-id", requestId);
  if (actor) {
    headers.set("x-actor-subject-id", actor.subjectId);
    headers.set("x-actor-subject-type", actor.subjectType);
    headers.set("x-actor-email", actor.email);
  }
  const url = new URL(request.url);
  // The origin the caller reached us on, so the status link the homeowner is
  // emailed points back at this edge.
  headers.set("x-public-origin", url.origin);
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const target = new URL(pathname + url.search, "https://arc.internal");
  const init: RequestInit = { method: request.method, headers };
  if (BODY_METHODS.has(request.method)) init.body = request.body;

  const downstream = await timings.measure("edge_downstream", () => env.ARC_WORKER!.fetch(target.toString(), init));
  return new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
}

export async function handleArcRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const isPublic = isArcPublicRoute(pathname);

  return replayOrExecute(request, requestId, env, isPublic ? "arc_public" : "arc", async () => {
    if (!env.ARC_WORKER) {
      return errorResponse("internal_error", "Architectural review service unavailable", 503, requestId);
    }
    const timings = createTimings();
    const endTotal = timings.start("edge_total");

    let actor: { subjectId: string; subjectType: string; email: string } | null = null;
    if (!isPublic) {
      if (!env.IDENTITY_WORKER) {
        return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
      }
      const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
      if ("error" in session) return session.error;
      actor = { subjectId: session.subjectId, subjectType: session.subjectType, email: session.email };
    }

    try {
      const res = await forward(request, env, requestId, pathname, actor, timings);
      endTotal();
      return withEdgeTimings(res, requestId, isPublic ? "edge.arc_public" : "edge.arc", timings);
    } catch {
      return errorResponse("internal_error", "Architectural review service unavailable", 503, requestId);
    }
  });
}
