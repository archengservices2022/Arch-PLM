/**
 * Focused tests for the P5B-B / P5C-B authoritative latest-version lookup
 * (`app/lib/desktop-latest-versions-db.ts` + `-core.ts`). In-memory fake DB -
 * no Postgres, no network, no Inventor.
 *
 * P5C-B extends the recognised result with the selected latest FileVersion's
 * canonical immutable integrity metadata and fails closed to
 * `recognized: false` when it is missing / non-canonical / out of safe range:
 *   - `checksum` must match `/^[0-9a-f]{64}$/` exactly (lowercase-hex SHA-256);
 *   - `fileSize` must be a non-negative safe integer (raw BIGINT range-checked
 *     before any Number() conversion).
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-latest-versions-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
  isCanonicalSha256,
  MAX_LATEST_VERSION_IDS,
  MAX_LATEST_VERSION_ID_LENGTH,
  parseLatestVersionIds,
  toSafeFileSize,
  type LatestVersionResultDto,
} from "../app/lib/desktop-latest-versions-core.ts";

/** A real, deterministic canonical checksum (64-char lowercase hex). */
const sha = (seed: string): string => createHash("sha256").update(seed).digest("hex");

const HEX64_A = "a".repeat(64);
const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991
const PG_BIGINT_MAX = 9223372036854775807n;

