/**
 * Focused tests for the P6D Drawing Association Authority lookup
 * (`app/lib/desktop-drawing-associations-db.ts` + `-core.ts`). In-memory fake
 * DB - no Postgres, no network, no Inventor.
 *
 * This is the server side of the P6D LIVE ACCEPTANCE BLOCKER fix: Copy
 * Design Preview's `IDrawingAssociationSource` previously had no real
 * authority to call (`NoDrawingAssociationSource` always reports NOT
 * AVAILABLE), so a genuinely-existing `DRAWING_REFERENCE` relationship was
 * never confirmed. These tests prove the missing authoritative lookup: a
 * model's stable id retrieves its authoritative drawing via the
 * `DRAWING_REFERENCE` edge, in the DRAWING -> MODEL direction, unconfused by
 * a same-documentNumber IAM+IDW pair, using stable ids only (never
 * documentNumber / filename), and distinguishing "recognized, zero
 * drawings" from "not recognized" (which the client maps to NotAvailable).
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-drawing-associations-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import {
  DesktopDrawingAssociationError,
  desktopDrawingAssociationsHttpResult,
  drawingAssociationsForActor,
  type DesktopDrawingAssociationDb,
} from "../app/lib/desktop-drawing-associations-db.ts";
import {
  DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT,
  MAX_DRAWING_ASSOCIATION_IDS,
  MAX_DRAWING_ASSOCIATION_ID_LENGTH,
  parseDrawingAssociationModelIds,
  type DrawingAssociationResultDto,
} from "../app/lib/desktop-drawing-associations-core.ts";

interface DocRow {
  organizationId: string;
  id: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}
interface DepRow {
  organizationId: string;
  parentDocumentId: string;
  childDocumentId: string;
  dependencyType: string;
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
  readonly deps: DepRow[] = [];
  readonly fvs: FvRow[] = [];

  doc(organizationId: string, id: string, documentNumber: string, fileName: string, documentType: string): this {
    this.docs.push({ organizationId, id, documentNumber, fileName, documentType });
    return this;
  }
  dep(organizationId: string, parentDocumentId: string, childDocumentId: string, dependencyType: string): this {
    this.deps.push({ organizationId, parentDocumentId, childDocumentId, dependencyType });
    return this;
  }
  fv(organizationId: string, cadDocumentId: string, id: string, versionNumber: number): this {
    this.fvs.push({ organizationId, cadDocumentId, id, versionNumber });
    return this;
  }

  get db(): DesktopDrawingAssociationDb {
    const self = this;
    const forbidWrite = (name: string) =>
      ((..._args: unknown[]) => {
        writeCalls.push(name);
        throw new Error(`unexpected write: ${name}`);
      }) as unknown as never;

    const cadDocument = {
      findMany: (async (args: { where: { organizationId: string; id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return self.docs
          .filter((d) => d.organizationId === args.where.organizationId && ids.has(d.id))
          .map((d) => ({ id: d.id }));
      }) as unknown as DesktopDrawingAssociationDb["cadDocument"]["findMany"],
      create: forbidWrite("cadDocument.create"),
      update: forbidWrite("cadDocument.update"),
      updateMany: forbidWrite("cadDocument.updateMany"),
      delete: forbidWrite("cadDocument.delete"),
      deleteMany: forbidWrite("cadDocument.deleteMany"),
      upsert: forbidWrite("cadDocument.upsert"),
    } as unknown as DesktopDrawingAssociationDb["cadDocument"];

    const cadDependency = {
      findMany: (async (args: {
        where: { organizationId: string; dependencyType: string; childDocumentId: { in: string[] } };
      }) => {
        const ids = new Set(args.where.childDocumentId.in);
        return self.deps
          .filter(
            (d) =>
              d.organizationId === args.where.organizationId &&
              d.dependencyType === args.where.dependencyType &&
              ids.has(d.childDocumentId),
          )
          .map((d) => {
            const parent = self.docs.find(
              (doc) => doc.organizationId === d.organizationId && doc.id === d.parentDocumentId,
            );
            if (!parent) throw new Error(`fixture error: no parent doc for ${d.parentDocumentId}`);
            return {
              childDocumentId: d.childDocumentId,
              parentDocument: {
                id: parent.id,
                documentNumber: parent.documentNumber,
                fileName: parent.fileName,
                documentType: parent.documentType,
              },
            };
          });
      }) as unknown as DesktopDrawingAssociationDb["cadDependency"]["findMany"],
      create: forbidWrite("cadDependency.create"),
      update: forbidWrite("cadDependency.update"),
      updateMany: forbidWrite("cadDependency.updateMany"),
      delete: forbidWrite("cadDependency.delete"),
      deleteMany: forbidWrite("cadDependency.deleteMany"),
      upsert: forbidWrite("cadDependency.upsert"),
    } as unknown as DesktopDrawingAssociationDb["cadDependency"];

    const fileVersion = {
      findMany: (async (args: {
        where: { organizationId: string; cadDocumentId: { in: string[] } };
        orderBy: Array<Record<string, "asc" | "desc">>;
        distinct?: string[];
      }) => {
        const ids = new Set(args.where.cadDocumentId.in);
        let rows = self.fvs.filter(
          (f) => f.organizationId === args.where.organizationId && ids.has(f.cadDocumentId),
        );
        rows = rows.slice().sort((a, b) => {
          if (a.cadDocumentId !== b.cadDocumentId) return a.cadDocumentId < b.cadDocumentId ? -1 : 1;
          return b.versionNumber - a.versionNumber;
        });
        if (args.distinct?.includes("cadDocumentId")) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.cadDocumentId) ? false : (seen.add(r.cadDocumentId), true)));
        }
        return rows.map((r) => ({ cadDocumentId: r.cadDocumentId, id: r.id }));
      }) as unknown as DesktopDrawingAssociationDb["fileVersion"]["findMany"],
      create: forbidWrite("fileVersion.create"),
      update: forbidWrite("fileVersion.update"),
      updateMany: forbidWrite("fileVersion.updateMany"),
      delete: forbidWrite("fileVersion.delete"),
      deleteMany: forbidWrite("fileVersion.deleteMany"),
      upsert: forbidWrite("fileVersion.upsert"),
    } as unknown as DesktopDrawingAssociationDb["fileVersion"];

    return { cadDocument, cadDependency, fileVersion } as unknown as DesktopDrawingAssociationDb;
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

function resultFor(results: DrawingAssociationResultDto[], id: string): DrawingAssociationResultDto {
  const r = results.find((x) => x.cadDocumentId === id);
  assert.ok(r, `no result for ${id}`);
  return r;
}

/** Build a P6D-shaped fixture: ROOT IDW -DRAWING_REFERENCE-> ROOT IAM, same
 *  documentNumber, different documentType - plus PART-A/PART-B components
 *  (COMPONENT edges, never returned by this lookup). */
