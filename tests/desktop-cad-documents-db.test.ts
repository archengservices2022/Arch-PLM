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

  get db(): DesktopCadDocDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: {
          where: { organizationId: string; documentNumber?: string; id?: string };
        }) => {
          const row = self.docs.find(
            (d) =>
              d.organizationId === args.where.organizationId &&
              (args.where.documentNumber === undefined ||
                d.documentNumber === args.where.documentNumber) &&
              (args.where.id === undefined || d.id === args.where.id),
          );
          return row
            ? {
                id: row.id,
                documentNumber: row.documentNumber,
                fileName: row.fileName,
                documentType: row.documentType,
              }
            : null;
        }) as unknown as DesktopCadDocDb["cadDocument"]["findFirst"],
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
    { kind: "documentNumber", value: "10073-MFD-AS210" },
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
    { kind: "documentNumber", value: "SECRET-1" } as const,
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
    () => resolveCadDocumentForActor(actorIn("orgA"), { kind: "documentNumber", value: "NOPE" }, fake.db),
    (err: unknown) => err instanceof DesktopCadDocError && err.status === 404,
  );
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
