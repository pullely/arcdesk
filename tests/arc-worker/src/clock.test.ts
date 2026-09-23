import { arcCurrentRung, arcDaysRemaining, arcDeadline } from "@saas/contracts/arc";
import { route } from "@arc-worker/router";
import { runClock } from "@arc-worker/clock";
import { orgPublicId } from "@arc-worker/ids";
import { OWNER, as, json, world, type TestWorld } from "./harness";

const ORG = orgPublicId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const BASE = "https://arc.internal";
const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label}\n%%EOF\n`);

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

async function board(w: TestWorld, state = "CA", reviewDays = 60): Promise<void> {
  const res = await call(w, `/v1/organizations/${ORG}/arc/board`, {
    method: "PUT",
    headers: { ...as(OWNER), "content-type": "application/json" },
    body: JSON.stringify({
      associationName: "Oak Hollow HOA", publicSlug: "oak-hollow", state, reviewDays,
      contactEmail: "arc@oakhollow.example", escalationEmail: "president@oakhollow.example",
    }),
  });
  expect(res.status).toBeLessThan(300);
}

async function complete(w: TestWorld, category: string): Promise<{ token: string; status: Record<string, any> }> {
  const sub = await json(
    await call(w, "/v1/public/arc/boards/oak-hollow/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, title: "Change", propertyAddress: "1 Oak", applicantName: "Dana", applicantEmail: "d@example.com" }),
    }),
  );
  const token: string = sub.data.statusToken;
  let status = sub.data.status;
  for (const item of status.checklist.filter((c: { required: boolean }) => c.required)) {
    const up = await json(
      await call(w, `/v1/public/arc/requests/${token}/documents/${item.key}`, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: pdf(item.key),
      }),
    );
    status = up.data.status;
  }
  return { token, status };
}

/** Pin a running request's clock to a known start and due date. */
function pin(w: TestWorld, started: string, dueOn: string): void {
  w.db.prepare("UPDATE arc_requests SET clock_started_at = ?, decision_due_on = ?").run(started, dueOn);
}

const reminders = (w: TestWorld) =>
  w.sent.filter((m) => (m as { templateKey: string }).templateKey === "arc.deadline.reminder") as {
    recipient: { address: string };
    templateData: Record<string, unknown>;
  }[];

describe("the deadline", () => {
  it("is the earlier of the statute and the association's period", () => {
    const start = "2026-09-01T15:30:00.000Z";
    expect(arcDeadline("CA", "solar", 60, start)).toMatchObject({ dueOn: "2026-10-16", governedBy: "statute", days: 45 });
    expect(arcDeadline("CA", "ev_charger", 30, start)).toMatchObject({ dueOn: "2026-10-01", governedBy: "association", days: 30 });
    expect(arcDeadline("CA", "fence", 30, start)).toMatchObject({ dueOn: "2026-10-01", governedBy: "association" });
    expect(arcDeadline("TX", "solar", 30, start).rule.key).toBe("TX.documents");
  });

  it("places a request on exactly one rung", () => {
    expect(arcCurrentRung(20)).toBeNull();
    expect(arcCurrentRung(14)).toBe(14);
    expect(arcCurrentRung(9)).toBe(14);
    expect(arcCurrentRung(5)).toBe(7);
    expect(arcCurrentRung(0)).toBe(0);
    expect(arcCurrentRung(-2)).toBe(-1);
    expect(arcDaysRemaining("2026-10-16", "2026-10-02T23:59:00.000Z")).toBe(14);
  });

  it("is written when the last required document arrives, with its basis", async () => {
    const w = world();
    await board(w, "CA", 60);
    const { status } = await complete(w, "solar");
    expect(status.status).toBe("under_review");
    const started = status.clockStartedAt.slice(0, 10);
    expect(status.decisionDueOn).toBe(arcDeadline("CA", "solar", 60, status.clockStartedAt).dueOn);
    expect(status.decisionDueOn > started).toBe(true);
    expect(status.deadlineBasis).toContain("45 days");
    expect(status.deadlineBasis).toContain("§714");
    const list = await json(await call(w, `/v1/organizations/${ORG}/arc/requests?due_within=60`, { headers: as(OWNER) }));
    expect(list.data.requests).toHaveLength(1);
    expect(list.data.requests[0].deadlineRule).toBe("CA.solar");
    expect(list.data.requests[0].daysRemaining).toBe(45);
  });
});

describe("the nightly clock", () => {
  it("sends each rung once, whatever the cron does", async () => {
    const w = world();
    await board(w);
    await complete(w, "fence");
    pin(w, "2026-09-01T10:00:00.000Z", "2026-10-01");

    expect(await runClock(w.env, new Date("2026-09-10T14:00:00Z"))).toMatchObject({ reminded: 0 });
    expect(await runClock(w.env, new Date("2026-09-17T14:00:00Z"))).toMatchObject({ reminded: 1 });
    // Same day again, and two at once: nothing more.
    await runClock(w.env, new Date("2026-09-17T14:00:00Z"));
    await Promise.all([runClock(w.env, new Date("2026-09-17T15:00:00Z")), runClock(w.env, new Date("2026-09-17T15:00:00Z"))]);
    expect(reminders(w)).toHaveLength(1);
    expect(reminders(w)[0]!.recipient.address).toBe("arc@oakhollow.example");

    await runClock(w.env, new Date("2026-09-24T14:00:00Z")); // 7 days
    await runClock(w.env, new Date("2026-09-28T14:00:00Z")); // 3 days — escalation copied
    expect(reminders(w).map((r) => r.recipient.address)).toEqual([
      "arc@oakhollow.example",
      "arc@oakhollow.example",
      "arc@oakhollow.example",
      "president@oakhollow.example",
    ]);
    const rungs = (w.db.prepare("SELECT offset_days FROM arc_deadline_reminders ORDER BY offset_days DESC").all() as { offset_days: number }[]).map((r) => r.offset_days);
    expect(rungs).toEqual([14, 7, 3]);
  });

  it("flags a missed deadline once and escalates it with the rule's citation", async () => {
    const w = world();
    await board(w, "CA", 60);
    await complete(w, "solar");
    pin(w, "2026-08-01T10:00:00.000Z", "2026-09-15");
    const first = await runClock(w.env, new Date("2026-09-16T14:00:00Z"));
    expect(first).toMatchObject({ missed: 1, reminded: 1 });
    const second = await runClock(w.env, new Date("2026-09-17T14:00:00Z"));
    expect(second).toMatchObject({ missed: 0, reminded: 0 });
    const row = w.db.prepare("SELECT deadline_missed_at FROM arc_requests").get() as { deadline_missed_at: string };
    expect(row.deadline_missed_at).toBe("2026-09-16T14:00:00.000Z");
    const sent = reminders(w);
    expect(sent.map((r) => r.recipient.address).sort()).toEqual(["arc@oakhollow.example", "president@oakhollow.example"]);
    expect(sent[0]!.templateData.missed).toBe(true);
    const audit = w.db.prepare("SELECT description FROM events_audit_entries WHERE event_type = 'arc.request.deadline_missed'").all() as { description: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.description).toContain("§714");
  });

  it("does not chase a decided request", async () => {
    const w = world();
    await board(w);
    await complete(w, "fence");
    const list = await json(await call(w, `/v1/organizations/${ORG}/arc/requests`, { headers: as(OWNER) }));
    await call(w, `/v1/organizations/${ORG}/arc/requests/${list.data.requests[0].id}/decision`, {
      method: "POST",
      headers: { ...as(OWNER), "content-type": "application/json" },
      body: JSON.stringify({ outcome: "approved" }),
    });
    pin(w, "2026-08-01T10:00:00.000Z", "2026-09-01");
    expect(await runClock(w.env, new Date("2026-09-20T14:00:00Z"))).toEqual({ healed: 0, deadlined: 0, reminded: 0, missed: 0 });
  });

  it("dates a running request that has no due date, and heals an interrupted clock start", async () => {
    const w = world();
    await board(w, "TX", 30);
    await complete(w, "fence");
    w.db.prepare("UPDATE arc_requests SET decision_due_on = NULL, deadline_rule = NULL").run();
    // A second request whose documents are all in but whose clock never started.
    const { token } = await complete(w, "roofing");
    w.db.prepare("UPDATE arc_requests SET status = 'incomplete', clock_started_at = NULL, decision_due_on = NULL, deadline_rule = NULL WHERE number = 2").run();
    const run = await runClock(w.env, new Date());
    expect(run.healed).toBe(1);
    expect(run.deadlined).toBe(2);
    const status = (await json(await call(w, `/v1/public/arc/requests/${token}`))).data.status;
    expect(status.status).toBe("under_review");
    expect(status.decisionDueOn).not.toBeNull();
  });
});
