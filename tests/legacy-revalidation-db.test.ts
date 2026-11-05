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
  hooks: { beforeSuccessorCreate?: () => void; beforeAudit?: () => void; failLinks?: boolean; failAudit?: boolean } = {};

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
      itemRevisionLegacyRevalidation: { findFirst: (async (a: { where: { legacyRevisionId: string; organizationId: string } }) => findReval(a.where)) as unknown },
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        self.transactionAttempts += 1;
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
        try {
          return await fn(tx);
        } catch (error) {
          for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
          throw error;
        }
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
