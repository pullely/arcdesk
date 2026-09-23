import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      status: "ok",
      service: "arc-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: {
        database: { configured: !!env.PLATFORM_DB },
        documents: { configured: !!env.ARC_DOCS },
        membership: { configured: !!env.MEMBERSHIP_WORKER },
        policy: { configured: !!env.POLICY_WORKER },
        notifications: { configured: !!env.NOTIFICATIONS_WORKER },
      },
    },
    requestId,
  );
}
