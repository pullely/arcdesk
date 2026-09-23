import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import { arcRequestReference } from "@saas/contracts/arc";
import type { ArcBoard, ArcRequest } from "@saas/db/arc";
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
