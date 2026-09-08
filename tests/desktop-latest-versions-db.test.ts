/**
 * Focused tests for the P5B-B authoritative latest-version lookup
 * (`app/lib/desktop-latest-versions-db.ts` + `-core.ts`). In-memory fake DB -
 * no Postgres, no network, no Inventor.
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-latest-versions-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import {
  DesktopLatestVersionError,
  desktopLatestVersionsHttpResult,
  latestVersionsForActor,
  type DesktopLatestVersionDb,
} from "../app/lib/desktop-latest-versions-db.ts";
import {
  DESKTOP_LATEST_VERSIONS_CONTRACT,
  MAX_LATEST_VERSION_IDS,
  MAX_LATEST_VERSION_ID_LENGTH,
  parseLatestVersionIds,
  type LatestVersionResultDto,
} from "../app/lib/desktop-latest-versions-core.ts";

interface DocRow {
  organizationId: string;
  id: string;
}
interface FvRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
}

/** Records every write-shaped call so tests can prove READ-ONLY. */
const writeCalls: string[] = [];

class FakeDb {
  readonly docs: DocRow[] = [];
  readonly fvs: FvRow[] = [];

  doc(organizationId: string, id: string): this {
    this.docs.push({ organizationId, id });
    return this;
  }
  fv(organizationId: string, cadDocumentId: string, id: string, versionNumber: number): this {
    this.fvs.push({ organizationId, cadDocumentId, id, versionNumber });
    return this;
  }

  get db(): DesktopLatestVersionDb {
    const self = this;
    const forbidWrite = (name: string) =>
      ((..._args: unknown[]) => {
        writeCalls.push(name);
        throw new Error(`unexpected write: ${name}`);
      }) as unknown as never;

    const cadDocument = {
      findMany: (async (args: {
        where: { organizationId: string; id: { in: string[] } };
        select: unknown;
      }) => {
        const ids = new Set(args.where.id.in);
        return self.docs
          .filter((d) => d.organizationId === args.where.organizationId && ids.has(d.id))
          .map((d) => ({ id: d.id }));
      }) as unknown as DesktopLatestVersionDb["cadDocument"]["findMany"],
      create: forbidWrite("cadDocument.create"),
      update: forbidWrite("cadDocument.update"),
      updateMany: forbidWrite("cadDocument.updateMany"),
      delete: forbidWrite("cadDocument.delete"),
      deleteMany: forbidWrite("cadDocument.deleteMany"),
      upsert: forbidWrite("cadDocument.upsert"),
    } as unknown as DesktopLatestVersionDb["cadDocument"];

    const fileVersion = {
      findMany: (async (args: {
        where: { organizationId: string; cadDocumentId: { in: string[] } };
        orderBy: Array<Record<string, "asc" | "desc">>;
        distinct?: string[];
        select: unknown;
      }) => {
        const ids = new Set(args.where.cadDocumentId.in);
        let rows = self.fvs.filter(
          (f) => f.organizationId === args.where.organizationId && ids.has(f.cadDocumentId),
        );
        // apply the (cadDocumentId asc, versionNumber desc) order
        rows = rows.slice().sort((a, b) => {
          if (a.cadDocumentId !== b.cadDocumentId) {
            return a.cadDocumentId < b.cadDocumentId ? -1 : 1;
          }
          return b.versionNumber - a.versionNumber;
        });
        // distinct: ['cadDocumentId'] -> first row per cadDocumentId
        if (args.distinct?.includes("cadDocumentId")) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.cadDocumentId) ? false : (seen.add(r.cadDocumentId), true)));
        }
        return rows.map((r) => ({
          cadDocumentId: r.cadDocumentId,
          id: r.id,
          versionNumber: r.versionNumber,
        }));
      }) as unknown as DesktopLatestVersionDb["fileVersion"]["findMany"],
      create: forbidWrite("fileVersion.create"),
      update: forbidWrite("fileVersion.update"),
      updateMany: forbidWrite("fileVersion.updateMany"),
      delete: forbidWrite("fileVersion.delete"),
      deleteMany: forbidWrite("fileVersion.deleteMany"),
      upsert: forbidWrite("fileVersion.upsert"),
    } as unknown as DesktopLatestVersionDb["fileVersion"];

    return { cadDocument, fileVersion } as unknown as DesktopLatestVersionDb;
  }
}

function actorIn(organizationId: string, role: UserRole = UserRole.ENGINEER): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role,
    name: "Test User",
    email: `user@${organizationId}.example`,
  };
}

function query(...ids: string[]): URLSearchParams {
  const p = new URLSearchParams();
  for (const id of ids) p.append("cadDocumentId", id);
  return p;
}

