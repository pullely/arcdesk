import { createHash } from "node:crypto";
import { route } from "@arc-worker/router";
import { orgPublicId } from "@arc-worker/ids";
import { MEMBER, OWNER, STRANGER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const BASE = "https://arc.internal";

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

async function openBoard(w: TestWorld, slug = "oak-hollow"): Promise<Response> {
  return call(w, `/v1/organizations/${ORG}/arc/board`, {
    method: "PUT",
    headers: { ...as(OWNER), "content-type": "application/json" },
    body: JSON.stringify({
      associationName: "Oak Hollow HOA",
      publicSlug: slug,
      state: "CA",
      reviewDays: 30,
      contactEmail: "arc@oakhollow.example",
    }),
  });
}

async function submit(w: TestWorld, category = "solar"): Promise<Record<string, any>> {
  const res = await call(w, "/v1/public/arc/boards/oak-hollow/requests", {
    method: "POST",
    headers: { "content-type": "application/json", "x-public-origin": "https://edge.example" },
    body: JSON.stringify({
      category,
      title: "Rooftop solar, 12 panels",
      propertyAddress: "12 Oak Hollow Ln",
      applicantName: "Dana Reyes",
      applicantEmail: "Dana@Example.com",
    }),
  });
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

function pdf(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${label}\n%%EOF\n`);
}

async function upload(w: TestWorld, token: string, key: string, bytes: Uint8Array, type = "application/pdf"): Promise<Response> {
  return call(w, `/v1/public/arc/requests/${token}/documents/${key}?filename=${key}.pdf`, {
    method: "PUT",
    headers: { "content-type": type },
    body: bytes,
  });
}

describe("the board", () => {
  it("is created with the default checklist, then updated in place", async () => {
    const w = world();
    const created = await openBoard(w);
    expect(created.status).toBe(201);
    const board = (await json(created)).data.board;
    expect(board.formUrlPath).toBe("/arc/f/oak-hollow");
    expect(board.id).toMatch(/^arb_[0-9a-f]{32}$/);

    const list = await json(await call(w, `/v1/organizations/${ORG}/arc/checklist`, { headers: as(MEMBER) }));
    expect(list.data.items.map((i: { key: string }) => i.key)).toEqual([
      "site_plan", "elevations", "materials", "contractor_licence", "panel_layout", "panel_spec", "electrical_plan",
    ]);

    expect((await openBoard(w)).status).toBe(200);
  });

  it("refuses a slug another association holds", async () => {
    const w = world();
    await openBoard(w);
    const other = orgPublicId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const res = await call(w, `/v1/organizations/${other}/arc/board`, {
      method: "PUT",
      headers: { ...as(OWNER), "content-type": "application/json" },
      body: JSON.stringify({ associationName: "Elm", publicSlug: "oak-hollow", contactEmail: "a@b.co" }),
    });
    expect(res.status).toBe(409);
  });

  it("is invisible to a non-member and closed to a committee member's edits", async () => {
    const w = world();
    await openBoard(w);
    expect((await call(w, `/v1/organizations/${ORG}/arc/board`, { headers: as(STRANGER) })).status).toBe(404);
    const res = await call(w, `/v1/organizations/${ORG}/arc/checklist`, {
      method: "POST",
      headers: { ...as(MEMBER), "content-type": "application/json" },
      body: JSON.stringify({ key: "survey", label: "Survey" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("the public lane", () => {
  it("does not start the clock until every required document is in, then starts it once", async () => {
    const w = world();
    await openBoard(w);

    const board = await json(await call(w, "/v1/public/arc/boards/oak-hollow"));
    expect(board.data.board.associationName).toBe("Oak Hollow HOA");

    const submitted = await submit(w, "solar");
    const token: string = submitted.statusToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(submitted.statusUrlPath).toBe(`/arc/s/${token}`);
    expect(submitted.status.status).toBe("incomplete");
    expect(submitted.status.clockStartedAt).toBeNull();
    expect(submitted.status.reference).toBe("AR-0001");
    const required = submitted.status.checklist.filter((c: { required: boolean }) => c.required).map((c: { key: string }) => c.key);
    expect(required).toEqual(["site_plan", "elevations", "panel_layout", "panel_spec"]);

    // Only the hash is stored.
    const row = w.db.prepare("SELECT status_token_hash FROM arc_requests").get() as { status_token_hash: string };
    expect(row.status_token_hash).toBe(createHash("sha256").update(token).digest("hex"));

    // The homeowner got their link by email.
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      templateKey: "arc.request.received",
      recipient: { address: "dana@example.com" },
      templateData: { statusUrl: `https://edge.example/arc/s/${token}`, reference: "AR-0001" },
    });

    for (const key of ["site_plan", "elevations", "panel_layout"]) {
      const res = await upload(w, token, key, pdf(key));
      expect(res.status).toBe(201);
      expect((await json(res)).data.clockStarted).toBe(false);
    }
    // An optional document does not start it either.
    expect((await json(await upload(w, token, "materials", pdf("materials")))).data.clockStarted).toBe(false);

    const last = await json(await upload(w, token, "panel_spec", pdf("panel_spec")));
    expect(last.data.clockStarted).toBe(true);
    expect(last.data.status.status).toBe("under_review");
    expect(last.data.status.clockStartedAt).not.toBeNull();

    // A further upload does not restart it.
    const again = await json(await upload(w, token, "_extra", pdf("extra")));
    expect(again.data.clockStarted).toBe(false);
    expect(again.data.status.clockStartedAt).toBe(last.data.status.clockStartedAt);

    const events = w.db
      .prepare("SELECT type FROM events_event_log WHERE subject_kind = 'arc_request' ORDER BY occurred_at, type")
      .all() as { type: string }[];
    expect(events.filter((e) => e.type === "arc.request.clock_started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "arc.request.submitted")).toHaveLength(1);

    // …and each one has its audit row (the trail the console reads).
    const audit = w.db
      .prepare("SELECT event_type FROM events_audit_entries WHERE category = 'arc' AND event_type = 'arc.request.clock_started'")
      .all();
    expect(audit).toHaveLength(1);
  });

  it("round-trips a document byte for byte through R2", async () => {
    const w = world();
    await openBoard(w);
    const { statusToken } = await submit(w, "fence");
    const bytes = pdf("a site plan with a few bytes of body éü");
    const up = await json(await upload(w, statusToken, "site_plan", bytes));
    const doc = up.data.document;
    expect(doc.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(doc.byteSize).toBe(bytes.byteLength);

    const list = await json(await call(w, `/v1/organizations/${ORG}/arc/requests`, { headers: as(MEMBER) }));
    const req = list.data.requests[0];
    expect(req.reference).toBe("AR-0001");
    expect(req.applicantEmail).toBe("dana@example.com");

    const res = await call(w, `/v1/organizations/${ORG}/arc/requests/${req.id}/documents/${doc.id}`, { headers: as(MEMBER) });
    expect(res.status).toBe(200);
    const back = new Uint8Array(await res.arrayBuffer());
    expect(createHash("sha256").update(back).digest("hex")).toBe(doc.sha256);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("answers the status link for the right token and 404 for any other", async () => {
    const w = world();
    await openBoard(w);
    const { statusToken } = await submit(w, "fence");
    const ok = await call(w, `/v1/public/arc/requests/${statusToken}`);
    expect(ok.status).toBe(200);
    const status = (await json(ok)).data.status;
    expect(status.associationName).toBe("Oak Hollow HOA");
    expect(JSON.stringify(status)).not.toContain("dana@example.com");

    const wrong = statusToken.slice(0, -1) + (statusToken.endsWith("A") ? "B" : "A");
    expect((await call(w, `/v1/public/arc/requests/${wrong}`)).status).toBe(404);
    expect((await call(w, "/v1/public/arc/requests/short")).status).toBe(404);
    expect((await call(w, `/arc/s/${wrong}`)).status).toBe(404);

    const page = await call(w, `/arc/s/${statusToken}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("AR-0001");
  });

  it("refuses uploads it should not take", async () => {
    const w = world();
    await openBoard(w);
    const { statusToken } = await submit(w, "fence");
    expect((await upload(w, statusToken, "panel_layout", pdf("x"))).status).toBe(404); // solar-only item
    expect((await upload(w, statusToken, "site_plan", pdf("x"), "text/html")).status).toBe(415);
    expect((await upload(w, statusToken, "site_plan", new Uint8Array())).status).toBe(422);
  });

  it("serves the form page and 404s a switched-off board", async () => {
    const w = world();
    await openBoard(w);
    const page = await call(w, "/arc/f/oak-hollow");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Oak Hollow HOA");

    await call(w, `/v1/organizations/${ORG}/arc/board`, {
      method: "PUT",
      headers: { ...as(OWNER), "content-type": "application/json" },
      body: JSON.stringify({ associationName: "Oak Hollow HOA", publicSlug: "oak-hollow", contactEmail: "arc@oakhollow.example", formEnabled: false }),
    });
    expect((await call(w, "/arc/f/oak-hollow")).status).toBe(404);
    expect((await call(w, "/v1/public/arc/boards/oak-hollow")).status).toBe(404);
  });

  it("numbers requests per board without gaps or repeats", async () => {
    const w = world();
    await openBoard(w);
    const refs = [];
    for (let i = 0; i < 3; i++) refs.push((await submit(w, "roofing")).status.reference);
    expect(refs).toEqual(["AR-0001", "AR-0002", "AR-0003"]);
  });
});

describe("routing", () => {
  it("401s an org route without actor headers and 405s a wrong method", async () => {
    const w = world();
    expect((await call(w, `/v1/organizations/${ORG}/arc/requests`)).status).toBe(401);
    expect((await call(w, `/v1/organizations/${ORG}/arc/requests`, { method: "POST", headers: as(OWNER) })).status).toBe(405);
    expect((await call(w, "/v1/nope")).status).toBe(404);
  });

  it("reports its bindings on /health", async () => {
    const w = world();
    const res = await json(await call(w, "/health"));
    expect(res.data.service).toBe("arc-worker");
    expect(res.data.checks.documents.configured).toBe(true);
  });
});
