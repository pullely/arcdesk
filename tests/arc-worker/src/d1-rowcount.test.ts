import { createArcRepository } from "@saas/db/arc";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./harness";

// Runbook trap 22: the D1 executor reports rowCount = rows.length, so a write
// without RETURNING always reports 0 on D1, whatever it changed. These run the
// real executor over a real SQLite engine — the combination a mocked executor
// hides — and pin that the arc repository decides "did my write happen?" from
// RETURNING rows, never from rowCount.

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-09-23T10:00:00.000Z";

describe("trap 22: rowCount after a write on D1", () => {
  it("is 0 for an UPDATE without RETURNING even though the row changed", async () => {
    const db = migratedDatabase();
    const executor = createSqlExecutor(d1Over(db));
    const arc = createArcRepository(executor);
    const { board } = await arc.upsertBoard({
      id: crypto.randomUUID(), orgId: ORG, publicSlug: "elm", associationName: "Elm", state: "TX",
      reviewDays: 30, contactEmail: "a@b.co", escalationEmail: null, formEnabled: true, appealText: null, createdBy: null, now: NOW,
    });

    const bare = await executor.execute(`UPDATE arc_boards SET association_name = $2 WHERE id = $1`, [board.id, "Elm HOA"]);
    expect(bare.rowCount).toBe(0); // the trap: the row DID change
    expect((await arc.getBoardById(board.id))?.associationName).toBe("Elm HOA");

    const returning = await executor.execute(`UPDATE arc_boards SET association_name = $2 WHERE id = $1 RETURNING id`, [board.id, "Elm"]);
    expect(returning.rowCount).toBe(1);
  });

  it("the clock-start write reports its outcome through RETURNING: once, then never", async () => {
    const db = migratedDatabase();
    const arc = createArcRepository(createSqlExecutor(d1Over(db)));
    const { board } = await arc.upsertBoard({
      id: crypto.randomUUID(), orgId: ORG, publicSlug: "oak", associationName: "Oak", state: "TX",
      reviewDays: 30, contactEmail: "a@b.co", escalationEmail: null, formEnabled: true, appealText: null, createdBy: null, now: NOW,
    });
    await arc.createChecklistItem({ id: crypto.randomUUID(), orgId: ORG, boardId: board.id, key: "site_plan", label: "Site plan", required: true, categories: [], position: 0, now: NOW });
    const request = await arc.createRequest({
      id: crypto.randomUUID(), orgId: ORG, boardId: board.id, number: await arc.allocateRequestNumber(board.id),
      category: "fence", title: "Fence", description: "", propertyAddress: "1 Oak", applicantName: "A",
      applicantEmail: "a@b.co", statusTokenHash: "h".repeat(64), now: NOW,
    });
    expect(await arc.tryStartClock(request.id, NOW)).toBeNull(); // incomplete: no row, so no start
    await arc.createDocument({
      id: crypto.randomUUID(), orgId: ORG, requestId: request.id, checklistKey: "site_plan", objectKey: crypto.randomUUID(),
      filename: "f.pdf", contentType: "application/pdf", byteSize: 1, sha256: "0".repeat(64), uploadedAt: NOW,
    });
    const started = await arc.tryStartClock(request.id, NOW);
    expect(started?.clockStartedAt).toBe(NOW);
    expect(await arc.tryStartClock(request.id, NOW)).toBeNull();
  });
});
