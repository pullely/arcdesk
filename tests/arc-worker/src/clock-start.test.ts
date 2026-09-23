import { createArcRepository } from "@saas/db/arc";
import { createSqlExecutor } from "@saas/db/d1";
import { checklistState, isChecklistComplete } from "@arc-worker/present";
import { d1Over, migratedDatabase } from "./harness";

// The SQL rule (tryStartClock) and the TypeScript rule (checklistState) must
// agree on what "complete" means; these cases pin both at once.

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-09-23T10:00:00.000Z";

async function setup() {
  const db = migratedDatabase();
  const arc = createArcRepository(createSqlExecutor(d1Over(db)));
  const { board } = await arc.upsertBoard({
    id: crypto.randomUUID(), orgId: ORG, publicSlug: "elm", associationName: "Elm", state: "TX",
    reviewDays: 30, contactEmail: "a@b.co", escalationEmail: null, formEnabled: true, createdBy: null, now: NOW,
  });
  const add = (key: string, required: boolean, categories: string[] = []) =>
    arc.createChecklistItem({ id: crypto.randomUUID(), orgId: ORG, boardId: board.id, key, label: key, required, categories, position: 0, now: NOW });
  await add("site_plan", true);
  await add("panel_spec", true, ["solar"]);
  await add("photos", false);
  const request = await arc.createRequest({
    id: crypto.randomUUID(), orgId: ORG, boardId: board.id, number: await arc.allocateRequestNumber(board.id),
    category: "fence", title: "Fence", description: "", propertyAddress: "1 Elm", applicantName: "A",
    applicantEmail: "a@b.co", statusTokenHash: "h".repeat(64), now: NOW,
  });
  const doc = (key: string | null) =>
    arc.createDocument({
      id: crypto.randomUUID(), orgId: ORG, requestId: request.id, checklistKey: key, objectKey: crypto.randomUUID(),
      filename: "f.pdf", contentType: "application/pdf", byteSize: 1, sha256: "0".repeat(64), uploadedAt: NOW,
    });
  return { arc, board, request, doc, add };
}

describe("tryStartClock", () => {
  it("ignores items that do not apply to the category and items that are optional", async () => {
    const { arc, board, request, doc } = await setup();
    expect(await arc.tryStartClock(request.id, NOW)).toBeNull();
    await doc("site_plan");
    const items = await arc.listChecklist(board.id, false);
    expect(isChecklistComplete(checklistState(items, "fence", await arc.listDocuments(request.id)))).toBe(true);
    const started = await arc.tryStartClock(request.id, NOW);
    expect(started?.status).toBe("under_review");
    expect(started?.clockStartedAt).toBe(NOW);
  });

  it("starts at most once, however many times it is asked", async () => {
    const { arc, request, doc } = await setup();
    await doc("site_plan");
    const results = await Promise.all([arc.tryStartClock(request.id, NOW), arc.tryStartClock(request.id, NOW)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await arc.tryStartClock(request.id, "2026-09-24T00:00:00.000Z")).toBeNull();
  });

  it("does not count an extra attachment toward a checklist item", async () => {
    const { arc, request, doc } = await setup();
    await doc(null);
    expect(await arc.tryStartClock(request.id, NOW)).toBeNull();
  });

  it("stops gating on an archived item", async () => {
    const { arc, board, request } = await setup();
    const items = await arc.listChecklist(board.id, false);
    const sitePlan = items.find((i) => i.key === "site_plan")!;
    await arc.archiveChecklistItem(ORG, sitePlan.id, NOW);
    expect((await arc.tryStartClock(request.id, NOW))?.status).toBe("under_review");
  });
});
