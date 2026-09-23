import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import type { Env } from "@arc-worker/env";

// A real SQLite engine under the worker, not a mocked executor: D1 is SQLite,
// so a statement node:sqlite runs is a statement D1 runs — including the
// conditional clock-start UPDATE this context is built on.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

export function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true, meta: {} });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

/** An in-memory R2 bucket: enough of put/get for the worker's two calls. */
export class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string | undefined; custom?: Record<string, string> | undefined }>();

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ key: string }> {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType, custom: opts?.customMetadata });
    return { key };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength };
  }
}

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "22222222-2222-4222-8222-222222222222";
export const STRANGER = "99999999-9999-4999-8999-999999999999";

/**
 * membership-worker + policy-worker stand-ins. OWNER is an org owner (every
 * action); MEMBER is a builder (reads, comments, votes); STRANGER is nobody.
 */
const BUILDER_ACTIONS = new Set(["arc.board.read", "arc.request.read", "arc.request.comment", "arc.request.vote"]);

export function fakeFleet(): { MEMBERSHIP_WORKER: Fetcher; POLICY_WORKER: Fetcher; NOTIFICATIONS_WORKER: Fetcher; sent: unknown[] } {
  const sent: unknown[] = [];
  const membership = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string } };
      const role = body.subject.id === OWNER ? "owner" : body.subject.id === MEMBER ? "builder" : null;
      return Response.json({ data: { memberships: role ? [{ kind: "organization", role }] : [] } });
    },
  };
  const policy = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string }; action: string };
      const allow = body.subject.id === OWNER || (body.subject.id === MEMBER && BUILDER_ACTIONS.has(body.action));
      return Response.json({ data: { allow } });
    },
  };
  const notifications = {
    async fetch(_url: string, init: RequestInit) {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ data: { notification: { id: `ntf_${sent.length}` } } }, { status: 202 });
    },
  };
  return {
    MEMBERSHIP_WORKER: membership as unknown as Fetcher,
    POLICY_WORKER: policy as unknown as Fetcher,
    NOTIFICATIONS_WORKER: notifications as unknown as Fetcher,
    sent,
  };
}

export interface TestWorld {
  env: Env;
  db: DatabaseSync;
  r2: FakeR2;
  sent: unknown[];
}

export function world(): TestWorld {
  const db = migratedDatabase();
  const r2 = new FakeR2();
  const fleet = fakeFleet();
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db),
    ARC_DOCS: r2 as unknown as R2Bucket,
    MEMBERSHIP_WORKER: fleet.MEMBERSHIP_WORKER,
    POLICY_WORKER: fleet.POLICY_WORKER,
    NOTIFICATIONS_WORKER: fleet.NOTIFICATIONS_WORKER,
  } as Env;
  return { env, db, r2, sent: fleet.sent };
}

export function as(subjectId: string): Record<string, string> {
  return { "x-actor-subject-id": subjectId, "x-actor-subject-type": "user" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test payloads are asserted field by field
export async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}