interface DocRow {
  organizationId: string;
  id: string;
}
interface FvRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  fileSize: number | bigint | null;
  checksum: string | null;
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
  /**
   * Add a FileVersion. `fileSize` / `checksum` default to a valid canonical
   * pair keyed off the id so recognised results are deterministic; pass `null`
   * / a non-canonical checksum / an out-of-range size to exercise fail-closed.
   */
  fv(
    organizationId: string,
    cadDocumentId: string,
    id: string,
    versionNumber: number,
    fileSize: number | bigint | null = 1024 + versionNumber,
    checksum: string | null = sha(id),
  ): this {
    this.fvs.push({ organizationId, cadDocumentId, id, versionNumber, fileSize, checksum });
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
          // Prisma returns `bigint | null` for a PostgreSQL BIGINT column;
          // mimic that exactly so `toSafeFileSize`'s raw-bigint range check is
          // under test (never a pre-rounded number).
          fileSize: r.fileSize == null ? null : BigInt(r.fileSize),
          checksum: r.checksum,
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
// isCanonicalSha256 (P5C-B finding 1)
// ------------------------------------------------------------

test("isCanonicalSha256: exactly 64 lowercase hex chars -> true", () => {
  assert.equal(isCanonicalSha256(HEX64_A), true);
  assert.equal(isCanonicalSha256(sha("anything")), true);
  assert.equal(isCanonicalSha256("0123456789abcdef".repeat(4)), true);
});

test("isCanonicalSha256: null / undefined / empty / whitespace-only -> false", () => {
  assert.equal(isCanonicalSha256(null), false);
  assert.equal(isCanonicalSha256(undefined), false);
  assert.equal(isCanonicalSha256(""), false);
  assert.equal(isCanonicalSha256("   "), false);
  assert.equal(isCanonicalSha256("\t\n"), false);
});

test("isCanonicalSha256: leading/trailing/internal whitespace -> false (never trimmed)", () => {
  assert.equal(isCanonicalSha256(" " + HEX64_A), false);
  assert.equal(isCanonicalSha256(HEX64_A + " "), false);
  assert.equal(isCanonicalSha256(HEX64_A + "\n"), false); // regex `$` must not save it
  assert.equal(isCanonicalSha256(HEX64_A.slice(0, 32) + " " + HEX64_A.slice(33)), false);
});

test("isCanonicalSha256: wrong length -> false", () => {
  assert.equal(isCanonicalSha256("a".repeat(63)), false);
  assert.equal(isCanonicalSha256("a".repeat(65)), false);
  assert.equal(isCanonicalSha256("a".repeat(40)), false); // SHA-1 length
});

test("isCanonicalSha256: sha256: prefix -> false", () => {
  assert.equal(isCanonicalSha256("sha256:" + HEX64_A.slice(7)), false);
  assert.equal(isCanonicalSha256("sha256:" + HEX64_A), false);
});

test("isCanonicalSha256: non-hex characters -> false", () => {
  assert.equal(isCanonicalSha256("g".repeat(64)), false);
  assert.equal(isCanonicalSha256(HEX64_A.slice(0, 63) + "z"), false);
  assert.equal(isCanonicalSha256(HEX64_A.slice(0, 63) + "-"), false);
});

test("isCanonicalSha256: uppercase A-F -> false (not normalised to lowercase)", () => {
  assert.equal(isCanonicalSha256("A".repeat(64)), false);
  assert.equal(isCanonicalSha256(HEX64_A.slice(0, 63) + "A"), false);
  assert.equal(isCanonicalSha256(sha("x").toUpperCase()), false);
});

// ------------------------------------------------------------
// toSafeFileSize (P5C-B finding 2)
// ------------------------------------------------------------

test("toSafeFileSize: 0n -> 0", () => {
  assert.equal(toSafeFileSize(0n), 0);
});

test("toSafeFileSize: BigInt(MAX_SAFE_INTEGER) -> that exact number", () => {
  assert.equal(toSafeFileSize(BigInt(MAX_SAFE)), MAX_SAFE);
  assert.equal(Number.isSafeInteger(toSafeFileSize(BigInt(MAX_SAFE)) as number), true);
});

test("toSafeFileSize: MAX_SAFE_INTEGER + 1 -> null (no silent rounding)", () => {
  assert.equal(toSafeFileSize(BigInt(MAX_SAFE) + 1n), null);
});

test("toSafeFileSize: PostgreSQL signed BIGINT max -> null", () => {
  assert.equal(toSafeFileSize(PG_BIGINT_MAX), null);
});

test("toSafeFileSize: negative -> null", () => {
  assert.equal(toSafeFileSize(-1n), null);
  assert.equal(toSafeFileSize(-PG_BIGINT_MAX), null);
});

test("toSafeFileSize: null / undefined / non-bigint -> null", () => {
  assert.equal(toSafeFileSize(null), null);
  assert.equal(toSafeFileSize(undefined), null);
  assert.equal(toSafeFileSize(123 as unknown as bigint), null);
});

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

test("same-tenant document with one FileVersion -> recognized:true + exact id/number + integrity metadata", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 1, 4096, HEX64_A);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  assert.equal(dto.contract, DESKTOP_LATEST_VERSIONS_CONTRACT);
  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_1",
      recognized: true,
      latestFileVersionId: "fv_1",
      latestVersionNumber: 1,
      fileSize: 4096,
      checksum: HEX64_A,
    },
  ]);
});

test("recognized latest version returns the canonical fileSize AND checksum of the SELECTED latest row", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_v2", 2, 200, sha("v2"))
    .fv("orgA", "cad_1", "fv_v5", 5, 500, sha("v5"))
    .fv("orgA", "cad_1", "fv_v3", 3, 300, sha("v3"));

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  // greatest versionNumber wins - and its OWN size/checksum, not an older row's
  assert.deepEqual(resultFor(dto.results, "cad_1"), {
    cadDocumentId: "cad_1",
    recognized: true,
    latestFileVersionId: "fv_v5",
    latestVersionNumber: 5,
    fileSize: 500,
    checksum: sha("v5"),
  });
});

test("older FileVersion integrity metadata is never returned when a newer version exists", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_old", 1, 111, sha("old"))
    .fv("orgA", "cad_1", "fv_new", 2, 222, sha("new"));

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  const json = JSON.stringify(dto);
  assert.ok(!json.includes("fv_old"));
  assert.ok(!json.includes(sha("old")));
  assert.ok(!json.includes("111"));
  assert.deepEqual(resultFor(dto.results, "cad_1"), {
    cadDocumentId: "cad_1",
    recognized: true,
    latestFileVersionId: "fv_new",
    latestVersionNumber: 2,
    fileSize: 222,
    checksum: sha("new"),
  });
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
    fileSize: 1029,
    checksum: sha("fv_v5"),
  });
});

