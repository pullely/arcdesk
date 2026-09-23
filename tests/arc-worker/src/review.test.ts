import { createHash } from "node:crypto";
import { route } from "@arc-worker/router";
import { orgPublicId } from "@arc-worker/ids";
import { letterBlocks } from "@arc-worker/letter";
import { renderPdf } from "@arc-worker/pdf";
import { MEMBER, OWNER, STRANGER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const BASE = "https://arc.internal";

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

function send(w: TestWorld, who: string, method: string, path: string, body: unknown): Promise<Response> {
  return call(w, path, { method, headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(body) });
}

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label}\n%%EOF\n`);

/** A board in `state`, and one fence request — complete (clock running) unless told otherwise. */
async function running(w: TestWorld, opts: { state?: string; complete?: boolean; appealText?: string } = {}) {
  await send(w, OWNER, "PUT", `/v1/organizations/${ORG}/arc/board`, {
    associationName: "Oak Hollow HOA",
    publicSlug: "oak-hollow",
    state: opts.state ?? "CA",
    contactEmail: "arc@oakhollow.example",
    appealText: opts.appealText,
  });
  const sub = await json(
    await call(w, "/v1/public/arc/boards/oak-hollow/requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-public-origin": "https://edge.example" },
      body: JSON.stringify({
        category: "fence",
        title: "Cedar fence, 6 ft",
        propertyAddress: "12 Oak Hollow Ln",
        applicantName: "Dana Reyes",
        applicantEmail: "dana@example.com",
      }),
    }),
  );
  const token: string = sub.data.statusToken;
  if (opts.complete !== false) {
    for (const key of ["site_plan", "elevations"]) {
      await call(w, `/v1/public/arc/requests/${token}/documents/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: pdf(key),
      });
    }
  }
  const list = await json(await call(w, `/v1/organizations/${ORG}/arc/requests`, { headers: as(OWNER) }));
  const id: string = list.data.requests[0].id;
  return { token, id, base: `/v1/organizations/${ORG}/arc/requests/${id}` };
}

describe("votes", () => {
  it("keeps one row per voter — a second vote replaces the first", async () => {
    const w = world();
    const { base } = await running(w);
    expect((await send(w, MEMBER, "PUT", `${base}/votes/me`, { vote: "deny" })).status).toBe(200);
    const second = await json(await send(w, MEMBER, "PUT", `${base}/votes/me`, { vote: "approve_with_conditions", conditions: "Stain to match" }));
    expect(second.data.tally).toEqual({ approve: 0, approve_with_conditions: 1, deny: 0, abstain: 0 });
    await send(w, OWNER, "PUT", `${base}/votes/me`, { vote: "approve" });
    const votes = await json(await call(w, `${base}/votes`, { headers: as(MEMBER) }));
    expect(votes.data.votes).toHaveLength(2);
    expect(votes.data.tally).toEqual({ approve: 1, approve_with_conditions: 1, deny: 0, abstain: 0 });
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM arc_votes").get() as { n: number }).n).toBe(2);
  });

  it("requires conditions on a conditional vote, and refuses a non-member", async () => {
    const w = world();
    const { base } = await running(w);
    expect((await send(w, MEMBER, "PUT", `${base}/votes/me`, { vote: "approve_with_conditions" })).status).toBe(422);
    expect((await send(w, STRANGER, "PUT", `${base}/votes/me`, { vote: "approve" })).status).toBe(404);
  });

  it("refuses to vote on or decide an incomplete request", async () => {
    const w = world();
    const { base } = await running(w, { complete: false });
    const vote = await send(w, MEMBER, "PUT", `${base}/votes/me`, { vote: "approve" });
    expect(vote.status).toBe(409);
    expect((await json(vote)).error.details.reason).toBe("clock_not_started");
    const decide = await send(w, OWNER, "POST", `${base}/decision`, { outcome: "approved" });
    expect(decide.status).toBe(409);
  });
});

describe("comments", () => {
  it("shows applicant-visible comments on the status page and keeps committee notes internal", async () => {
    const w = world();
    const { base, token } = await running(w);
    await send(w, MEMBER, "POST", `${base}/comments`, { body: "Setback looks short on the east side" });
    await send(w, MEMBER, "POST", `${base}/comments`, { body: "Please confirm the fence height", visibility: "applicant" });
    const all = await json(await call(w, `${base}/comments`, { headers: as(OWNER) }));
    expect(all.data.comments).toHaveLength(2);
    const status = await json(await call(w, `/v1/public/arc/requests/${token}`));
    expect(status.data.status.messages).toEqual([{ body: "Please confirm the fence height", createdAt: expect.any(String) }]);
  });
});

