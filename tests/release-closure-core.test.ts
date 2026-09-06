/**
 * Focused tests for the dependency-complete release closure
 * (`app/lib/release-closure-core.ts`, P3D-3).
 *
 * Pure graph math - no database, no storage. Covers direct-only, linear and
 * recursive closures, diamonds (dedup), the DIRECT-wins rule, cycle
 * termination, determinism vs row order, the node cap, and dangling
 * children.
 *
 * Run with:  node --experimental-strip-types --test tests/release-closure-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeReleaseClosure,
  ReleaseClosureInvalidError,
  ReleaseClosureTooLargeError,
  type ReleaseClosureDeps,
  type ReleaseClosureEdge,
} from "../app/lib/release-closure-core.ts";

/** Build deps from an adjacency list. `existing` defaults to "every id
 *  mentioned anywhere". `shuffle` reverses returned rows to prove ordering
 *  independence. */
function graph(opts: {
  roots: string[];
  edges: Array<[string, string]>;
  existing?: string[];
  shuffle?: boolean;
  maxNodes?: number;
}): ReleaseClosureDeps {
  const edges: ReleaseClosureEdge[] = opts.edges.map(([p, c]) => ({
    parentCadDocumentId: p,
    childCadDocumentId: c,
  }));
  const mentioned = new Set<string>([
    ...opts.roots,
    ...opts.edges.flatMap(([p, c]) => [p, c]),
  ]);
  const existing = new Set(opts.existing ?? [...mentioned]);
  const maybeShuffle = <T>(rows: T[]): T[] => (opts.shuffle ? [...rows].reverse() : rows);
  return {
    maxNodes: opts.maxNodes,
    async loadDirectDocumentIds() {
      return maybeShuffle([...opts.roots]);
    },
    async loadChildEdges(parentIds) {
      const set = new Set(parentIds);
      return maybeShuffle(edges.filter((e) => set.has(e.parentCadDocumentId)));
    },
    async loadExistingDocumentIds(ids) {
      return maybeShuffle(ids.filter((id) => existing.has(id)));
    },
  };
}

function kinds(nodes: Array<{ cadDocumentId: string; inclusionKind: string }>): Record<string, string> {
  return Object.fromEntries(nodes.map((n) => [n.cadDocumentId, n.inclusionKind]));
}

// A. direct document only -> DIRECT entry
test("A. a direct document with no dependencies: one DIRECT node", async () => {
  const res = await computeReleaseClosure(graph({ roots: ["a"], edges: [] }));
  assert.deepEqual(res.cadDocumentIds, ["a"]);
  assert.deepEqual(kinds(res.nodes), { a: "DIRECT" });
  assert.equal(res.directCount, 1);
  assert.equal(res.dependencyCount, 0);
  assert.equal(res.edgeCount, 0);
});

// B. A -> B  =>  A DIRECT, B DEPENDENCY
test("B. A depends on B: A DIRECT, B DEPENDENCY", async () => {
  const res = await computeReleaseClosure(graph({ roots: ["a"], edges: [["a", "b"]] }));
  assert.deepEqual(res.cadDocumentIds, ["a", "b"]);
  assert.deepEqual(kinds(res.nodes), { a: "DIRECT", b: "DEPENDENCY" });
  assert.equal(res.edgeCount, 1);
});

// C. A -> B -> C  =>  full recursive closure
test("C. A -> B -> C: the whole recursive chain is frozen", async () => {
  const res = await computeReleaseClosure(
    graph({ roots: ["a"], edges: [["a", "b"], ["b", "c"]] }),
  );
  assert.deepEqual(res.cadDocumentIds, ["a", "b", "c"]);
  assert.deepEqual(kinds(res.nodes), { a: "DIRECT", b: "DEPENDENCY", c: "DEPENDENCY" });
});