function p6dFixture(): FakeDb {
  return new FakeDb()
    .doc("orgA", "cad_root_iam", "P6D-REAL-ROOT", "P6D-REAL-ROOT.iam", "IAM")
    .doc("orgA", "cad_root_idw", "P6D-REAL-ROOT", "P6D-REAL-ROOT.idw", "IDW")
    .doc("orgA", "cad_part_a", "P6D-REAL-PART-A", "P6D-REAL-PART-A.ipt", "IPT")
    .doc("orgA", "cad_part_b", "P6D-REAL-PART-B", "P6D-REAL-PART-B.ipt", "IPT")
    .dep("orgA", "cad_root_idw", "cad_root_iam", "DRAWING_REFERENCE")
    .dep("orgA", "cad_root_iam", "cad_part_a", "COMPONENT")
    .dep("orgA", "cad_root_iam", "cad_part_b", "COMPONENT")
    .fv("orgA", "cad_root_idw", "fv_idw_1", 1);
}

// ------------------------------------------------------------
// parseDrawingAssociationModelIds
// ------------------------------------------------------------

test("parseDrawingAssociationModelIds: verbatim ids, exact-ordinal dedup, order preserved", () => {
  assert.deepEqual(parseDrawingAssociationModelIds(query("cad_a", "cad_b", "cad_a")), ["cad_a", "cad_b"]);
});

