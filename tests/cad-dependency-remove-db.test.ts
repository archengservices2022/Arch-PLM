/**
 * B06 G-3: removing a CAD structure link (app/lib/cad-dependency-remove-db.ts).
 * In-memory fake database; run with:
 *   node --experimental-strip-types --test tests/cad-dependency-remove-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAD_DEPENDENCY_REMOVED_EVENT,
  removeCadDependencyForActor,
  type CadDependencyRemovedLog,
  type RemoveCadDependencyDb,
} from "../app/lib/cad-dependency-remove-db.ts";
import { ActionRefusalError, retryOnSerializationConflict } from "../app/lib/action-notice-core.ts";

interface Edge {
  organizationId: string;
  id: string;
  parentDocumentId: string;
  childDocumentId: string;
  dependencyType: string;
}

class SerializationConflict extends Error {
  readonly code = "P2034";
}

/** Minimal fake: one $transaction with rollback, the two edge calls, and the
 *  raw FOR UPDATE lock (recorded in order). */
class FakeDb {
  edges: Edge[] = [];
  readonly ops: string[] = [];
  readonly isolationLevels: unknown[] = [];
  /** Fail this many transaction attempts with a serialization conflict
   *  (thrown at the lock, like a real deadlock / 40001). */
  conflictsToThrow = 0;
  /** Simulate another remover deleting the edge between read and delete. */
  removeConcurrentlyAfterRead = false;

  get db(): RemoveCadDependencyDb {
    return {
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>, opts?: { isolationLevel?: unknown }) => {
        this.isolationLevels.push(opts?.isolationLevel);
        const snapshot = this.edges.map((e) => ({ ...e }));
        try {
          return await fn(this.#tx());
        } catch (error) {
          this.edges = snapshot; // rollback
          throw error;
        }
      }) as unknown as RemoveCadDependencyDb["$transaction"],
    };
  }

  #tx() {
    return {
      cadDependency: {
        findFirst: async (args: { where: { organizationId: string; id: string } }) => {
          this.ops.push("read");
          const edge = this.edges.find(
            (e) => e.organizationId === args.where.organizationId && e.id === args.where.id,
          );
          if (edge && this.removeConcurrentlyAfterRead) {
            this.edges = this.edges.filter((e) => e !== edge);
          }
          return edge
            ? {
                id: edge.id,
                parentDocumentId: edge.parentDocumentId,
                childDocumentId: edge.childDocumentId,
                dependencyType: edge.dependencyType,
              }
            : null;
        },
        deleteMany: async (args: { where: { organizationId: string; id: string } }) => {
          this.ops.push("delete");
          const before = this.edges.length;
          this.edges = this.edges.filter(
            (e) => !(e.organizationId === args.where.organizationId && e.id === args.where.id),
          );
          return { count: before - this.edges.length };
        },
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        assert.match(strings.join("?"), /FOR UPDATE/);
        this.ops.push(`lock:${String(values[0])}:${String(values[1])}`);
        if (this.conflictsToThrow > 0) {
          this.conflictsToThrow -= 1;
          throw new SerializationConflict("could not serialize access");
        }
        return [{ id: values[0], organizationId: values[1] }];
      },
    };
  }
}

const actor = { userId: "user-a", organizationId: "orgA" };
const at = new Date("2026-11-19T15:00:00.000Z");

function seeded(): FakeDb {
  const db = new FakeDb();
  db.edges.push(
    { organizationId: "orgA", id: "e1", parentDocumentId: "z-asm", childDocumentId: "a-part", dependencyType: "COMPONENT" },
    { organizationId: "orgA", id: "e2", parentDocumentId: "z-asm", childDocumentId: "b-part", dependencyType: "COMPONENT" },
    { organizationId: "orgB", id: "e-foreign", parentDocumentId: "x", childDocumentId: "y", dependencyType: "COMPONENT" },
  );
  return db;
}

async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ActionRefusalError);
    assert.equal(error.code, "CAD_DEPENDENCY_NOT_FOUND");
    return true;
  });
}

test("G-3: removes the organization's link, under SERIALIZABLE, locking both endpoints in ascending order BEFORE the delete", async () => {
  const db = seeded();
  const logs: CadDependencyRemovedLog[] = [];
  await removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e), now: () => at });

  assert.deepEqual(db.edges.map((e) => e.id), ["e2", "e-foreign"], "only e1 removed");
  assert.deepEqual(db.isolationLevels, ["Serializable"]);
  assert.deepEqual(db.ops, ["read", "lock:a-part:orgA", "lock:z-asm:orgA", "delete"]);
  assert.equal(logs.length, 1);
});

