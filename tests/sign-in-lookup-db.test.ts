/**
 * SIGNIN-EXACT (Codex P-1b): exact sign-in lookup (app/lib/sign-in-lookup-db.ts).
 *   node --experimental-strip-types --test tests/sign-in-lookup-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { findSignInUserId, type SignInLookupDb } from "../app/lib/sign-in-lookup-db.ts";

function fakeDb(rows: Array<{ id: string }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return rows;
    },
  } as unknown as SignInLookupDb;
  return { db, calls };
}

test("exact comparison as a bound parameter - no LIKE / ILIKE pattern", async () => {
  for (const activeOnly of [true, false]) {
    const { db, calls } = fakeDb([{ id: "u1" }]);
    assert.equal(await findSignInUserId(db, "%", { activeOnly }), "u1");
    assert.match(calls[0].sql, /WHERE lower\("email"\) = \?/);
    assert.doesNotMatch(calls[0].sql, /LIKE/i);
    assert.deepEqual(calls[0].values, ["%"]);
    assert.match(calls[0].sql, /LIMIT 2/);
    assert.equal(/"active" = true/.test(calls[0].sql), activeOnly);
  }
});

test("no row or two rows (ambiguous) -> null", async () => {
  assert.equal(await findSignInUserId(fakeDb([]).db, "a@b.io", { activeOnly: true }), null);
  assert.equal(await findSignInUserId(fakeDb([{ id: "u1" }, { id: "u2" }]).db, "a@b.io", { activeOnly: true }), null);
});

test("source: neither sign-in path uses Prisma's insensitive (ILIKE) email filter any more", () => {
  for (const file of ["../auth.ts", "../app/lib/desktop-auth-db.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /mode:\s*"insensitive"/, file);
    assert.match(src, /findSignInUserId\(/, file);
  }
});