test("multiple cadDocumentIds in one request -> correct authoritative result per exact id", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_a")
    .doc("orgA", "cad_b")
    .fv("orgA", "cad_a", "fv_a2", 2, 20, sha("a2"))
    .fv("orgA", "cad_a", "fv_a1", 1, 10, sha("a1"))
    .fv("orgA", "cad_b", "fv_b7", 7, 70, sha("b7"));

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_b", "cad_a"], fake.db);

  // order preserved
  assert.deepEqual(dto.results.map((r) => r.cadDocumentId), ["cad_b", "cad_a"]);
  assert.deepEqual(resultFor(dto.results, "cad_a"), {
    cadDocumentId: "cad_a", recognized: true, latestFileVersionId: "fv_a2", latestVersionNumber: 2,
    fileSize: 20, checksum: sha("a2"),
  });
  assert.deepEqual(resultFor(dto.results, "cad_b"), {
    cadDocumentId: "cad_b", recognized: true, latestFileVersionId: "fv_b7", latestVersionNumber: 7,
    fileSize: 70, checksum: sha("b7"),
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

test("unknown/unrecognised document cannot fabricate integrity metadata", async () => {
  const fake = new FakeDb();

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_nope"], fake.db);

  const only = dto.results[0];
  assert.deepEqual(only, { cadDocumentId: "cad_nope", recognized: false });
  assert.ok(!("fileSize" in only));
  assert.ok(!("checksum" in only));
});

// ---- checksum fail-closed (finding 1) ----

test("latest FileVersion checksum: NULL -> fail closed recognized:false", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, null);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
});

test("latest FileVersion checksum: empty / whitespace-only -> fail closed", async () => {
  for (const bad of ["", "   ", "\t"]) {
    const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, bad);
    const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
    assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }], `checksum=${JSON.stringify(bad)}`);
  }
});

test("latest FileVersion checksum: leading/trailing whitespace -> fail closed, NOT trimmed into validity", async () => {
  for (const padded of [" " + HEX64_A, HEX64_A + " ", "\t" + HEX64_A + "\n"]) {
    const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, padded);
    const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
    assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
  }
});

test("latest FileVersion checksum: wrong length (63 / 65) -> fail closed", async () => {
  for (const bad of ["a".repeat(63), "a".repeat(65)]) {
    const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, bad);
    const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
    assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
  }
});

test("latest FileVersion checksum: sha256: prefix -> fail closed", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, "sha256:" + HEX64_A.slice(7));
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
});

test("latest FileVersion checksum: non-hex characters -> fail closed", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, "z".repeat(64));
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
});

test("latest FileVersion checksum: uppercase hex -> fail closed (not lowercased)", async () => {
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, sha("x").toUpperCase());
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
});

test("latest FileVersion checksum: exactly 64 lowercase hex -> recognized:true, returned verbatim", async () => {
  const canonical = sha("a-real-digest-seed");
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 3, 500, canonical);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);
  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_1", recognized: true, latestFileVersionId: "fv_1", latestVersionNumber: 3,
      fileSize: 500, checksum: canonical,
    },
  ]);
});

// ---- fileSize fail-closed (finding 2) ----

test("latest FileVersion fileSize: 0 -> recognized:true", async () => {
  const fake = new FakeDb().doc("orgA", "cad_0").fv("orgA", "cad_0", "fv_0", 1, 0n, HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_0"], fake.db);
  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_0", recognized: true, latestFileVersionId: "fv_0", latestVersionNumber: 1,
      fileSize: 0, checksum: HEX64_A,
    },
  ]);
});

