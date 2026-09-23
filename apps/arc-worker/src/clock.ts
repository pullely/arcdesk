import {
  ARC_ESCALATION_FROM_RUNG,
  ARC_MISSED_RUNG,
  arcCurrentRung,
  arcDaysRemaining,
  arcDeadline,
  arcDeadlineBasis,
  arcRequestReference,
  arcRuleFor,
} from "@saas/contracts/arc";
import type { ArcBoard, ArcRequest } from "@saas/db/arc";
import type { Env } from "./env.js";
import type { Db } from "./context.js";
import { HOMEOWNER_ACTOR, recordAudit, type AuditActor } from "./audit.js";
import { openDb } from "./context.js";
import { requestPublicId } from "./ids.js";
import { sendDeadlineReminder } from "./notify.js";

/** The clock's own actor in the audit trail. */
export const CLOCK_ACTOR: AuditActor = { type: "system", id: "arc-clock" };

const BATCH = 500;

/**
 * Write the due date the moment the clock starts (or, for a request started
 * before AD3, the first time the clock sees it). First write wins: a due date
 * never moves once set, whatever later happens to the board's settings.
 */
export async function applyDeadline(db: Db, board: ArcBoard, request: ArcRequest): Promise<ArcRequest> {
  if (!request.clockStartedAt || request.decisionDueOn) return request;
  const { dueOn, rule } = arcDeadline(board.state, request.category, board.reviewDays, request.clockStartedAt);
  return (await db.arc.setDeadline(request.id, dueOn, rule.key)) ?? request;
}

export interface ClockRun {
  healed: number;
  deadlined: number;
  reminded: number;
  missed: number;
}

/**
 * The nightly pass. Three jobs, each idempotent on its own:
 *
 *   1. heal — an incomplete request whose checklist is in fact complete (an
 *      upload that crashed between its insert and the clock start) is started;
 *   2. date — a running request with no due date gets one;
 *   3. chase — each running request is placed on its rung of the 14/7/3/1/0
 *      ladder (or the missed rung), and that rung is sent only if its
 *      (request, offset) row is newly inserted. Run it twice, run two at once:
 *      the unique index lets exactly one of them send.
 */
export async function runClock(env: Env, now: Date, requestId = `cron_${now.getTime()}`): Promise<ClockRun> {
  const result: ClockRun = { healed: 0, deadlined: 0, reminded: 0, missed: 0 };
  const db = openDb(env);
  if (!db) return result;
  const nowIso = now.toISOString();
  const boards = new Map<string, ArcBoard | null>();
  const boardOf = async (id: string): Promise<ArcBoard | null> => {
    if (!boards.has(id)) boards.set(id, await db.arc.getBoardById(id));
    return boards.get(id) ?? null;
  };

  try {
    for (const incomplete of await db.arc.listIncomplete(BATCH)) {
      const started = await db.arc.tryStartClock(incomplete.id, nowIso);
      if (!started) continue;
      result.healed += 1;
      const reference = arcRequestReference(started.number);
      await recordAudit(db.executor, {
        type: "arc.request.clock_started",
        orgId: started.orgId,
        actor: HOMEOWNER_ACTOR,
        requestId,
        subjectKind: "arc_request",
        subjectId: started.id,
        subjectName: reference,
        description: `${reference} is complete — the decision clock started`,
        payload: { requestId: requestPublicId(started.id), reference, clockStartedAt: started.clockStartedAt, healed: true },
        occurredAt: nowIso,
      });
    }

    for (let request of await db.arc.listRunning(BATCH)) {
      const board = await boardOf(request.boardId);
      if (!board) continue;
      if (!request.decisionDueOn) {
        request = await applyDeadline(db, board, request);
        if (request.decisionDueOn) result.deadlined += 1;
      }
      if (!request.decisionDueOn) continue;

      const daysRemaining = arcDaysRemaining(request.decisionDueOn, nowIso);
      const rung = arcCurrentRung(daysRemaining);
      if (rung === null) continue;
      const reference = arcRequestReference(request.number);
      const rule = arcRuleFor(board.state, request.category);

      if (rung === ARC_MISSED_RUNG) {
        const flagged = await db.arc.markMissed(request.id, nowIso);
        if (flagged) {
          result.missed += 1;
          await recordAudit(db.executor, {
            type: "arc.request.deadline_missed",
            orgId: request.orgId,
            actor: CLOCK_ACTOR,
            requestId,
            subjectKind: "arc_request",
            subjectId: request.id,
            subjectName: reference,
            description: `${reference} passed its decision deadline (${request.decisionDueOn}) undecided — ${rule.citation}`,
            payload: { requestId: requestPublicId(request.id), dueOn: request.decisionDueOn, rule: rule.key, deemedApproved: rule.deemedApproved },
            occurredAt: nowIso,
          });
        }
      }

      const recipients = [board.contactEmail];
      if (rung <= ARC_ESCALATION_FROM_RUNG && board.escalationEmail && board.escalationEmail !== board.contactEmail) {
        recipients.push(board.escalationEmail);
      }
      const claimed = await db.arc.claimReminder({
        id: crypto.randomUUID(),
        orgId: request.orgId,
        requestId: request.id,
        offsetDays: rung,
        recipients: recipients.join(","),
        sentAt: nowIso,
      });
      if (!claimed) continue;

      const clockDays = arcDaysRemaining(request.decisionDueOn, request.clockStartedAt ?? nowIso);
      const basis = arcDeadlineBasis(rule, rule.days === clockDays ? "statute" : "association", clockDays);
      for (const [i, address] of recipients.entries()) {
        await sendDeadlineReminder(env, requestId, board, request, {
          rung,
          daysRemaining,
          basis,
          deemedApproved: rule.deemedApproved && rule.days === clockDays,
          address,
          role: i === 0 ? "contact" : "escalation",
        });
      }
      result.reminded += 1;
      await recordAudit(db.executor, {
        type: "arc.request.reminder_sent",
        orgId: request.orgId,
        actor: CLOCK_ACTOR,
        requestId,
        subjectKind: "arc_request",
        subjectId: request.id,
        subjectName: reference,
        description:
          rung === ARC_MISSED_RUNG
            ? `Missed-deadline escalation for ${reference} sent to ${recipients.join(", ")}`
            : `${rung}-day reminder for ${reference} (due ${request.decisionDueOn}) sent to ${recipients.join(", ")}`,
        payload: { requestId: requestPublicId(request.id), rung, dueOn: request.decisionDueOn, recipients: recipients.length },
        occurredAt: nowIso,
      });
    }
  } finally {
    await db.dispose();
  }
  return result;
}
