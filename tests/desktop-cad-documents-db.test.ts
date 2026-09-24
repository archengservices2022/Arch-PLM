/**
 * Focused tests for the P4B CAD Connect document-resolve lookup
 * (`app/lib/desktop-cad-documents-db.ts` + `-core.ts`). In-memory fake DB -
 * no Postgres, no network, no Inventor.
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-cad-documents-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import {
  DesktopCadDocError,
  desktopResolveHttpResult,
  resolveCadDocumentForActor,
  type DesktopCadDocDb,
} from "../app/lib/desktop-cad-documents-db.ts";
import {
  DESKTOP_CAD_DOC_CONTRACT,
  MAX_CAD_DOC_QUERY_LENGTH,
  parseCadDocumentQuery,
} from "../app/lib/desktop-cad-documents-core.ts";

interface DocRow {
  organizationId: string;
  id: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}

class FakeDb {
  readonly docs: DocRow[] = [];

  add(row: DocRow): this {
    this.docs.push(row);
    return this;
  }

  private matches(
    d: DocRow,
    where: { organizationId: string; documentNumber?: string; id?: string; documentType?: string },
  ): boolean {
    return (
      d.organizationId === where.organizationId &&
      (where.documentNumber === undefined || d.documentNumber === where.documentNumber) &&
      (where.id === undefined || d.id === where.id) &&
      (where.documentType === undefined || d.documentType === where.documentType)
    );
  }

  get db(): DesktopCadDocDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: {
          where: { organizationId: string; documentNumber?: string; id?: string; documentType?: string };
        }) => {
          const row = self.docs.find((d) => self.matches(d, args.where));
          return row
            ? {
                id: row.id,
                documentNumber: row.documentNumber,
                fileName: row.fileName,
                documentType: row.documentType,
              }
            : null;
        }) as unknown as DesktopCadDocDb["cadDocument"]["findFirst"],
        // P6D ROUND 2: the ambiguous-number-only resolution path uses
        // findMany (with `take: 2`) instead of findFirst.
        findMany: (async (args: {
          where: { organizationId: string; documentNumber?: string; id?: string; documentType?: string };
          take?: number;
        }) => {
          const rows = self.docs.filter((d) => self.matches(d, args.where));
          const sliced = typeof args.take === "number" ? rows.slice(0, args.take) : rows;
          return sliced.map((row) => ({
            id: row.id,
            documentNumber: row.documentNumber,
            fileName: row.fileName,
            documentType: row.documentType,
          }));
        }) as unknown as DesktopCadDocDb["cadDocument"]["findMany"],
      } as unknown as DesktopCadDocDb["cadDocument"],
    } as unknown as DesktopCadDocDb;
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

function params(pairs: Record<string, string>): URLSearchParams {
  return new URLSearchParams(pairs);
}

// ------------------------------------------------------------
// parseCadDocumentQuery
// ------------------------------------------------------------

test("parseCadDocumentQuery: exactly one of documentNumber / cadDocumentId", () => {
  assert.deepEqual(parseCadDocumentQuery(params({ documentNumber: " DOC-1 " })), {
    kind: "documentNumber",
    value: "DOC-1",
    documentType: null,
  });
  assert.deepEqual(parseCadDocumentQuery(params({ cadDocumentId: "cad_abc" })), {
    kind: "cadDocumentId",
    value: "cad_abc",
  });

  for (const bad of [
    {},
    { documentNumber: "" },
    { documentNumber: "  " },
    { documentNumber: "A", cadDocumentId: "B" },
  ]) {
    assert.throws(
      () => parseCadDocumentQuery(params(bad as Record<string, string>)),
      (err: unknown) => err instanceof DesktopCadDocError && err.status === 400,
    );
  }
});

// P6D ROUND 2, HIGH fix: optional documentType disambiguation.
test("parseCadDocumentQuery: optional documentType alongside documentNumber", () => {
  assert.deepEqual(parseCadDocumentQuery(params({ documentNumber: "1001", documentType: "IDW" })), {
    kind: "documentNumber",
    value: "1001",
    documentType: "IDW",
  });

  assert.throws(
    () => parseCadDocumentQuery(params({ documentNumber: "1001", documentType: "NOT-A-TYPE" })),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 400,
  );

  // documentType is meaningless (and rejected) alongside cadDocumentId,
  // which is already unambiguous on its own.
  assert.throws(
    () => parseCadDocumentQuery(params({ cadDocumentId: "cad_abc", documentType: "IPT" })),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 400,
  );
});

// P6D ROUND 3, item H: documentType PRESENT but blank/whitespace must be
// rejected (400) - it must never be silently treated the same as OMITTED
// (which keeps the existing "no disambiguation requested" behavior).
test("parseCadDocumentQuery: a PRESENT but blank/whitespace documentType is 400, distinct from omitted", () => {
  assert.throws(
    () => parseCadDocumentQuery(params({ documentNumber: "1001", documentType: "" })),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 400,
  );
  assert.throws(
    () => parseCadDocumentQuery(params({ documentNumber: "1001", documentType: "   " })),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 400,
  );

  // Omitting the param entirely is unaffected - still the existing optional
  // ("no type disambiguation requested") behavior.
  assert.deepEqual(parseCadDocumentQuery(params({ documentNumber: "1001" })), {
    kind: "documentNumber",
    value: "1001",
    documentType: null,
  });
});

test("parseCadDocumentQuery: over-length value is 400 and never echoed", () => {
  const huge = "x".repeat(MAX_CAD_DOC_QUERY_LENGTH + 1);
  assert.throws(
    () => parseCadDocumentQuery(params({ documentNumber: huge })),
    (err: unknown) => {
      assert.ok(err instanceof DesktopCadDocError);
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes(huge));
      return true;
    },
  );
});

// ------------------------------------------------------------
// resolveCadDocumentForActor
// ------------------------------------------------------------

test("resolve by documentNumber returns the authoritative id + display fields", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_root_1",
    documentNumber: "10073-MFD-AS210",
    fileName: "assembly.iam",
    documentType: "IAM",
  });

  const dto = await resolveCadDocumentForActor(
    actorIn("orgA"),
    { kind: "documentNumber", value: "10073-MFD-AS210", documentType: null },
    fake.db,
  );

  assert.equal(dto.contract, DESKTOP_CAD_DOC_CONTRACT);
  assert.equal(dto.cadDocumentId, "cad_root_1");
  assert.equal(dto.documentNumber, "10073-MFD-AS210");
  assert.equal(dto.fileName, "assembly.iam");
  assert.equal(dto.cadType, "IAM");
});

test("resolve by cadDocumentId re-validates tenant ownership", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_1",
    documentNumber: "DOC-1",
    fileName: "p.ipt",
    documentType: "IPT",
  });

  const dto = await resolveCadDocumentForActor(
    actorIn("orgA"),
    { kind: "cadDocumentId", value: "cad_1" },
    fake.db,
  );
  assert.equal(dto.cadDocumentId, "cad_1");
});

test("cross-tenant lookup (by number OR id) is 404, never leaked", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_secret",
    documentNumber: "SECRET-1",
    fileName: "s.iam",
    documentType: "IAM",
  });
  const outsider = actorIn("orgB");

  for (const query of [
    { kind: "documentNumber", value: "SECRET-1", documentType: null } as const,
    { kind: "cadDocumentId", value: "cad_secret" } as const,
  ]) {
    await assert.rejects(
      () => resolveCadDocumentForActor(outsider, query, fake.db),
      (err: unknown) => {
        assert.ok(err instanceof DesktopCadDocError);
        assert.equal(err.status, 404);
        assert.ok(!err.message.includes("SECRET-1"));
        assert.ok(!err.message.includes("cad_secret"));
        return true;
      },
    );
  }
});

test("unknown document number in the tenant is 404", async () => {
  const fake = new FakeDb();
  await assert.rejects(
    () => resolveCadDocumentForActor(actorIn("orgA"), { kind: "documentNumber", value: "NOPE", documentType: null }, fake.db),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 404,
  );
});

// ======================================================================
// P6D ROUND 2, HIGH fix: documentNumber is no longer unique by itself - a
// number-only query that matches more than one document (e.g. "1001.ipt"
// AND "1001.idw" both exist) must fail closed, never silently pick one.
// ======================================================================

test("ambiguous number-only resolution (two documents share the number) fails closed with 409, never picks one", async () => {
  const fake = new FakeDb()
    .add({ organizationId: "orgA", id: "cad_ipt", documentNumber: "1001", fileName: "1001.ipt", documentType: "IPT" })
    .add({ organizationId: "orgA", id: "cad_idw", documentNumber: "1001", fileName: "1001.idw", documentType: "IDW" });

  await assert.rejects(
    () => resolveCadDocumentForActor(actorIn("orgA"), { kind: "documentNumber", value: "1001", documentType: null }, fake.db),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 409,
  );
});

test("typed resolution (documentNumber + documentType) returns the correct document even when the number is shared", async () => {
  const fake = new FakeDb()
    .add({ organizationId: "orgA", id: "cad_ipt", documentNumber: "1001", fileName: "1001.ipt", documentType: "IPT" })
    .add({ organizationId: "orgA", id: "cad_idw", documentNumber: "1001", fileName: "1001.idw", documentType: "IDW" });

  const ipt = await resolveCadDocumentForActor(
    actorIn("orgA"),
    { kind: "documentNumber", value: "1001", documentType: "IPT" },
    fake.db,
  );
  assert.equal(ipt.cadDocumentId, "cad_ipt");
  assert.equal(ipt.cadType, "IPT");

  const idw = await resolveCadDocumentForActor(
    actorIn("orgA"),
    { kind: "documentNumber", value: "1001", documentType: "IDW" },
    fake.db,
  );
  assert.equal(idw.cadDocumentId, "cad_idw");
  assert.equal(idw.cadType, "IDW");
});

// existing unique-number workflow still works: a number-only query that
// matches EXACTLY one document (the normal, non-ambiguous case) still
// succeeds exactly as before.
test("number-only resolution still succeeds when the number is genuinely unique in the tenant", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_only",
    documentNumber: "10073-UNIQUE",
    fileName: "10073-UNIQUE.ipt",
    documentType: "IPT",
  });

  const dto = await resolveCadDocumentForActor(
    actorIn("orgA"),
    { kind: "documentNumber", value: "10073-UNIQUE", documentType: null },
    fake.db,
  );
  assert.equal(dto.cadDocumentId, "cad_only");
});

test("http: ambiguous number-only query surfaces as 409 through the HTTP mapping", async () => {
  const fake = new FakeDb()
    .add({ organizationId: "orgA", id: "cad_ipt", documentNumber: "1001", fileName: "1001.ipt", documentType: "IPT" })
    .add({ organizationId: "orgA", id: "cad_idw", documentNumber: "1001", fileName: "1001.idw", documentType: "IDW" });

  const res = await desktopResolveHttpResult(actorIn("orgA"), params({ documentNumber: "1001" }), fake.db);
  assert.equal(res.status, 409);
});

// ------------------------------------------------------------
// desktopResolveHttpResult
// ------------------------------------------------------------

test("http: no actor -> 401, does not touch the database", async () => {
  const fake = new FakeDb();
  const res = await desktopResolveHttpResult(null, params({ documentNumber: "DOC-1" }), fake.db);
  assert.equal(res.status, 401);
});

test("http: VIEWER can resolve (read is not gated on write roles)", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_1",
    documentNumber: "DOC-1",
    fileName: "p.ipt",
    documentType: "IPT",
  });
  const res = await desktopResolveHttpResult(
    actorIn("orgA", UserRole.VIEWER),
    params({ documentNumber: "DOC-1" }),
    fake.db,
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as { cadDocumentId: string }).cadDocumentId, "cad_1");
});

test("http: malformed query -> 400; not found -> 404; happy -> 200", async () => {
  const fake = new FakeDb().add({
    organizationId: "orgA",
    id: "cad_1",
    documentNumber: "DOC-1",
    fileName: "p.ipt",
    documentType: "IPT",
  });
  const actor = actorIn("orgA");

  assert.equal((await desktopResolveHttpResult(actor, params({}), fake.db)).status, 400);
  assert.equal(
    (await desktopResolveHttpResult(actor, params({ documentNumber: "MISSING" }), fake.db)).status,
    404,
  );
  assert.equal(
    (await desktopResolveHttpResult(actor, params({ documentNumber: "DOC-1" }), fake.db)).status,
    200,
  );
});