test("latest FileVersion fileSize: Number.MAX_SAFE_INTEGER -> recognized:true", async () => {
  const fake = new FakeDb().doc("orgA", "cad_m").fv("orgA", "cad_m", "fv_m", 1, BigInt(MAX_SAFE), HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_m"], fake.db);
  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_m", recognized: true, latestFileVersionId: "fv_m", latestVersionNumber: 1,
      fileSize: MAX_SAFE, checksum: HEX64_A,
    },
  ]);
});

test("latest FileVersion fileSize: MAX_SAFE_INTEGER + 1 -> fail closed (no silent rounding)", async () => {
  const fake = new FakeDb().doc("orgA", "cad_x").fv("orgA", "cad_x", "fv_x", 1, BigInt(MAX_SAFE) + 1n, HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_x"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_x", recognized: false }]);
});

test("latest FileVersion fileSize: PostgreSQL signed BIGINT max -> fail closed", async () => {
  const fake = new FakeDb().doc("orgA", "cad_b").fv("orgA", "cad_b", "fv_b", 1, PG_BIGINT_MAX, HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_b"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_b", recognized: false }]);
});

test("latest FileVersion fileSize: negative -> fail closed", async () => {
  const fake = new FakeDb().doc("orgA", "cad_n").fv("orgA", "cad_n", "fv_n", 1, -1n, HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_n"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_n", recognized: false }]);
});

test("latest FileVersion fileSize: NULL -> fail closed", async () => {
  const fake = new FakeDb().doc("orgA", "cad_z").fv("orgA", "cad_z", "fv_z", 1, null, HEX64_A);
  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_z"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_z", recognized: false }]);
});

test("newest version has an out-of-range fileSize -> fail closed, NO fallback to an older valid version", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_good", 1, 100, sha("good"))
    .fv("orgA", "cad_1", "fv_huge", 2, PG_BIGINT_MAX, HEX64_A);

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("fv_good"), "must not fall back to the older valid version");
  assert.ok(!json.includes(sha("good")));
});

test("newest version has a non-canonical checksum -> fail closed, NO fallback to an older valid version", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_1")
    .fv("orgA", "cad_1", "fv_good", 1, 100, sha("good"))
    .fv("orgA", "cad_1", "fv_bad", 2, 200, "sha256:deadbeef");

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_1"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_1", recognized: false }]);
  assert.ok(!JSON.stringify(dto).includes("fv_good"));
});

test("document belonging to another organization -> recognized:false, no metadata leak", async () => {
  const fake = new FakeDb().doc("orgB", "cad_secret").fv("orgB", "cad_secret", "fv_secret", 9, 999, sha("secret"));

  const dto = await latestVersionsForActor(actorIn("orgA"), ["cad_secret"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_secret", recognized: false }]);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("fv_secret"));
  assert.ok(!json.includes(sha("secret")));
  assert.ok(!json.includes("999"));
  assert.ok(!json.includes('"recognized":true'));
});

test("same cadDocumentId value in a DIFFERENT tenant does not leak that tenant's integrity metadata", async () => {
  const shared = "cad_shared";
  const fake = new FakeDb()
    .doc("orgA", shared)
    .fv("orgA", shared, "fv_A", 2, 22, sha("A"))
    .doc("orgB", shared)
    .fv("orgB", shared, "fv_B", 9, 99, sha("B"));

  const dto = await latestVersionsForActor(actorIn("orgA"), [shared], fake.db);

  assert.deepEqual(resultFor(dto.results, shared), {
    cadDocumentId: shared, recognized: true, latestFileVersionId: "fv_A", latestVersionNumber: 2,
    fileSize: 22, checksum: sha("A"),
  });
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("fv_B"));
  assert.ok(!json.includes(sha("B")));
});

test("mixed same-tenant + foreign + unknown -> deterministic independent results", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_mine")
    .fv("orgA", "cad_mine", "fv_mine_1", 1, 11, sha("mine_1"))
    .fv("orgA", "cad_mine", "fv_mine_2", 2, 22, sha("mine_2"))
    .doc("orgB", "cad_theirs")
    .fv("orgB", "cad_theirs", "fv_theirs", 4, 44, sha("theirs"));

  const dto = await latestVersionsForActor(
    actorIn("orgA"),
    ["cad_mine", "cad_theirs", "cad_unknown"],
    fake.db,
  );

  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_mine", recognized: true, latestFileVersionId: "fv_mine_2", latestVersionNumber: 2,
      fileSize: 22, checksum: sha("mine_2"),
    },
    { cadDocumentId: "cad_theirs", recognized: false },
    { cadDocumentId: "cad_unknown", recognized: false },
  ]);
});