function resultFor(results: LatestVersionResultDto[], id: string): LatestVersionResultDto {
  const r = results.find((x) => x.cadDocumentId === id);
  assert.ok(r, `no result for ${id}`);
  return r;
}

// ------------------------------------------------------------
// parseLatestVersionIds
// ------------------------------------------------------------

test("parseLatestVersionIds: verbatim ids, exact-ordinal dedup, order preserved", () => {
  assert.deepEqual(parseLatestVersionIds(query("cad_a", "cad_b", "cad_a")), ["cad_a", "cad_b"]);
});

test("parseLatestVersionIds: at least one id is required (400)", () => {
  assert.throws(
    () => parseLatestVersionIds(new URLSearchParams()),
    (e: unknown) => e instanceof DesktopLatestVersionError && e.status === 400,
  );
});

test("parseLatestVersionIds: blank identifier -> 400", () => {
  for (const bad of [query(""), query("   "), query("cad_a", "")]) {
    assert.throws(
      () => parseLatestVersionIds(bad),
      (e: unknown) => e instanceof DesktopLatestVersionError && e.status === 400,
    );
  }
});

test("parseLatestVersionIds: whitespace-padded identifier -> 400, never normalised", () => {
  for (const padded of [" cad_a", "cad_a ", "\tcad_a\t"]) {
    assert.throws(
      () => parseLatestVersionIds(query(padded)),
      (e: unknown) => {
        assert.ok(e instanceof DesktopLatestVersionError);
        assert.equal(e.status, 400);
        assert.ok(!e.message.includes(padded.trim()));
        return true;
      },
    );
  }
});

test("parseLatestVersionIds: excessive batch -> 400", () => {
  const many = Array.from({ length: MAX_LATEST_VERSION_IDS + 1 }, (_v, i) => `cad_${i}`);
  assert.throws(
    () => parseLatestVersionIds(query(...many)),
    (e: unknown) => e instanceof DesktopLatestVersionError && e.status === 400,
  );
  // exactly at the cap is fine
  const atCap = Array.from({ length: MAX_LATEST_VERSION_IDS }, (_v, i) => `cad_${i}`);
  assert.equal(parseLatestVersionIds(query(...atCap)).length, MAX_LATEST_VERSION_IDS);
});

test("parseLatestVersionIds: over-length identifier -> 400, not echoed", () => {
  const huge = "x".repeat(MAX_LATEST_VERSION_ID_LENGTH + 1);
  assert.throws(
    () => parseLatestVersionIds(query(huge)),
    (e: unknown) => {
      assert.ok(e instanceof DesktopLatestVersionError);
      assert.equal(e.status, 400);
      assert.ok(!e.message.includes(huge));
      return true;
    },
  );
});

// ------------------------------------------------------------
// latestVersionsForActor
// ------------------------------------------------------------

test("same-tenant document with one FileVersion -> recognized:true + exact id/number", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 1);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  assert.equal(dto.contract, DESKTOP_LATEST_VERSIONS_CONTRACT);
  assert.deepEqual(dto.results, [
    { cadDocumentId: "cad_1", recognized: true, latestFileVersionId: "fv_1", latestVersionNumber: 1 },
  ]);
});

test("multiple FileVersions -> the greatest versionNumber is authoritative (not insertion order)", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_v2", 2)
    .fv("orgA", "cad_1", "fv_v5", 5)
    .fv("orgA", "cad_1", "fv_v3", 3);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  assert.deepEqual(resultFor(dto.results, "cad_1"), {
    cadDocumentId: "cad_1",
    recognized: true,
    latestFileVersionId: "fv_v5",
    latestVersionNumber: 5,
  });
});

test("multiple cadDocumentIds in one request -> correct authoritative result per exact id", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_a")
    .doc("orgA", "cad_b")
    .fv("orgA", "cad_a", "fv_a2", 2)
    .fv("orgA", "cad_a", "fv_a1", 1)
    .fv("orgA", "cad_b", "fv_b7", 7);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_b", "cad_a"], fake.db);

  // order preserved
  assert.deepEqual(dto.results.map((r) => r.cadDocumentId), ["cad_b", "cad_a"]);
  assert.deepEqual(resultFor(dto.results, "cad_a"), {
    cadDocumentId: "cad_a", recognized: true, latestFileVersionId: "fv_a2", latestVersionNumber: 2,
  });
  assert.deepEqual(resultFor(dto.results, "cad_b"), {
    cadDocumentId: "cad_b", recognized: true, latestFileVersionId: "fv_b7", latestVersionNumber: 7,
  });
});

test("unknown id -> recognized:false", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 1);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_missing"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_missing", recognized: false }]);
});