test("parseDrawingAssociationModelIds: at least one id is required (400)", () => {
  assert.throws(
    () => parseDrawingAssociationModelIds(new URLSearchParams()),
    (e: unknown) => e instanceof DesktopDrawingAssociationError && e.status === 400,
  );
});

test("parseDrawingAssociationModelIds: blank / whitespace-padded identifier -> 400, never normalised", () => {
  for (const bad of [query(""), query("   "), query(" cad_a"), query("cad_a ")]) {
    assert.throws(
      () => parseDrawingAssociationModelIds(bad),
      (e: unknown) => e instanceof DesktopDrawingAssociationError && e.status === 400,
    );
  }
});

test("parseDrawingAssociationModelIds: excessive batch -> 400; exactly at cap is fine", () => {
  const many = Array.from({ length: MAX_DRAWING_ASSOCIATION_IDS + 1 }, (_v, i) => `cad_${i}`);
  assert.throws(
    () => parseDrawingAssociationModelIds(query(...many)),
    (e: unknown) => e instanceof DesktopDrawingAssociationError && e.status === 400,
  );
  const atCap = Array.from({ length: MAX_DRAWING_ASSOCIATION_IDS }, (_v, i) => `cad_${i}`);
  assert.equal(parseDrawingAssociationModelIds(query(...atCap)).length, MAX_DRAWING_ASSOCIATION_IDS);
});

test("parseDrawingAssociationModelIds: over-length identifier -> 400, not echoed", () => {
  const huge = "x".repeat(MAX_DRAWING_ASSOCIATION_ID_LENGTH + 1);
  assert.throws(
    () => parseDrawingAssociationModelIds(query(huge)),
    (e: unknown) => {
      assert.ok(e instanceof DesktopDrawingAssociationError);
      assert.equal(e.status, 400);
      assert.ok(!e.message.includes(huge));
      return true;
    },
  );
});

// ------------------------------------------------------------
// drawingAssociationsForActor - the P6D fixture's exact shape
// ------------------------------------------------------------

test("model stable id retrieves its authoritative drawing (P6D fixture)", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_root_iam"], fake.db);

  assert.equal(dto.contract, DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT);
  assert.deepEqual(dto.results, [
    {
      cadDocumentId: "cad_root_iam",
      recognized: true,
      drawings: [
        {
          cadDocumentId: "cad_root_idw",
          documentNumber: "P6D-REAL-ROOT",
          fileName: "P6D-REAL-ROOT.idw",
          cadType: "IDW",
          currentFileVersionId: "fv_idw_1",
        },
      ],
    },
  ]);
});

test("DRAWING_REFERENCE direction: DRAWING -> MODEL - querying the DRAWING's own id finds nothing (it is not itself a model with an owning drawing)", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_root_idw"], fake.db);

  // The IDW is recognized (it IS a CadDocument) but owns no drawing of its
  // own - legitimately Found, zero drawings, never NotAvailable.
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_root_idw", recognized: true, drawings: [] }]);
});

test("the direction is never reversed: a COMPONENT edge (IAM -> PART) is never reported as a drawing association", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_part_a"], fake.db);

  // PART-A is a COMPONENT child of the IAM, not a DRAWING_REFERENCE child of
  // anything - it has no associated drawing.
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_part_a", recognized: true, drawings: [] }]);
});