describe("the decision", () => {
  it("validates the letter's substance", async () => {
    const w = world();
    const { base } = await running(w);
    expect((await send(w, OWNER, "POST", `${base}/decision`, { outcome: "denied" })).status).toBe(422);
    expect((await send(w, OWNER, "POST", `${base}/decision`, { outcome: "approved_with_conditions" })).status).toBe(422);
    expect((await send(w, MEMBER, "POST", `${base}/decision`, { outcome: "approved" })).status).toBe(404); // builders vote, they do not decide
  });

  it("renders the letter into R2, closes the request, emails the homeowner and serves the letter by token", async () => {
    const w = world();
    const { base, token } = await running(w, { state: "TX" });
    await send(w, MEMBER, "PUT", `${base}/votes/me`, { vote: "deny" });
    await send(w, OWNER, "PUT", `${base}/votes/me`, { vote: "deny" });

    const res = await send(w, OWNER, "POST", `${base}/decision`, {
      outcome: "denied",
      rationale: "The fence exceeds the 5 ft height limit in Article 7.",
    });
    expect(res.status).toBe(201);
    const decision = (await json(res)).data.decision;
    expect(decision.id).toMatch(/^adc_[0-9a-f]{32}$/);
    expect(decision.voteTally).toEqual({ approve: 0, approve_with_conditions: 0, deny: 2, abstain: 0 });
    expect(decision.letterEmailedAt).not.toBeNull();

    // The letter in R2 is a PDF whose hash is the one on the decision row.
    const row = w.db.prepare("SELECT letter_object_key, letter_sha256 FROM arc_decisions").get() as { letter_object_key: string; letter_sha256: string };
    const stored = w.r2.objects.get(row.letter_object_key)!.bytes;
    expect(new TextDecoder().decode(stored.slice(0, 5))).toBe("%PDF-");
    expect(createHash("sha256").update(stored).digest("hex")).toBe(row.letter_sha256);
    expect(decision.letterSha256).toBe(row.letter_sha256);

    // The request is closed, and closed to uploads and second decisions.
    const status = (await json(await call(w, `/v1/public/arc/requests/${token}`))).data.status;
    expect(status.status).toBe("denied");
    expect(status.decision.outcome).toBe("denied");
    expect(status.decision.rationale).toContain("5 ft");
    const again = await send(w, OWNER, "POST", `${base}/decision`, { outcome: "approved" });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.reason).toBe("already_decided");
    const late = await call(w, `/v1/public/arc/requests/${token}/documents/site_plan`, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: pdf("late"),
    });
    expect(late.status).toBe(409);

    // The homeowner fetches it by status token…
    const byStatus = await call(w, status.decision.letterPath);
    expect(byStatus.status).toBe(200);
    expect(byStatus.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await byStatus.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.letter_sha256);

    // …and by the link in the decision email, which is a different capability.
    const mail = w.sent.find((m) => (m as { templateKey: string }).templateKey === "arc.request.decided") as {
      templateData: { letterUrl: string; outcome: string };
    };
    expect(mail.templateData.outcome).toBe("Denied");
    const letterPath = new URL(mail.templateData.letterUrl).pathname;
    expect(letterPath).toMatch(/^\/v1\/public\/arc\/letters\/[A-Za-z0-9_-]{43}$/);
    expect((await call(w, letterPath)).status).toBe(200);
    expect((await call(w, "/v1/public/arc/letters/" + "x".repeat(43))).status).toBe(404);

    // The committee's copy.
    expect((await call(w, `${base}/letter`, { headers: as(MEMBER) })).status).toBe(200);

    // Every step is in the audit trail.
    const types = (w.db.prepare("SELECT event_type FROM events_audit_entries WHERE category = 'arc'").all() as { event_type: string }[]).map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(["arc.request.voted", "arc.request.decided", "arc.request.letter_emailed"]));
  });
});

describe("the letter", () => {
  const board = {
    id: "b", orgId: ORG_UUID, publicSlug: "oak-hollow", associationName: "Oak Hollow HOA", state: "CA", reviewDays: 30,
    contactEmail: "arc@oakhollow.example", escalationEmail: null, formEnabled: true, appealText: null as string | null,
    createdBy: null, createdAt: "", updatedAt: "",
  };
  const request = {
    id: "r", orgId: ORG_UUID, boardId: "b", number: 7, category: "solar", title: "Rooftop solar", description: "",
    propertyAddress: "12 Oak Hollow Ln", applicantName: "Dana Reyes", applicantEmail: "d@e.co", status: "under_review",
    submittedAt: "2026-09-01T10:00:00.000Z", clockStartedAt: "2026-09-02T10:00:00.000Z", decisionDueOn: null, decidedAt: null,
    createdAt: "", updatedAt: "",
  };
  const tally = { approve: 2, approve_with_conditions: 1, deny: 0, abstain: 0 };

  it("carries the state's appeal route with its citation, then the association's own words", () => {
    const text = letterBlocks({ board: { ...board, appealText: "Appeals go to the March open meeting." }, request, outcome: "approved_with_conditions", conditions: "Black frames only", rationale: null, tally, decidedAt: "2026-09-20T00:00:00.000Z" })
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("AR-0007");
    expect(text).toContain("Approved with conditions");
    expect(text).toContain("Black frames only");
    expect(text).toContain("Cal. Civ. Code §4765");
    expect(text).toContain("Appeals go to the March open meeting.");
    expect(text).toContain("Approve 2");
  });

  it("falls back to generic wording where no statute is modelled", () => {
    const text = letterBlocks({ board: { ...board, state: "OTHER" }, request, outcome: "approved", conditions: null, rationale: null, tally, decidedAt: "2026-09-20T00:00:00.000Z" })
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("governing documents");
  });

  it("writes a well-formed PDF: header, xref offsets that point at objects, trailer", () => {
    const bytes = renderPdf([{ text: "Hello (world) \\ § — café", bold: true }, { text: "word ".repeat(2000) }], { title: "t" });
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThan(1); // 2000 words wrap onto a second page
    expect([...bytes].every((b) => b < 0x80)).toBe(true); // 7-bit clean: non-ASCII is octal-escaped
  });
});
