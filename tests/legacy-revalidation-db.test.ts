/**
 * Option A: transactional tests for `revalidateLegacyRevisionForActor`
 * (`app/lib/legacy-revalidation-db.ts`) against an in-memory fake database.
 *
 * The fake applies writes directly with an undo log (rolled back if the
 * transaction callback throws), enforces the real unique constraints
 * (ItemRevision (itemId, revision); revalidation legacyRevisionId and
 * successorRevisionId) by throwing Prisma-shaped P2002 errors, and yields at
 * every call so two concurrent transactions genuinely interleave. Hooks let a
 * test simulate another transaction committing at a precise moment. The
 * authoritative proof of PostgreSQL behavior is the live gate
 * (scripts/itest-option-a-revalidation.ts).
 *
 * Run with:  node --experimental-strip-types --test tests/legacy-revalidation-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { LifecycleState } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import type { UserRole } from "../app/generated/prisma/enums.ts";
import { InvalidLifecycleCommentError } from "../app/lib/lifecycle-policy-core.ts";
import {
  LegacyRevalidationError,
  revalidateLegacyRevisionForActor,
  type LegacyRevalidationDb,
} from "../app/lib/legacy-revalidation-db.ts";
import { LEGACY_REVALIDATION_MESSAGES } from "../app/lib/legacy-revalidation-core.ts";

const S = LifecycleState;
const id = (p: string) => `${p}-${randomBytes(4).toString("hex")}`;

interface Rev { organizationId: string; id: string; itemId: string; revision: string; lifecycle: string; description: string | null; createdById: string | null; sourceRevisionId: string | null; hold: boolean }
interface Link { organizationId: string; itemRevisionId: string; cadDocumentId: string; createdById: string }
interface Ev { organizationId: string; itemRevisionId: string; fromState: string; toState: string; trigger: string; actedById: string; actedByRole: string; comment: string | null; occurredAt: Date; sequence: bigint }
interface Reval { organizationId: string; legacyRevisionId: string; successorRevisionId: string; actedById: string; actedByRole: string; comment: string; occurredAt: Date; sequence: bigint }

function p2002(target: string[]): Error {
  const e = new Error(`Unique constraint failed on the fields: (${target.join(",")})`);
  Object.assign(e, { code: "P2002", meta: { target } });
  return e;
}
/** Prisma-shaped PostgreSQL serialization failure (retried by runSerializableTransaction). */
function serializationFailure(): Error {
  const e = new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction");
  Object.assign(e, { code: "P2034" });
  return e;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeDb {
  revisions: Rev[] = [];
  links: Link[] = [];
  docs: { organizationId: string; id: string }[] = [];
  users: { organizationId: string; id: string; role: string; active: boolean }[] = [];
  events: Ev[] = [];
  revalidations: Reval[] = [];
  cadDocumentCreates = 0;
  transactionAttempts = 0;
  #seq = 1n;
  hooks: {
    beforeSuccessorCreate?: () => void;
    beforeAudit?: () => void;
    failLinks?: boolean;
    failAudit?: boolean;
    /** Phase 1G: runs before transaction attempt N (1-based, counted across the whole call) - e.g. another session changes the actor. */
    beforeTransaction?: (attempt: number) => void;
    /** Phase 1G: when true for attempt N, that attempt's writes are undone and it fails like a PostgreSQL serialization failure at COMMIT (P2034). */
    failCommit?: (attempt: number) => boolean;
  } = {};

  user(organizationId: string, uid: string, role: string, active = true) { this.users.push({ organizationId, id: uid, role, active }); return this; }
  rev(r: Partial<Rev> & { id: string; revision: string; lifecycle: string }): Rev {
    const row: Rev = { organizationId: "orgA", itemId: "item-1", description: "legacy desc", createdById: "creator", sourceRevisionId: null, hold: true, ...r };
    this.revisions.push(row);
    return row;
  }
  link(revisionId: string, docId: string, organizationId = "orgA") {
    if (!this.docs.some((d) => d.id === docId)) this.docs.push({ organizationId, id: docId });
    this.links.push({ organizationId, itemRevisionId: revisionId, cadDocumentId: docId, createdById: "creator" });
    return this;
  }
  get db(): LegacyRevalidationDb {
    const self = this;
    const findReval = (where: { legacyRevisionId: string; organizationId: string }) => {
      const r = self.revalidations.find((x) => x.legacyRevisionId === where.legacyRevisionId && x.organizationId === where.organizationId);
      if (!r) return null;
      const s = self.revisions.find((x) => x.id === r.successorRevisionId)!;
      return { legacyRevisionId: r.legacyRevisionId, successorRevision: { id: s.id, revision: s.revision } };
    };
    return {
      // Phase 1G: the recovery read must run inside a (fresh) transaction
      // together with the actor re-check - a bare read outside it is a defect.
      itemRevisionLegacyRevalidation: { findFirst: (async () => { throw new Error("recovery read outside a transaction"); }) as unknown },
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        self.transactionAttempts += 1;
        const attempt = self.transactionAttempts;
        self.hooks.beforeTransaction?.(attempt);
        const undo: Array<() => void> = [];
        const push = <T>(arr: T[], row: T) => { arr.push(row); undo.push(() => { const i = arr.indexOf(row); if (i >= 0) arr.splice(i, 1); }); };
        const tx = {
          itemRevision: {
            findFirst: async (a: { where: { id: string; organizationId: string } }) => {
              await tick();
              const r = self.revisions.find((x) => x.id === a.where.id && x.organizationId === a.where.organizationId);
              if (!r) return null;
              const reval = findReval({ legacyRevisionId: r.id, organizationId: r.organizationId });
              return {
                id: r.id, itemId: r.itemId, revision: r.revision, lifecycle: r.lifecycle, description: r.description,
                legacyLifecycleHold: r.hold ? { itemRevisionId: r.id } : null,
                legacyRevalidationAsLegacy: reval ? { successorRevision: reval.successorRevision } : null,
                documentLinks: self.links.filter((l) => l.itemRevisionId === r.id && l.organizationId === r.organizationId).map((l) => ({ cadDocumentId: l.cadDocumentId })),
              };
            },
            findMany: async (a: { where: { itemId: string; organizationId: string } }) => {
              await tick();
              return self.revisions.filter((x) => x.itemId === a.where.itemId && x.organizationId === a.where.organizationId).map((x) => ({ revision: x.revision }));
            },
            updateMany: async (a: { where: { id: string; organizationId: string; lifecycle: string }; data: { lifecycle: string } }) => {
              await tick();
              const r = self.revisions.find((x) => x.id === a.where.id && x.organizationId === a.where.organizationId && x.lifecycle === a.where.lifecycle);
              if (!r) return { count: 0 };
              const prev = r.lifecycle; r.lifecycle = a.data.lifecycle; undo.push(() => { r.lifecycle = prev; });
              return { count: 1 };
            },
            create: async (a: { data: Omit<Rev, "id" | "hold"> }) => {
              await tick();
              self.hooks.beforeSuccessorCreate?.();
              if (self.revisions.some((x) => x.itemId === a.data.itemId && x.revision === a.data.revision)) throw p2002(["itemId", "revision"]);
              const row: Rev = { ...a.data, id: id("succ"), hold: false } as Rev;
              push(self.revisions, row);
              return { id: row.id, revision: row.revision };
            },
          },
          user: {
            findFirst: async (a: { where: { id: string; organizationId: string; active: boolean } }) => {
              await tick();
              const u = self.users.find((x) => x.id === a.where.id && x.organizationId === a.where.organizationId && x.active === a.where.active);
              return u ? { id: u.id, role: u.role } : null;
            },
          },
          cadDocument: {
            findMany: async (a: { where: { id: { in: string[] }; organizationId: string } }) => {
              await tick();
              return self.docs.filter((d) => a.where.id.in.includes(d.id) && d.organizationId === a.where.organizationId).map((d) => ({ id: d.id }));
            },
            create: async () => { self.cadDocumentCreates += 1; throw new Error("CadDocument must never be created by revalidation"); },
          },
          itemRevisionDocument: {
            createMany: async (a: { data: Link[] }) => {
              await tick();
              if (self.hooks.failLinks) throw new Error("injected link failure");
              for (const l of a.data) push(self.links, l);
              return { count: a.data.length };
            },
          },
          itemRevisionLifecycleEvent: {
            create: async (a: { data: Omit<Ev, "sequence"> }) => {
              await tick();
              push(self.events, { ...a.data, sequence: self.#seq++ });
              return {};
            },
          },
          itemRevisionLegacyRevalidation: {
            findFirst: async (a: { where: { legacyRevisionId: string; organizationId: string } }) => {
              await tick();
              return findReval(a.where);
            },
            create: async (a: { data: Omit<Reval, "sequence"> }) => {
              await tick();
              self.hooks.beforeAudit?.();
              if (self.hooks.failAudit) throw new Error("injected audit failure");
              if (self.revalidations.some((x) => x.legacyRevisionId === a.data.legacyRevisionId)) throw p2002(["legacyRevisionId"]);
              if (self.revalidations.some((x) => x.successorRevisionId === a.data.successorRevisionId)) throw p2002(["successorRevisionId"]);
              push(self.revalidations, { ...a.data, sequence: self.#seq++ });
              return {};
            },
          },
        };
        let result: unknown;
        try {
          result = await fn(tx);
        } catch (error) {
          for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
          throw error;
        }
        if (self.hooks.failCommit?.(attempt)) {
          for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
          throw serializationFailure();
        }
        return result;
      }) as unknown,
    } as unknown as LegacyRevalidationDb;
  }
  snapshot() {
    return JSON.stringify({
      revisions: this.revisions.map((r) => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id)),
      links: this.links.length, events: this.events.length, revalidations: this.revalidations.length,
    });
  }
}

function actor(userId: string, role = "ENGINEER"): Actor {
  return { userId, organizationId: "orgA", role: role as UserRole, name: userId, email: `${userId}@x.example` };
}
const REASON = "Pre-B03 work; re-review under B03";

async function expectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof LegacyRevalidationError, `expected LegacyRevalidationError, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

// ------------------------------------------------------------
// Success paths per legacy state
// ------------------------------------------------------------

for (const [state, closure] of [
  [S.WORKING, ["WORKING>OBSOLETE"]],
  [S.IN_REVIEW, ["IN_REVIEW>WORKING", "WORKING>OBSOLETE"]],
  [S.APPROVED, ["APPROVED>WORKING", "WORKING>OBSOLETE"]],
] as const) {
  test(`revalidates a held ${state} revision: closure events, successor (trusted creator, lineage, WORKING, no hold), links, one audit row`, async () => {
    const f = new FakeDb().user("orgA", "appr", "APPROVER");
    const legacy = f.rev({ id: "legacy", revision: "C", lifecycle: state, createdById: "creator" });
    f.rev({ id: "older", revision: "B", lifecycle: S.RELEASED });
    f.link("legacy", "d1").link("legacy", "d2");
    const before = { hold: legacy.hold, creator: legacy.createdById, desc: legacy.description, letter: legacy.revision, links: f.links.length };

    const result = await revalidateLegacyRevisionForActor(actor("appr", "APPROVER"), "legacy", { carryForward: "all", comment: `  ${REASON} ` }, f.db);

    assert.equal(result.status, "REVALIDATED");
    assert.equal(result.successorRevision, "D", "highest existing letter (C) + 1");
    assert.equal(legacy.lifecycle, S.OBSOLETE);
    assert.deepEqual(f.events.map((e) => `${e.fromState}>${e.toState}`), closure);
    assert.ok(f.events.every((e) => e.trigger === "LEGACY_REVALIDATION" && e.comment === REASON && e.actedById === "appr" && e.actedByRole === "APPROVER"));
    const succ = f.revisions.find((r) => r.id === result.successorRevisionId)!;
    assert.deepEqual(
      { lifecycle: succ.lifecycle, creator: succ.createdById, source: succ.sourceRevisionId, hold: succ.hold, item: succ.itemId, desc: succ.description },
      { lifecycle: S.WORKING, creator: "appr", source: "legacy", hold: false, item: "item-1", desc: "legacy desc" },
    );
    assert.deepEqual(f.links.filter((l) => l.itemRevisionId === succ.id).map((l) => l.cadDocumentId).sort(), ["d1", "d2"]);
    assert.equal(f.links.filter((l) => l.itemRevisionId === "legacy").length, before.links, "legacy links kept");
    assert.equal(f.cadDocumentCreates, 0, "no CadDocument created");
    assert.equal(f.revalidations.length, 1);
    assert.deepEqual(
      { ...f.revalidations[0]!, occurredAt: undefined, sequence: undefined },
      { organizationId: "orgA", legacyRevisionId: "legacy", successorRevisionId: succ.id, actedById: "appr", actedByRole: "APPROVER", comment: REASON, occurredAt: undefined, sequence: undefined },
    );
    assert.deepEqual({ hold: legacy.hold, creator: legacy.createdById, desc: legacy.description, letter: legacy.revision }, { hold: before.hold, creator: before.creator, desc: before.desc, letter: before.letter }, "legacy identity and hold untouched");
  });
}

test("description: given value overrides, blank falls back to the legacy description; letter gaps are not filled", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  f.rev({ id: "x", revision: "F", lifecycle: S.RELEASED });
  const r = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "none", description: "  new text ", comment: REASON }, f.db);
  assert.equal(r.successorRevision, "G");
  assert.equal(f.revisions.find((x) => x.id === r.successorRevisionId)!.description, "new text");
  const f2 = new FakeDb().user("orgA", "eng", "ENGINEER");
  f2.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  const r2 = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "none", description: "   ", comment: REASON }, f2.db);
  assert.equal(f2.revisions.find((x) => x.id === r2.successorRevisionId)!.description, "legacy desc");
});

test("carry-forward: selected links only the chosen documents; none links nothing; an unlinked selection is refused before any write", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  f.link("legacy", "d1").link("legacy", "d2");
  const r = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "selected", selectedCadDocumentIds: ["d2"], comment: REASON }, f.db);
  assert.deepEqual(f.links.filter((l) => l.itemRevisionId === r.successorRevisionId).map((l) => l.cadDocumentId), ["d2"]);

  const g = new FakeDb().user("orgA", "eng", "ENGINEER");
  g.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  g.link("legacy", "d1");
  g.docs.push({ organizationId: "orgA", id: "d9" });
  const before = g.snapshot();
  await expectCode(() => revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "selected", selectedCadDocumentIds: ["d9"], comment: REASON }, g.db), "CARRY_FORWARD_INVALID");
  assert.equal(g.snapshot(), before);
});

// ------------------------------------------------------------
// Refusals (nothing written)
// ------------------------------------------------------------

test("refusals write nothing: no hold, terminal state, other organization, inactive or VIEWER actor, APPROVED by non-approver", async () => {
  const cases: Array<[string, (f: FakeDb) => void, Actor, string]> = [
    ["not legacy", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.WORKING, hold: false }), actor("eng"), "NOT_LEGACY"],
    ["RELEASED", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.RELEASED }), actor("eng"), "NOT_ELIGIBLE_STATE"],
    ["SUPERSEDED", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.SUPERSEDED }), actor("eng"), "NOT_ELIGIBLE_STATE"],
    ["OBSOLETE", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.OBSOLETE }), actor("eng"), "NOT_ELIGIBLE_STATE"],
    ["other org", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.WORKING, organizationId: "orgB" }), actor("eng"), "NOT_FOUND"],
    ["inactive", (f) => { f.rev({ id: "r", revision: "A", lifecycle: S.WORKING }); f.users[0]!.active = false; }, actor("eng"), "ACTOR_NOT_ACTIVE"],
    ["VIEWER (role re-read)", (f) => { f.rev({ id: "r", revision: "A", lifecycle: S.WORKING }); f.users[0]!.role = "VIEWER"; }, actor("eng", "ENGINEER"), "ROLE_NOT_PERMITTED"],
    ["APPROVED by ENGINEER", (f) => f.rev({ id: "r", revision: "A", lifecycle: S.APPROVED }), actor("eng"), "ROLE_NOT_PERMITTED"],
    ["APPROVED by REVIEWER", (f) => { f.rev({ id: "r", revision: "A", lifecycle: S.APPROVED }); f.users[0]!.role = "REVIEWER"; }, actor("eng", "REVIEWER"), "ROLE_NOT_PERMITTED"],
    ["APPROVED by DESIGNER claiming APPROVER", (f) => { f.rev({ id: "r", revision: "A", lifecycle: S.APPROVED }); f.users[0]!.role = "DESIGNER"; }, actor("eng", "APPROVER"), "ROLE_NOT_PERMITTED"],
  ];
  for (const [label, setup, who, code] of cases) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    setup(f);
    const before = f.snapshot();
    await expectCode(() => revalidateLegacyRevisionForActor(who, "r", { carryForward: "all", comment: REASON }, f.db), code);
    assert.equal(f.snapshot(), before, label);
  }
});

test("O-5: missing, blank or control-only reason refused BEFORE the transaction; over-long reason refused", async () => {
  for (const comment of [undefined, null, "", "   ", "\u0007\u0000"]) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    f.rev({ id: "r", revision: "A", lifecycle: S.WORKING });
    await expectCode(() => revalidateLegacyRevisionForActor(actor("eng"), "r", { carryForward: "all", comment }, f.db), "REASON_REQUIRED");
    assert.equal(f.transactionAttempts, 0);
  }
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "r", revision: "A", lifecycle: S.WORKING });
  await assert.rejects(() => revalidateLegacyRevisionForActor(actor("eng"), "r", { carryForward: "all", comment: "x".repeat(501) }, f.db), InvalidLifecycleCommentError);
  assert.equal(f.transactionAttempts, 0);
});

test("Z exhaustion: refused before any write; the legacy revision stays held as it was", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "r", revision: "Y", lifecycle: S.IN_REVIEW });
  f.rev({ id: "z", revision: "Z", lifecycle: S.RELEASED });
  const before = f.snapshot();
  await expectCode(() => revalidateLegacyRevisionForActor(actor("eng"), "r", { carryForward: "all", comment: REASON }, f.db), "REVISION_LIMIT");
  assert.equal(f.snapshot(), before);
});

// ------------------------------------------------------------
// Atomic rollback
// ------------------------------------------------------------

for (const [label, arrange, expect] of [
  ["letter collision (another transaction takes the letter first)", (f: FakeDb) => { f.hooks.beforeSuccessorCreate = () => { if (!f.revisions.some((r) => r.revision === "B")) f.revisions.push({ organizationId: "orgA", id: "intruder", itemId: "item-1", revision: "B", lifecycle: S.WORKING, description: null, createdById: "other", sourceRevisionId: null, hold: false }); }; }, "REVISION_COLLISION"],
  ["link failure", (f: FakeDb) => { f.hooks.failLinks = true; }, /injected link failure/],
  ["audit insert failure", (f: FakeDb) => { f.hooks.failAudit = true; }, /injected audit failure/],
] as const) {
  test(`atomic rollback on ${label}: legacy state, events, successor, links and audit all unchanged`, async () => {
    const f = new FakeDb().user("orgA", "appr", "APPROVER");
    f.rev({ id: "legacy", revision: "A", lifecycle: S.APPROVED });
    f.link("legacy", "d1");
    arrange(f);
    const ignoreIntruder = () => JSON.stringify({ ...JSON.parse(f.snapshot()), revisions: JSON.parse(f.snapshot()).revisions.filter((r: Rev) => r.id !== "intruder") });
    const before = ignoreIntruder();
    if (typeof expect === "string") {
      await expectCode(() => revalidateLegacyRevisionForActor(actor("appr", "APPROVER"), "legacy", { carryForward: "all", comment: REASON }, f.db), expect);
    } else {
      await assert.rejects(() => revalidateLegacyRevisionForActor(actor("appr", "APPROVER"), "legacy", { carryForward: "all", comment: REASON }, f.db), expect);
    }
    const legacy = f.revisions.find((r) => r.id === "legacy")!;
    assert.equal(legacy.lifecycle, S.APPROVED, "closure rolled back");
    assert.equal(f.events.length, 0);
    assert.equal(f.revalidations.length, 0);
    assert.equal(f.revisions.filter((r) => r.sourceRevisionId === "legacy").length, 0, "no successor");
    assert.equal(ignoreIntruder(), before);
  });
}

// ------------------------------------------------------------
// Duplicates
// ------------------------------------------------------------

test("sequential duplicate: the second request returns ALREADY_REVALIDATED with the same successor and writes nothing", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.IN_REVIEW });
  const first = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "all", comment: REASON }, f.db);
  const before = f.snapshot();
  const second = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "all", comment: "again" }, f.db);
  assert.deepEqual(second, { ...first, status: "ALREADY_REVALIDATED" });
  assert.equal(f.snapshot(), before);
});

test("concurrent duplicates (5 rounds): exactly one successor and one audit row; the other request is refused or reports the existing successor", async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER").user("orgA", "eng2", "DESIGNER");
    f.rev({ id: "legacy", revision: "A", lifecycle: round % 2 ? S.WORKING : S.IN_REVIEW });
    const results = await Promise.allSettled([
      revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "all", comment: REASON }, f.db),
      revalidateLegacyRevisionForActor(actor("eng2", "DESIGNER"), "legacy", { carryForward: "all", comment: REASON }, f.db),
    ]);
    const done = results.filter((r) => r.status === "fulfilled" && r.value.status === "REVALIDATED");
    assert.equal(done.length, 1, `round ${round}`);
    for (const r of results) {
      if (r.status === "rejected") assert.ok(r.reason instanceof LegacyRevalidationError && r.reason.code === "CONCURRENT_CHANGE", String(r.reason));
    }
    assert.equal(f.revalidations.length, 1);
    assert.equal(f.revisions.filter((x) => x.sourceRevisionId === "legacy").length, 1);
    assert.equal(f.revisions.find((x) => x.id === "legacy")!.lifecycle, S.OBSOLETE);
  }
});

test("a concurrent revalidation that commits its audit row first: our unique violation maps to ALREADY_REVALIDATED and everything of ours rolls back", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  f.revisions.push({ organizationId: "orgA", id: "theirs", itemId: "item-1", revision: "Q", lifecycle: S.WORKING, description: null, createdById: "other", sourceRevisionId: "legacy", hold: false });
  f.hooks.beforeAudit = () => {
    if (!f.revalidations.length) f.revalidations.push({ organizationId: "orgA", legacyRevisionId: "legacy", successorRevisionId: "theirs", actedById: "other", actedByRole: "ENGINEER", comment: "theirs", occurredAt: new Date(), sequence: 999n });
  };
  const r = await revalidateLegacyRevisionForActor(actor("eng"), "legacy", { carryForward: "all", comment: REASON }, f.db);
  assert.deepEqual(r, { status: "ALREADY_REVALIDATED", legacyRevisionId: "legacy", successorRevisionId: "theirs", successorRevision: "Q" });
  assert.equal(f.revisions.find((x) => x.id === "legacy")!.lifecycle, S.WORKING, "our closure rolled back");
  assert.equal(f.events.length, 0);
  assert.equal(f.revisions.filter((x) => x.sourceRevisionId === "legacy").length, 1, "only theirs");
});

test("two different held revisions of the SAME item revalidated concurrently get distinct letters or one fails cleanly - never a duplicate letter or partial state", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "l1", revision: "A", lifecycle: S.WORKING });
  f.rev({ id: "l2", revision: "B", lifecycle: S.IN_REVIEW });
  const results = await Promise.allSettled([
    revalidateLegacyRevisionForActor(actor("eng"), "l1", { carryForward: "all", comment: REASON }, f.db),
    revalidateLegacyRevisionForActor(actor("eng"), "l2", { carryForward: "all", comment: REASON }, f.db),
  ]);
  const letters = f.revisions.filter((r) => r.itemId === "item-1").map((r) => r.revision);
  assert.equal(new Set(letters).size, letters.length, `duplicate letter: ${letters}`);
  for (const [i, r] of results.entries()) {
    const legacyId = i === 0 ? "l1" : "l2";
    const closed = f.revisions.find((x) => x.id === legacyId)!.lifecycle === S.OBSOLETE;
    const hasSucc = f.revalidations.some((x) => x.legacyRevisionId === legacyId);
    assert.equal(closed, hasSucc, `${legacyId}: closed iff it has a successor`);
    if (r.status === "rejected") assert.ok(r.reason instanceof LegacyRevalidationError && ["REVISION_COLLISION", "CONCURRENT_CHANGE"].includes(r.reason.code), String(r.reason));
  }
});

// ------------------------------------------------------------
// Phase 1G (WP-1G): authorization of BOTH ALREADY_REVALIDATED paths
// PD-G1 current active database user with a write role; PD-G2(a) existing
// codes/messages; PD-G3(b) CONCURRENT_CHANGE when recovery finds no row.
// ------------------------------------------------------------

const run = (f: FakeDb, who: Actor, legacyId = "legacy", comment: string = REASON) =>
  revalidateLegacyRevisionForActor(who, legacyId, { carryForward: "all", comment }, f.db);

/** A held legacy revision already revalidated (by `by`, whose DB role is `byRole`); returns the first result. */
async function alreadyRevalidated(f: FakeDb, lifecycle: string, by: string, byRole: string) {
  f.rev({ id: "legacy", revision: "A", lifecycle });
  const first = await run(f, actor(by, byRole));
  assert.equal(first.status, "REVALIDATED");
  assert.equal(f.revisions.find((r) => r.id === "legacy")!.lifecycle, S.OBSOLETE);
  return first;
}

/** Arrange Path B: another transaction commits its audit row (successor "theirs", letter Q) just before ours. */
function concurrentWinnerCommitsFirst(f: FakeDb, organizationId = "orgA") {
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  f.revisions.push({ organizationId, id: "theirs", itemId: "item-1", revision: "Q", lifecycle: S.WORKING, description: null, createdById: "other", sourceRevisionId: "legacy", hold: false });
  f.hooks.beforeAudit = () => {
    if (!f.revalidations.length) f.revalidations.push({ organizationId, legacyRevisionId: "legacy", successorRevisionId: "theirs", actedById: "other", actedByRole: "ENGINEER", comment: "theirs", occurredAt: new Date(), sequence: 999n });
  };
}

/** Path B state after our attempt rolled back: legacy still WORKING, none of our events/successor, only theirs. */
function assertOursRolledBack(f: FakeDb) {
  assert.equal(f.revisions.find((x) => x.id === "legacy")!.lifecycle, S.WORKING, "our closure rolled back");
  assert.equal(f.events.length, 0, "none of our events");
  assert.deepEqual(f.revisions.filter((x) => x.sourceRevisionId === "legacy").map((x) => x.id), ["theirs"], "only theirs");
  assert.equal(f.revalidations.length, 1, "only their audit row");
}

test("G1-01 authorized sequential duplicate: ALREADY_REVALIDATED with the same successor; writes nothing", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  const first = await alreadyRevalidated(f, S.IN_REVIEW, "eng", "ENGINEER");
  const before = f.snapshot();
  const attemptsBefore = f.transactionAttempts;
  const second = await run(f, actor("eng"), "legacy", "again");
  assert.deepEqual(second, { ...first, status: "ALREADY_REVALIDATED" });
  assert.equal(f.snapshot(), before);
  assert.equal(f.transactionAttempts - attemptsBefore, 1, "one transaction, no recovery");
});

test("G1-02 sequential duplicate by a deactivated actor: ACTOR_NOT_ACTIVE, successor not disclosed, nothing written", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  await alreadyRevalidated(f, S.WORKING, "eng", "ENGINEER");
  f.users.find((u) => u.id === "eng")!.active = false;
  const before = f.snapshot();
  await expectCode(() => run(f, actor("eng")), "ACTOR_NOT_ACTIVE");
  assert.equal(f.snapshot(), before);
});

test("G1-03 sequential duplicate by an actor demoted to VIEWER: ROLE_NOT_PERMITTED (existing message), nothing written", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  await alreadyRevalidated(f, S.WORKING, "eng", "ENGINEER");
  f.users.find((u) => u.id === "eng")!.role = "VIEWER";
  const before = f.snapshot();
  await assert.rejects(() => run(f, actor("eng", "ENGINEER")), (e: unknown) => {
    assert.ok(e instanceof LegacyRevalidationError);
    assert.equal(e.code, "ROLE_NOT_PERMITTED");
    assert.equal(e.message, LEGACY_REVALIDATION_MESSAGES.ROLE_NOT_PERMITTED, "PD-G2(a): wording unchanged");
    return true;
  });
  assert.equal(f.snapshot(), before);
});

test("G1-04 stale Actor.role never controls: claimed ADMIN with DB VIEWER is refused; claimed VIEWER with DB DESIGNER is served", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER").user("orgA", "des", "DESIGNER");
  const first = await alreadyRevalidated(f, S.WORKING, "eng", "ENGINEER");
  f.users.find((u) => u.id === "eng")!.role = "VIEWER";
  const before = f.snapshot();
  await expectCode(() => run(f, actor("eng", "ADMIN")), "ROLE_NOT_PERMITTED");
  const served = await run(f, actor("des", "VIEWER"));
  assert.deepEqual(served, { ...first, status: "ALREADY_REVALIDATED" });
  assert.equal(f.snapshot(), before);
});

test("G1-05 authorized concurrent duplicates (10 rounds): exactly one successor and one audit row; the other request reports it or is refused cleanly", async () => {
  for (let round = 0; round < 10; round += 1) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER").user("orgA", "eng2", "DESIGNER");
    f.rev({ id: "legacy", revision: "A", lifecycle: round % 2 ? S.WORKING : S.IN_REVIEW });
    const results = await Promise.allSettled([run(f, actor("eng")), run(f, actor("eng2", "DESIGNER"))]);
    const revalidated = results.filter((r) => r.status === "fulfilled" && r.value.status === "REVALIDATED");
    assert.equal(revalidated.length, 1, `round ${round}`);
    const winner = (revalidated[0] as PromiseFulfilledResult<{ successorRevisionId: string }>).value;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.status === "ALREADY_REVALIDATED") assert.equal(r.value.successorRevisionId, winner.successorRevisionId);
      if (r.status === "rejected") assert.ok(r.reason instanceof LegacyRevalidationError && r.reason.code === "CONCURRENT_CHANGE", String(r.reason));
    }
    assert.equal(f.revalidations.length, 1, "one audit row");
    assert.equal(f.revisions.filter((x) => x.sourceRevisionId === "legacy").length, 1, "one successor");
    assert.equal(f.revisions.find((x) => x.id === "legacy")!.lifecycle, S.OBSOLETE);
  }
});

test("G1-05b authorized Path B recovery: a fresh transaction re-checks the actor and reports the winner's successor", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  concurrentWinnerCommitsFirst(f);
  const r = await run(f, actor("eng"));
  assert.deepEqual(r, { status: "ALREADY_REVALIDATED", legacyRevisionId: "legacy", successorRevisionId: "theirs", successorRevision: "Q" });
  assert.equal(f.transactionAttempts, 2, "aborted attempt + one recovery transaction");
  assertOursRolledBack(f);
});

test("G1-06 actor deactivated before concurrent-duplicate recovery: ACTOR_NOT_ACTIVE, no successful result, ours rolled back", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  concurrentWinnerCommitsFirst(f);
  f.hooks.beforeTransaction = (attempt) => { if (attempt === 2) f.users.find((u) => u.id === "eng")!.active = false; };
  await expectCode(() => run(f, actor("eng")), "ACTOR_NOT_ACTIVE");
  assert.equal(f.transactionAttempts, 2);
  assertOursRolledBack(f);
});

test("G1-07 actor demoted to VIEWER before concurrent-duplicate recovery: ROLE_NOT_PERMITTED, no successful result, ours rolled back", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  concurrentWinnerCommitsFirst(f);
  f.hooks.beforeTransaction = (attempt) => { if (attempt === 2) f.users.find((u) => u.id === "eng")!.role = "VIEWER"; };
  await expectCode(() => run(f, actor("eng")), "ROLE_NOT_PERMITTED");
  assertOursRolledBack(f);
});

test("G1-08 cross-organization duplicate request: NOT_FOUND, the other organization's successor is not disclosed, nothing written", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER").user("orgB", "engB", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING, organizationId: "orgB" });
  const theirs = await run(f, { ...actor("engB"), organizationId: "orgB" });
  assert.equal(theirs.status, "REVALIDATED");
  const before = f.snapshot();
  await assert.rejects(() => run(f, actor("eng", "ADMIN")), (e: unknown) => {
    assert.ok(e instanceof LegacyRevalidationError);
    assert.equal(e.code, "NOT_FOUND");
    assert.ok(!e.message.includes(theirs.successorRevisionId), "successor id not disclosed");
    return true;
  });
  assert.equal(f.snapshot(), before);
});

test("G1-09 every authorization refusal on either path writes nothing (state, events, successors, links, audit unchanged)", async () => {
  const cases: Array<[string, (f: FakeDb) => Promise<void>, Actor, string]> = [
    ["Path A inactive", async (f) => { await alreadyRevalidated(f, S.IN_REVIEW, "eng", "ENGINEER"); f.users[0]!.active = false; }, actor("eng"), "ACTOR_NOT_ACTIVE"],
    ["Path A VIEWER", async (f) => { await alreadyRevalidated(f, S.IN_REVIEW, "eng", "ENGINEER"); f.users[0]!.role = "VIEWER"; }, actor("eng"), "ROLE_NOT_PERMITTED"],
    ["Path A user moved to another organization", async (f) => { await alreadyRevalidated(f, S.IN_REVIEW, "eng", "ENGINEER"); f.users[0]!.organizationId = "orgB"; }, actor("eng"), "ACTOR_NOT_ACTIVE"],
    ["Path A unknown user", async (f) => { await alreadyRevalidated(f, S.IN_REVIEW, "eng", "ENGINEER"); }, actor("ghost"), "ACTOR_NOT_ACTIVE"],
  ];
  for (const [label, arrange, who, code] of cases) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    await arrange(f);
    const before = f.snapshot();
    await expectCode(() => run(f, who), code);
    assert.equal(f.snapshot(), before, label);
  }
  for (const [label, change, code] of [
    ["Path B inactive", (f: FakeDb) => { f.users[0]!.active = false; }, "ACTOR_NOT_ACTIVE"],
    ["Path B VIEWER", (f: FakeDb) => { f.users[0]!.role = "VIEWER"; }, "ROLE_NOT_PERMITTED"],
  ] as const) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    concurrentWinnerCommitsFirst(f);
    f.hooks.beforeTransaction = (attempt) => { if (attempt === 2) change(f); };
    await expectCode(() => run(f, actor("eng")), code);
    assertOursRolledBack(f);
    assert.equal(f.links.length, 0, label);
  }
});

test("G1-10 authorized duplicate after the legacy revision became OBSOLETE: a DESIGNER retrieves the result of an APPROVED legacy revalidated by an APPROVER (eligibility not re-applied)", async () => {
  const f = new FakeDb().user("orgA", "appr", "APPROVER").user("orgA", "des", "DESIGNER");
  const first = await alreadyRevalidated(f, S.APPROVED, "appr", "APPROVER");
  const before = f.snapshot();
  const r = await run(f, actor("des", "DESIGNER"));
  assert.deepEqual(r, { ...first, status: "ALREADY_REVALIDATED" });
  assert.equal(f.snapshot(), before);
});

test("G1-10b creating a NEW revalidation keeps the stricter rule: a DESIGNER (even claiming APPROVER) cannot revalidate a held APPROVED revision", async () => {
  const f = new FakeDb().user("orgA", "des", "DESIGNER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.APPROVED });
  const before = f.snapshot();
  await expectCode(() => run(f, actor("des", "APPROVER")), "ROLE_NOT_PERMITTED");
  assert.equal(f.snapshot(), before);
});

test("G1-11 role change between transaction retries: the retry re-reads the actor and refuses (new revalidation and duplicate)", async () => {
  // New revalidation: attempt 1 writes everything, then fails at COMMIT (serialization); the actor is demoted before attempt 2.
  {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
    const before = f.snapshot();
    f.hooks.failCommit = (attempt) => attempt === 1;
    f.hooks.beforeTransaction = (attempt) => { if (attempt === 2) f.users[0]!.role = "VIEWER"; };
    await expectCode(() => run(f, actor("eng")), "ROLE_NOT_PERMITTED");
    assert.equal(f.transactionAttempts, 2);
    assert.equal(f.snapshot(), before, "attempt 1 rolled back, attempt 2 refused before any write");
  }
  // Duplicate: attempt 1 (read-only) fails at COMMIT; the actor is deactivated before attempt 2.
  {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    await alreadyRevalidated(f, S.WORKING, "eng", "ENGINEER");
    const base = f.transactionAttempts;
    const before = f.snapshot();
    f.hooks.failCommit = (attempt) => attempt === base + 1;
    f.hooks.beforeTransaction = (attempt) => { if (attempt === base + 2) f.users[0]!.active = false; };
    await expectCode(() => run(f, actor("eng")), "ACTOR_NOT_ACTIVE");
    assert.equal(f.transactionAttempts - base, 2);
    assert.equal(f.snapshot(), before);
  }
  // Control: an authorized actor whose first attempt fails at COMMIT succeeds on the retry with exactly one successor.
  {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
    f.hooks.failCommit = (attempt) => attempt === 1;
    const r = await run(f, actor("eng"));
    assert.equal(r.status, "REVALIDATED");
    assert.equal(f.revalidations.length, 1);
    assert.equal(f.revisions.filter((x) => x.sourceRevisionId === "legacy").length, 1);
  }
});

test("G1-12 recovery retries exhausted: CONCURRENT_CHANGE (never a raw Prisma error), bounded attempts, nothing of ours written", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  concurrentWinnerCommitsFirst(f);
  f.hooks.failCommit = (attempt) => attempt >= 2;
  await expectCode(() => run(f, actor("eng")), "CONCURRENT_CHANGE");
  assert.equal(f.transactionAttempts, 1 + 3, "aborted attempt + 3 bounded recovery attempts");
  assertOursRolledBack(f);
});

test("G1-13 unique violation on legacyRevisionId but no recovery row: CONCURRENT_CHANGE (PD-G3), not the raw P2002", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  const before = f.snapshot();
  f.hooks.beforeAudit = () => { throw p2002(["legacyRevisionId"]); };
  await expectCode(() => run(f, actor("eng")), "CONCURRENT_CHANGE");
  assert.equal(f.snapshot(), before, "everything of ours rolled back");
});

test("G1-13b an unrelated unique violation is unchanged: a successor-letter collision still maps to REVISION_COLLISION without recovery", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  f.hooks.beforeSuccessorCreate = () => { throw p2002(["itemId", "revision"]); };
  await expectCode(() => run(f, actor("eng")), "REVISION_COLLISION");
  assert.equal(f.transactionAttempts, 1, "no recovery transaction");
});

// Codex WP1G-L2: this fixture (an orgB audit row and successor pointing at an
// orgA legacy revision) is unreachable in PostgreSQL - the composite foreign
// keys (organizationId, legacyRevisionId) and (organizationId,
// successorRevisionId) reject it. The test only guards the organization
// filter of the recovery read (defence in depth).
test("G1-14 recovery stays organization-scoped: a conflicting row of another organization is never disclosed (CONCURRENT_CHANGE)", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  concurrentWinnerCommitsFirst(f, "orgB");
  await assert.rejects(() => run(f, actor("eng")), (e: unknown) => {
    assert.ok(e instanceof LegacyRevalidationError);
    assert.equal(e.code, "CONCURRENT_CHANGE");
    assert.ok(!e.message.includes("theirs"), "no foreign successor disclosed");
    return true;
  });
  assert.equal(f.revisions.find((x) => x.id === "legacy")!.lifecycle, S.WORKING, "our closure rolled back");
  assert.equal(f.events.length, 0);
});

// ------------------------------------------------------------
// FU-1G-1: Prisma may report a unique violation's target as the CONSTRAINT
// NAME (a string) instead of the field list. isUniqueViolationOn accepts both;
// these tests cover the string form.
// ------------------------------------------------------------

function p2002Named(constraint: string): Error {
  const e = new Error(`Unique constraint failed on the constraint: \`${constraint}\``);
  Object.assign(e, { code: "P2002", meta: { target: constraint } });
  return e;
}