test("G-3: exactly one log line per committed removal, with exactly the listed fields (ids only)", async () => {
  const db = seeded();
  const logs: CadDependencyRemovedLog[] = [];
  const returned = await removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e), now: () => at });

  assert.deepEqual(logs, [
    {
      event: CAD_DEPENDENCY_REMOVED_EVENT,
      actorUserId: "user-a",
      organizationId: "orgA",
      parentDocumentId: "z-asm",
      childDocumentId: "a-part",
      dependencyType: "COMPONENT",
      at: "2026-11-19T15:00:00.000Z",
    },
  ]);
  assert.deepEqual(Object.keys(logs[0]!).sort(), [
    "actorUserId", "at", "childDocumentId", "dependencyType", "event", "organizationId", "parentDocumentId",
  ]);
  assert.deepEqual(returned, logs[0]);
});

test("G-3: the default sink writes ONE JSON line to the server log", async () => {
  const db = seeded();
  const lines: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    await removeCadDependencyForActor(actor, "e1", db.db, { now: () => at });
  } finally {
    console.info = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.length, 1);
  const parsed = JSON.parse(String(lines[0]![0]));
  assert.equal(parsed.event, "cad_dependency_removed");
  assert.equal(parsed.childDocumentId, "a-part");
});

test("G-3: tenant isolation - another organization's link is 'not found'; nothing removed, nothing logged", async () => {
  const db = seeded();
  const logs: CadDependencyRemovedLog[] = [];
  await expectNotFound(() => removeCadDependencyForActor(actor, "e-foreign", db.db, { log: (e) => logs.push(e) }));
  assert.equal(db.edges.length, 3);
  assert.equal(logs.length, 0);
  assert.ok(!db.ops.some((op) => op.startsWith("lock") || op === "delete"), "no lock or delete for a foreign id");
});

test("G-3: an unknown id is 'not found'; nothing logged", async () => {
  const db = seeded();
  const logs: CadDependencyRemovedLog[] = [];
  await expectNotFound(() => removeCadDependencyForActor(actor, "nope", db.db, { log: (e) => logs.push(e) }));
  assert.equal(logs.length, 0);
});

test("G-3: removed concurrently by someone else (0 rows deleted) is 'not found'; nothing logged", async () => {
  const db = seeded();
  db.removeConcurrentlyAfterRead = true;
  const logs: CadDependencyRemovedLog[] = [];
  await expectNotFound(() => removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e) }));
  assert.equal(logs.length, 0);
});

test("G-3: a serialization conflict propagates unchanged and rolls back; nothing logged", async () => {
  const db = seeded();
  db.conflictsToThrow = 1;
  const logs: CadDependencyRemovedLog[] = [];
  await assert.rejects(
    () => removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e) }),
    SerializationConflict,
  );
  assert.equal(db.edges.length, 3, "rolled back");
  assert.equal(logs.length, 0);
});

const isConflict = (error: unknown) => error instanceof SerializationConflict;

test("G-3 with the bounded retry: conflicts then success -> removed once, logged once", async () => {
  const db = seeded();
  db.conflictsToThrow = 2;
  const logs: CadDependencyRemovedLog[] = [];
  await retryOnSerializationConflict(
    () => removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e) }),
    { isConflict, exhaustedMessage: "retry" },
  );
  assert.deepEqual(db.edges.map((e) => e.id), ["e2", "e-foreign"]);
  assert.equal(logs.length, 1, "retried attempts never log");
});

test("G-3 with the bounded retry: always conflicting -> CONCURRENT_CHANGES, nothing removed, nothing logged", async () => {
  const db = seeded();
  db.conflictsToThrow = 99;
  const logs: CadDependencyRemovedLog[] = [];
  await assert.rejects(
    () =>
      retryOnSerializationConflict(
        () => removeCadDependencyForActor(actor, "e1", db.db, { log: (e) => logs.push(e) }),
        { isConflict, exhaustedMessage: "retry" },
      ),
    (error: unknown) => error instanceof ActionRefusalError && error.code === "CONCURRENT_CHANGES",
  );
  assert.equal(db.edges.length, 3);
  assert.equal(logs.length, 0);
});

test("G-3 Server Action: write roles only, form id required, bounded retry with the shared conflict predicate, notice on refusal", () => {
  const source = readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("export async function removeCadDependency(");
  assert.ok(start > 0, "action exists");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /await refuseUnlessWriteRole\(actor\);/);
  assert.match(body, /assertCanMutate\(actor\);/);
  assert.match(body, /await runWithRefusalNotice\(/);
  assert.match(body, /requiredValue\(formData, "dependencyId"\)/);
  assert.match(body, /retryOnSerializationConflict\(\s*\(\) => removeCadDependencyForActor\(actor, dependencyId, prisma\)/);
  assert.match(body, /isConflict: isSerializationError/);
  assert.match(body, /revalidatePath\("\/"\)/);

  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<form action=\{removeCadDependency\}>\s*<input type="hidden" name="dependencyId" value=\{edge\.id\} \/>/);
});