test("recognised document with NO FileVersion -> recognized:false (no authoritative latest)", async () => {
  const fake = new FakeDb().doc("orgA", "cad_empty");

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_empty"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_empty", recognized: false }]);
});

test("document belonging to another organization -> recognized:false, no metadata leak", async () => {
  const fake = new FakeDb().doc("orgB", "cad_secret").fv("orgB", "cad_secret", "fv_secret", 9);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_secret"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_secret", recognized: false }]);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("fv_secret"));
  assert.ok(!json.includes('"recognized":true'));
});

test("mixed same-tenant + foreign + unknown -> deterministic independent results", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_mine")
    .fv("orgA", "cad_mine", "fv_mine_1", 1)
    .fv("orgA", "cad_mine", "fv_mine_2", 2)
    .doc("orgB", "cad_theirs")
    .fv("orgB", "cad_theirs", "fv_theirs", 4);

  const dto = await latestVersionsForActor(
    actorIn("orgA"),
    ["cad_mine", "cad_theirs", "cad_unknown"],
    fake.db,
  );

  assert.deepEqual(dto.results, [
    { cadDocumentId: "cad_mine", recognized: true, latestFileVersionId: "fv_mine_2", latestVersionNumber: 2 },
    { cadDocumentId: "cad_theirs", recognized: false },
    { cadDocumentId: "cad_unknown", recognized: false },
  ]);
});

test("exact stable ids are returned VERBATIM (no trim / case change)", async () => {
  const weird = "cad_A-b.c_1";
  const fake = new FakeDb().doc("orgA", weird).fv("orgA", weird, "FV_Weird.Id", 3);

  const dto = await latestVersionsForActor(actorIn("orgA"), [weird], fake.db);

  assert.deepEqual(dto.results, [
    { cadDocumentId: weird, recognized: true, latestFileVersionId: "FV_Weird.Id", latestVersionNumber: 3 },
  ]);
});

test("lookup performs NO mutation (only findMany is ever called)", async () => {
  writeCalls.length = 0;
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_1", 1)
    .doc("orgA", "cad_2");

  await latestVersionsForActor(actorIn("orgA"), ["cad_1", "cad_2", "cad_x"], fake.db);

  assert.deepEqual(writeCalls, []);
});

// ------------------------------------------------------------
// desktopLatestVersionsHttpResult
// ------------------------------------------------------------

test("http: no actor -> 401, does not touch the database", async () => {
  const fake = new FakeDb();
  const res = await desktopLatestVersionsHttpResult(null, query("cad_1"), fake.db);
  assert.equal(res.status, 401);
});

test("http: VIEWER can look up latest versions (read is not gated on write roles)", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 4);

  const res = await desktopLatestVersionsHttpResult(
    actorIn("orgA", UserRole.VIEWER),
    query("cad_1"),
    fake.db,
  );

  assert.equal(res.status, 200);
  const body = res.body as { contract: string; results: LatestVersionResultDto[] };
  assert.equal(body.contract, DESKTOP_LATEST_VERSIONS_CONTRACT);
  assert.deepEqual(body.results, [
    { cadDocumentId: "cad_1", recognized: true, latestFileVersionId: "fv_1", latestVersionNumber: 4 },
  ]);
});

test("http: blank / padded / empty / oversized query -> 400", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1");
  const actor = actorIn("orgA");

  assert.equal((await desktopLatestVersionsHttpResult(actor, new URLSearchParams(), fake.db)).status, 400);
  assert.equal((await desktopLatestVersionsHttpResult(actor, query("   "), fake.db)).status, 400);
  assert.equal((await desktopLatestVersionsHttpResult(actor, query(" cad_1 "), fake.db)).status, 400);
  const many = Array.from({ length: MAX_LATEST_VERSION_IDS + 1 }, (_v, i) => `cad_${i}`);
  assert.equal((await desktopLatestVersionsHttpResult(actor, query(...many), fake.db)).status, 400);
});

test("http: contract response shape matches the CAD Connect client contract", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_a")
    .fv("orgA", "cad_a", "fv_a", 7)
    .doc("orgA", "cad_b"); // recognised, no FileVersion

  const res = await desktopLatestVersionsHttpResult(actorIn("orgA"), query("cad_a", "cad_b", "cad_c"), fake.db);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    contract: "arch-plm.desktop-latest-versions.v1",
    results: [
      { cadDocumentId: "cad_a", recognized: true, latestFileVersionId: "fv_a", latestVersionNumber: 7 },
      { cadDocumentId: "cad_b", recognized: false },
      { cadDocumentId: "cad_c", recognized: false },
    ],
  });
  // every entry has an explicit boolean `recognized`
  for (const r of (res.body as { results: LatestVersionResultDto[] }).results) {
    assert.equal(typeof r.recognized, "boolean");
  }
});