test("FU-1G-1a string constraint name on legacyRevisionId takes the authorized recovery path (authorized -> ALREADY_REVALIDATED; VIEWER -> ROLE_NOT_PERMITTED)", async () => {
  for (const demote of [false, true]) {
    const f = new FakeDb().user("orgA", "eng", "ENGINEER");
    concurrentWinnerCommitsFirst(f);
    const pushTheirs = f.hooks.beforeAudit!;
    f.hooks.beforeAudit = () => { pushTheirs(); throw p2002Named("ItemRevisionLegacyRevalidation_legacyRevisionId_key"); };
    if (demote) f.hooks.beforeTransaction = (attempt) => { if (attempt === 2) f.users[0]!.role = "VIEWER"; };
    if (demote) {
      await expectCode(() => run(f, actor("eng")), "ROLE_NOT_PERMITTED");
    } else {
      const r = await run(f, actor("eng"));
      assert.deepEqual(r, { status: "ALREADY_REVALIDATED", legacyRevisionId: "legacy", successorRevisionId: "theirs", successorRevision: "Q" });
    }
    assert.equal(f.transactionAttempts, 2, "aborted attempt + one recovery transaction");
    assertOursRolledBack(f);
  }
});

test("FU-1G-1b string constraint name on the successor letter still maps to REVISION_COLLISION, without recovery", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  const before = f.snapshot();
  f.hooks.beforeSuccessorCreate = () => { throw p2002Named("ItemRevision_itemId_revision_key"); };
  await expectCode(() => run(f, actor("eng")), "REVISION_COLLISION");
  assert.equal(f.transactionAttempts, 1, "no recovery transaction");
  assert.equal(f.snapshot(), before, "everything of ours rolled back");
});

test("FU-1G-1c a string constraint name of an unrelated unique index matches neither case: the original error propagates, no recovery, nothing written", async () => {
  const f = new FakeDb().user("orgA", "eng", "ENGINEER");
  f.rev({ id: "legacy", revision: "A", lifecycle: S.WORKING });
  const before = f.snapshot();
  const unrelated = p2002Named("ItemRevisionLegacyRevalidation_successorRevisionId_key");
  f.hooks.beforeAudit = () => { throw unrelated; };
  await assert.rejects(() => run(f, actor("eng")), (e: unknown) => {
    assert.equal(e, unrelated, "the original error, not a LegacyRevalidationError");
    return true;
  });
  assert.equal(f.transactionAttempts, 1, "no recovery transaction");
  assert.equal(f.snapshot(), before, "everything of ours rolled back");
});