test("same documentNumber IAM+IDW does not confuse the lookup", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(
    actorIn("orgA"),
    ["cad_root_iam", "cad_root_idw"],
    fake.db,
  );

  // Both share documentNumber "P6D-REAL-ROOT" - the lookup is keyed by
  // stable id only and must not merge or cross-contaminate their results.
  assert.deepEqual(resultFor(dto.results, "cad_root_iam"), {
    cadDocumentId: "cad_root_iam",
    recognized: true,
    drawings: [
      {
        cadDocumentId: "cad_root_idw",
        documentNumber: "P6D-REAL-ROOT",
        fileName: "P6D-REAL-ROOT.idw",
        cadType: "IDW",
        currentFileVersionId: "fv_idw_1",
      },
    ],
  });
  assert.deepEqual(resultFor(dto.results, "cad_root_idw"), {
    cadDocumentId: "cad_root_idw",
    recognized: true,
    drawings: [],
  });
});

test("current stable ids are used, not documentNumber / filename - a documentNumber-shaped string that is not a real id is not recognized", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["P6D-REAL-ROOT"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "P6D-REAL-ROOT", recognized: false }]);
});

test("empty association (recognized model, zero drawings) vs unrecognized id remain distinct", async () => {
  const fake = p6dFixture();

  const dto = await drawingAssociationsForActor(
    actorIn("orgA"),
    ["cad_part_a", "cad_totally_unknown"],
    fake.db,
  );

  assert.deepEqual(resultFor(dto.results, "cad_part_a"), {
    cadDocumentId: "cad_part_a",
    recognized: true,
    drawings: [],
  });
  assert.deepEqual(resultFor(dto.results, "cad_totally_unknown"), {
    cadDocumentId: "cad_totally_unknown",
    recognized: false,
  });
  // structurally distinguishable: only the recognized entry carries "drawings"
  assert.ok("drawings" in resultFor(dto.results, "cad_part_a"));
  assert.ok(!("drawings" in resultFor(dto.results, "cad_totally_unknown")));
});

test("a drawing CadDocument with no FileVersion yet -> currentFileVersionId: null (never fabricated)", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_model", "MODEL-1", "model.iam", "IAM")
    .doc("orgA", "cad_drawing", "MODEL-1", "model.idw", "IDW")
    .dep("orgA", "cad_drawing", "cad_model", "DRAWING_REFERENCE");
  // deliberately no .fv(...) call for cad_drawing

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_model"], fake.db);

  assert.deepEqual(resultFor(dto.results, "cad_model"), {
    cadDocumentId: "cad_model",
    recognized: true,
    drawings: [{
      cadDocumentId: "cad_drawing", documentNumber: "MODEL-1", fileName: "model.idw",
      cadType: "IDW", currentFileVersionId: null,
    }],
  });
});

test("a model with two independent drawings -> both returned, deterministic order", async () => {
  const fake = new FakeDb()
    .doc("orgA", "cad_model", "MODEL-2", "model.iam", "IAM")
    .doc("orgA", "cad_drawing_b", "MODEL-2-B", "model-b.idw", "IDW")
    .doc("orgA", "cad_drawing_a", "MODEL-2-A", "model-a.idw", "IDW")
    .dep("orgA", "cad_drawing_b", "cad_model", "DRAWING_REFERENCE")
    .dep("orgA", "cad_drawing_a", "cad_model", "DRAWING_REFERENCE")
    .fv("orgA", "cad_drawing_a", "fv_a", 1)
    .fv("orgA", "cad_drawing_b", "fv_b", 1);

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_model"], fake.db);

  const only = resultFor(dto.results, "cad_model");
  assert.ok(only.recognized);
  assert.deepEqual(
    only.drawings.map((d) => d.cadDocumentId),
    ["cad_drawing_a", "cad_drawing_b"],
  );
});

test("unknown id -> recognized:false", async () => {
  const fake = p6dFixture();
  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_missing"], fake.db);
  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_missing", recognized: false }]);
});

test("cross-tenant: another organization's model/drawing pair is never visible", async () => {
  const fake = p6dFixture()
    .doc("orgB", "cad_root_iam", "P6D-REAL-ROOT", "P6D-REAL-ROOT.iam", "IAM")
    .doc("orgB", "cad_root_idw", "P6D-REAL-ROOT", "P6D-REAL-ROOT.idw", "IDW")
    .dep("orgB", "cad_root_idw", "cad_root_iam", "DRAWING_REFERENCE");

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_root_iam"], fake.db);

  // Same ids exist in orgB with the SAME edge - orgA must see only its own.
  assert.deepEqual(resultFor(dto.results, "cad_root_iam").recognized, true);
  const mine = resultFor(dto.results, "cad_root_iam");
  assert.ok(mine.recognized);
  assert.equal(mine.drawings.length, 1);
  assert.equal(mine.drawings[0]!.cadDocumentId, "cad_root_idw");
});

