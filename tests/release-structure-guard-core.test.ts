/**
 * B06 (pilot rule D-B): unit tests for app/lib/release-structure-guard-core.ts.
 * Run with: node --experimental-strip-types --test tests/release-structure-guard-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findStructureGaps,
  ReleaseStructureIncompleteError,
  STRUCTURE_LINK_TYPES,
  type StructureGuardEdge,
  type StructureGuardNode,
} from "../app/lib/release-structure-guard-core.ts";

const node = (cadDocumentId: string, documentType: string): StructureGuardNode => ({ cadDocumentId, documentType });
const edge = (parent: string, child: string, dependencyType: string): StructureGuardEdge => ({
  parentCadDocumentId: parent,
  childCadDocumentId: child,
  dependencyType,
});

test("an assembly with no links at all is a gap", () => {
  assert.deepEqual(findStructureGaps([node("asm", "IAM")], []), [
    { cadDocumentId: "asm", kind: "ASSEMBLY_WITHOUT_COMPONENTS" },
  ]);
});

test("an assembly with only REFERENCE / DERIVED / OTHER / DRAWING_REFERENCE links is still a gap", () => {
  for (const type of ["REFERENCE", "DERIVED", "OTHER", "DRAWING_REFERENCE"]) {
    assert.equal(findStructureGaps([node("asm", "IAM")], [edge("asm", "p1", type)]).length, 1, type);
  }
});

test("an assembly with one COMPONENT link is not a gap", () => {
  assert.deepEqual(findStructureGaps([node("asm", "IAM")], [edge("asm", "p1", "COMPONENT")]), []);
});

test("a drawing (IDW or DWG) needs a DRAWING_REFERENCE link; COMPONENT does not count", () => {
  for (const type of ["IDW", "DWG"]) {
    assert.deepEqual(findStructureGaps([node("drw", type)], []), [
      { cadDocumentId: "drw", kind: "DRAWING_WITHOUT_MODEL" },
    ]);
    assert.equal(findStructureGaps([node("drw", type)], [edge("drw", "m", "COMPONENT")]).length, 1);
    assert.deepEqual(findStructureGaps([node("drw", type)], [edge("drw", "m", "DRAWING_REFERENCE")]), []);
  }
});

test("IPT, PDF and OTHER documents never have a structure requirement", () => {
  assert.deepEqual(findStructureGaps([node("a", "IPT"), node("b", "PDF"), node("c", "OTHER")], []), []);
});

test("a nested sub-assembly in the closure is checked too, not only the top assembly", () => {
  const gaps = findStructureGaps(
    [node("top", "IAM"), node("sub", "IAM"), node("p1", "IPT")],
    [edge("top", "sub", "COMPONENT"), edge("top", "p1", "COMPONENT")],
  );
  assert.deepEqual(gaps, [{ cadDocumentId: "sub", kind: "ASSEMBLY_WITHOUT_COMPONENTS" }]);
});

test("only an edge FROM the node counts: being a child of something does not satisfy the rule", () => {
  const gaps = findStructureGaps([node("top", "IAM"), node("sub", "IAM")], [edge("top", "sub", "COMPONENT")]);
  assert.deepEqual(gaps.map((g) => g.cadDocumentId), ["sub"]);
});

test("a self-edge never counts (defence in depth; the database already forbids it)", () => {
  assert.equal(findStructureGaps([node("asm", "IAM")], [edge("asm", "asm", "COMPONENT")]).length, 1);
});

test("edges whose parent is outside the closure are ignored", () => {
  assert.equal(findStructureGaps([node("asm", "IAM")], [edge("other", "asm", "COMPONENT")]).length, 1);
});

test("gaps are sorted by document id and each document is reported once", () => {
  const gaps = findStructureGaps(
    [node("z-asm", "IAM"), node("a-drw", "IDW"), node("m-asm", "IAM"), node("m-asm", "IAM")],
    [],
  );
  assert.deepEqual(gaps.map((g) => g.cadDocumentId), ["a-drw", "m-asm", "z-asm"]);
});

test("the wiring layer reads exactly the two structure link types", () => {
  assert.deepEqual([...STRUCTURE_LINK_TYPES], ["COMPONENT", "DRAWING_REFERENCE"]);
});

test("ReleaseStructureIncompleteError carries the first gap and the count, and needs at least one gap", () => {
  const error = new ReleaseStructureIncompleteError([
    { cadDocumentId: "a-drw", kind: "DRAWING_WITHOUT_MODEL" },
    { cadDocumentId: "z-asm", kind: "ASSEMBLY_WITHOUT_COMPONENTS" },
  ]);
  assert.equal(error.name, "ReleaseStructureIncompleteError");
  assert.equal(error.cadDocumentId, "a-drw");
  assert.equal(error.kind, "DRAWING_WITHOUT_MODEL");
  assert.equal(error.gapCount, 2);
  assert.throws(() => new ReleaseStructureIncompleteError([]), RangeError);
});