test("exact stable ids are returned VERBATIM (no trim / case change)", async () => {
  const weird = "cad_A-b.c_1";
  const fake = new FakeDb().doc("orgA", weird).fv("orgA", weird, "FV_Weird.Id", 3, 33, HEX64_A);

  const dto = await latestVersionsForActor(actorIn("orgA"), [weird], fake.db);

  assert.deepEqual(dto.results, [
    {
      cadDocumentId: weird, recognized: true, latestFileVersionId: "FV_Weird.Id", latestVersionNumber: 3,
      fileSize: 33, checksum: HEX64_A,
    },
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
  const fake = new FakeDb().doc("orgA", "cad_1").fv("orgA", "cad_1", "fv_1", 4, 400, HEX64_A);

  const res = await desktopLatestVersionsHttpResult(
    actorIn("orgA", UserRole.VIEWER),
    query("cad_1"),
    fake.db,
  );

  assert.equal(res.status, 200);
  const body = res.body as { contract: string; results: LatestVersionResultDto[] };
  assert.equal(body.contract, DESKTOP_LATEST_VERSIONS_CONTRACT);
  assert.deepEqual(body.results, [
    {
      cadDocumentId: "cad_1", recognized: true, latestFileVersionId: "fv_1", latestVersionNumber: 4,
      fileSize: 400, checksum: HEX64_A,
    },
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
    .fv("orgA", "cad_a", "fv_a", 7, 700, HEX64_A)
    .doc("orgA", "cad_b"); // recognised, no FileVersion

  const res = await desktopLatestVersionsHttpResult(actorIn("orgA"), query("cad_a", "cad_b", "cad_c"), fake.db);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    contract: "arch-plm.desktop-latest-versions.v1",
    results: [
      {
        cadDocumentId: "cad_a", recognized: true, latestFileVersionId: "fv_a", latestVersionNumber: 7,
        fileSize: 700, checksum: HEX64_A,
      },
      { cadDocumentId: "cad_b", recognized: false },
      { cadDocumentId: "cad_c", recognized: false },
    ],
  });
  // every entry has an explicit boolean `recognized`
  for (const r of (res.body as { results: LatestVersionResultDto[] }).results) {
    assert.equal(typeof r.recognized, "boolean");
  }
});

test("http: a recognised latest version with non-canonical integrity metadata is reported recognized:false", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_ok")
    .fv("orgA", "cad_ok", "fv_ok", 1, 128, HEX64_A)
    .doc("orgA", "cad_bad_chk")
    .fv("orgA", "cad_bad_chk", "fv_bad_chk", 1, 128, "NOTCANONICAL")
    .doc("orgA", "cad_bad_size")
    .fv("orgA", "cad_bad_size", "fv_bad_size", 1, PG_BIGINT_MAX, HEX64_A);

  const res = await desktopLatestVersionsHttpResult(
    actorIn("orgA"),
    query("cad_ok", "cad_bad_chk", "cad_bad_size"),
    fake.db,
  );

  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { results: LatestVersionResultDto[] }).results, [
    {
      cadDocumentId: "cad_ok", recognized: true, latestFileVersionId: "fv_ok", latestVersionNumber: 1,
      fileSize: 128, checksum: HEX64_A,
    },
    { cadDocumentId: "cad_bad_chk", recognized: false },
    { cadDocumentId: "cad_bad_size", recognized: false },
  ]);
});