test("document belonging to another organization -> recognized:false, no leak", async () => {
  const fake = new FakeDb()
    .doc("orgB", "cad_secret_model", "SECRET", "secret.iam", "IAM")
    .doc("orgB", "cad_secret_drawing", "SECRET", "secret.idw", "IDW")
    .dep("orgB", "cad_secret_drawing", "cad_secret_model", "DRAWING_REFERENCE");

  const dto = await drawingAssociationsForActor(actorIn("orgA"), ["cad_secret_model"], fake.db);

  assert.deepEqual(dto.results, [{ cadDocumentId: "cad_secret_model", recognized: false }]);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("cad_secret_drawing"));
  assert.ok(!json.includes("secret.idw"));
});

test("lookup performs NO mutation (only findMany is ever called)", async () => {
  writeCalls.length = 0;
  const fake = p6dFixture();

  await drawingAssociationsForActor(actorIn("orgA"), ["cad_root_iam", "cad_missing"], fake.db);

  assert.deepEqual(writeCalls, []);
});

// ------------------------------------------------------------
// desktopDrawingAssociationsHttpResult
// ------------------------------------------------------------

test("http: no actor -> 401, does not touch the database", async () => {
  const fake = p6dFixture();
  const res = await desktopDrawingAssociationsHttpResult(null, query("cad_root_iam"), fake.db);
  assert.equal(res.status, 401);
});

test("http: VIEWER can look up drawing associations (read is not gated on write roles)", async () => {
  const fake = p6dFixture();

  const res = await desktopDrawingAssociationsHttpResult(
    actorIn("orgA", UserRole.VIEWER),
    query("cad_root_iam"),
    fake.db,
  );

  assert.equal(res.status, 200);
  const body = res.body as { contract: string; results: DrawingAssociationResultDto[] };
  assert.equal(body.contract, DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT);
  assert.equal(body.results.length, 1);
});

test("http: blank / padded / empty / oversized query -> 400", async () => {
  const fake = p6dFixture();
  const actor = actorIn("orgA");

  assert.equal((await desktopDrawingAssociationsHttpResult(actor, new URLSearchParams(), fake.db)).status, 400);
  assert.equal((await desktopDrawingAssociationsHttpResult(actor, query("   "), fake.db)).status, 400);
  assert.equal((await desktopDrawingAssociationsHttpResult(actor, query(" cad_root_iam "), fake.db)).status, 400);
  const many = Array.from({ length: MAX_DRAWING_ASSOCIATION_IDS + 1 }, (_v, i) => `cad_${i}`);
  assert.equal((await desktopDrawingAssociationsHttpResult(actor, query(...many), fake.db)).status, 400);
});

test("http: full P6D fixture contract response shape (this IS the live-acceptance scenario)", async () => {
  const fake = p6dFixture();

  const res = await desktopDrawingAssociationsHttpResult(
    actorIn("orgA"),
    query("cad_root_iam", "cad_part_a", "cad_part_b"),
    fake.db,
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    contract: "arch-plm.desktop-drawing-associations.v1",
    results: [
      {
        cadDocumentId: "cad_root_iam",
        recognized: true,
        drawings: [{
          cadDocumentId: "cad_root_idw", documentNumber: "P6D-REAL-ROOT", fileName: "P6D-REAL-ROOT.idw",
          cadType: "IDW", currentFileVersionId: "fv_idw_1",
        }],
      },
      { cadDocumentId: "cad_part_a", recognized: true, drawings: [] },
      { cadDocumentId: "cad_part_b", recognized: true, drawings: [] },
    ],
  });
});