// D. diamond A->B, A->C, B->D, C->D  =>  D once
test("D. diamond graph: the shared leaf appears exactly once", async () => {
  const res = await computeReleaseClosure(
    graph({
      roots: ["a"],
      edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]],
    }),
  );
  assert.deepEqual(res.cadDocumentIds, ["a", "b", "c", "d"]);
  assert.equal(res.nodes.filter((n) => n.cadDocumentId === "d").length, 1);
  assert.deepEqual(kinds(res.nodes), {
    a: "DIRECT",
    b: "DEPENDENCY",
    c: "DEPENDENCY",
    d: "DEPENDENCY",
  });
  assert.equal(res.edgeCount, 4);
});

// E. a document both direct and a dependency  =>  one entry, DIRECT wins
test("E. a document that is both a direct root and a dependency child: one entry, DIRECT wins", async () => {
  const res = await computeReleaseClosure(
    graph({ roots: ["a", "b"], edges: [["a", "b"], ["b", "c"]] }),
  );
  assert.deepEqual(res.cadDocumentIds, ["a", "b", "c"]);
  assert.deepEqual(kinds(res.nodes), { a: "DIRECT", b: "DIRECT", c: "DEPENDENCY" });
  assert.equal(res.nodes.filter((n) => n.cadDocumentId === "b").length, 1);
});

// F. dependency cycle defense  =>  terminates
test("F. a pre-existing dependency cycle: traversal terminates and every node is captured once", async () => {
  const res = await computeReleaseClosure(
    graph({ roots: ["a"], edges: [["a", "b"], ["b", "c"], ["c", "a"], ["c", "b"]] }),
  );
  assert.deepEqual(res.cadDocumentIds, ["a", "b", "c"]);
  assert.deepEqual(kinds(res.nodes), { a: "DIRECT", b: "DEPENDENCY", c: "DEPENDENCY" });
});

test("F2. a self-referential edge is ignored, not treated as a dependency", async () => {
  const res = await computeReleaseClosure(
    graph({ roots: ["a"], edges: [["a", "a"], ["a", "b"]] }),
  );
  assert.deepEqual(res.cadDocumentIds, ["a", "b"]);
  assert.equal(res.edgeCount, 1, "the self-edge is not counted");
});

// L. zero-document revision -> valid empty closure
test("L. a revision with zero direct documents: empty closure, not an error", async () => {
  const res = await computeReleaseClosure(graph({ roots: [], edges: [] }));
  assert.deepEqual(res.nodes, []);
  assert.deepEqual(res.cadDocumentIds, []);
  assert.equal(res.directCount, 0);
  assert.equal(res.dependencyCount, 0);
});

// Determinism: identical result regardless of row-return order
test("determinism: shuffled database row order produces an identical closure", async () => {
  const spec = {
    roots: ["r2", "r1"],
    edges: [["r1", "x"], ["r2", "y"], ["x", "z"], ["y", "z"]] as Array<[string, string]>,
  };
  const straight = await computeReleaseClosure(graph({ ...spec }));
  const shuffled = await computeReleaseClosure(graph({ ...spec, shuffle: true }));
  assert.deepEqual(straight.nodes, shuffled.nodes);
  assert.deepEqual(straight.cadDocumentIds, ["r1", "r2", "x", "y", "z"]);
});

// Node cap
test("closure exceeding the node cap throws ReleaseClosureTooLargeError", async () => {
  await assert.rejects(
    () =>
      computeReleaseClosure(
        graph({
          roots: ["a"],
          edges: [["a", "b"], ["a", "c"], ["a", "d"]],
          maxNodes: 2,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseClosureTooLargeError);
      assert.equal(error.maxNodes, 2);
      return true;
    },
  );
});

test("more direct roots than the node cap throws immediately", async () => {
  await assert.rejects(
    () => computeReleaseClosure(graph({ roots: ["a", "b", "c"], edges: [], maxNodes: 2 })),
    ReleaseClosureTooLargeError,
  );
});

// Dangling / cross-tenant child
test("a discovered dependency child that is not a real tenant document throws ReleaseClosureInvalidError", async () => {
  await assert.rejects(
    () =>
      computeReleaseClosure(
        graph({
          roots: ["a"],
          edges: [["a", "ghost"]],
          existing: ["a"], // "ghost" is not a real document
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseClosureInvalidError);
      assert.equal(error.cadDocumentId, "ghost");
      return true;
    },
  );
});
