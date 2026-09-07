/**
 * P4C disposable integration gate — REAL checkout / check-in / undo over the
 * desktop bearer (and cookie-parity).
 *
 * Not part of `npm test`. Needs a running dev server AND the real database +
 * local storage. Run from the `web/` directory:
 *
 *   1. terminal A:  npm run dev
 *   2. terminal B:  node --experimental-strip-types --env-file=.env \
 *                        scripts/itest-p4c-checkout.ts
 *
 * Throwaway `ITEST-<rand>` org, ENGINEER-A / ENGINEER-B / VIEWER / deactivated,
 * one CadDocument with a real V1 binary. Asserts, over the bearer:
 *   - checkout by A -> 201, base == V1
 *   - checkout by A again -> 200 already-mine
 *   - checkout by B -> 409, holder = A (name/email only)
 *   - GET status by B -> locked
 *   - VIEWER checkout -> 403
 *   - a second org's bearer -> 404 (cross-tenant)
 *   - deactivated user -> 401 at login
 *   - check-in by A -> 201, new V2; returned checksum + size == uploaded bytes
 *   - GET /file-versions/V2/content -> exact bytes, X-Content-SHA256 match
 *   - check-in again by A -> 409 not-checked-out
 *   - check-in by B (after B re-checks-out) then A -> 409 owned-by-another
 *   - VIEWER check-in -> 403
 *   - undo by B -> 200 { baseFileVersionId: V2 }; checkout gone
 *   - CadCheckoutEvent audit trail: CHECKED_OUT x2, CHECKED_IN x1, UNDO_CHECKOUT x1
 *   - cookie path: checkout + undo produce the same body shape as bearer
 *   - non-ITEST CadDocument/FileVersion/CadCheckout/CadCheckoutEvent row hash
 *     UNCHANGED before/after
 *   - FK-safe cleanup of every ITEST row + object + empty dirs
 *
 * Security: never prints a token, cookie, password or storage path.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import bcrypt from "bcryptjs";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  LocalFilesystemStorage,
  resolveMaxUploadBytes,
  resolveStorageRoot,
} from "../app/lib/storage-core.ts";
import { storeCadFileVersionForActor } from "../app/lib/upload-guard-db.ts";
import { loginWithCredentials } from "../cli/arch-session.ts";

const SERVER = (process.env.ITEST_SERVER ?? "http://localhost:3000").replace(/\/$/, "");
const PASSWORD = "itest-" + randomBytes(12).toString("hex");

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const jsonStable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

async function baselineRowHash(prisma: PrismaClient): Promise<string> {
  const notItest = { organization: { is: { code: { startsWith: "ITEST-" } } } };
  const [docs, fvs, checkouts, events] = await Promise.all([
    prisma.cadDocument.findMany({ where: { NOT: notItest }, orderBy: { id: "asc" } }),
    prisma.fileVersion.findMany({ where: { NOT: notItest }, orderBy: { id: "asc" } }),
    prisma.cadCheckout.findMany({ where: { NOT: notItest }, orderBy: { id: "asc" } }),
    prisma.cadCheckoutEvent.findMany({ where: { NOT: notItest }, orderBy: { id: "asc" } }),
  ]);
  return createHash("sha256").update(jsonStable({ docs, fvs, checkouts, events })).digest("hex");
}

// ---- HTTP helpers ---------------------------------------------------------

async function api(
  pathAndQuery: string,
  init: { method?: string; token?: string; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return fetch(new URL(pathAndQuery, SERVER), {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
}

async function loginStatus(email: string, password: string): Promise<number> {
  const res = await fetch(new URL("/api/desktop/auth/login", SERVER), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, clientLabel: "p4c-itest" }),
    redirect: "manual",
  });
  return res.status;
}

async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch(new URL("/api/desktop/auth/login", SERVER), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, clientLabel: "p4c-itest" }),
    redirect: "manual",
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body?.token === "string" ? body.token : null;
}

async function pruneEmptyStorageDirs(): Promise<void> {
  const root = resolveStorageRoot();
  if (!(await stat(root).then(() => true).catch(() => false))) return;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) await walk(path.join(dir, e.name));
    try {
      if (dir !== root && (await readdir(dir)).length === 0) await rm(dir, { recursive: false });
    } catch { /* best effort */ }
  };
  await walk(root);
}

// ------------------------------------------------------------------------

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const provider = new LocalFilesystemStorage(resolveStorageRoot());
  const maxBytes = resolveMaxUploadBytes();

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  const otherOrgCode = `ITEST-${rand}X`;

  console.log(`P4C checkout gate — org ${orgCode}, server ${SERVER}`);
  const baselineBefore = await baselineRowHash(prisma);

  const storageKeys: string[] = [];
  let cleanup: (() => Promise<void>) | null = null;

  try {
    const org = await prisma.organization.create({ data: { name: `ITEST ${rand}`, code: orgCode } });
    const otherOrg = await prisma.organization.create({ data: { name: `ITEST ${rand} Other`, code: otherOrgCode } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const mkUser = (orgId: string, tag: string, role: UserRole, active = true) =>
      prisma.user.create({
        data: { organizationId: orgId, email: `${tag}@${orgCode.toLowerCase()}.example`, name: `ITEST ${tag}`, role, passwordHash, active },
      });
    const engA = await mkUser(org.id, "eng-a", UserRole.ENGINEER);
    const engB = await mkUser(org.id, "eng-b", UserRole.ENGINEER);
    const viewer = await mkUser(org.id, "viewer", UserRole.VIEWER);
    const disabled = await mkUser(org.id, "off", UserRole.ENGINEER, false);
    const engOther = await mkUser(otherOrg.id, "eng-other", UserRole.ENGINEER);

    const actorA = { userId: engA.id, organizationId: org.id, role: UserRole.ENGINEER, name: engA.name, email: engA.email };

    const doc = await prisma.cadDocument.create({
      data: {
        organizationId: org.id,
        documentNumber: `${orgCode}-PART`,
        fileName: `${orgCode}-part.ipt`,
        documentType: "IPT",
        createdById: engA.id,
      },
    });
    const v1Bytes = randomBytes(5120);
    const v1 = await storeCadFileVersionForActor(
      actorA, doc.id, Readable.from(v1Bytes), doc.fileName, maxBytes, prisma, provider,
    );
    storageKeys.push(v1.storageKey);

    cleanup = async () => {
      const fvs = await prisma.fileVersion.findMany({
        where: { organizationId: { in: [org.id, otherOrg.id] } },
        select: { storageKey: true },
      });
      await prisma.cadCheckoutEvent.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.cadCheckout.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.cadDependency.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.itemRevisionDocument.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.itemRevision.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.item.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.desktopSession.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } });
      for (const k of [...storageKeys, ...fvs.map((f) => f.storageKey)]) {
        try { await provider.delete(k); } catch { /* best effort */ }
      }
      await pruneEmptyStorageDirs();
    };

    // ---- tokens -------------------------------------------------------
    const tokA = await login(engA.email, PASSWORD);
    const tokB = await login(engB.email, PASSWORD);
    const tokViewer = await login(viewer.email, PASSWORD);
    const tokOther = await login(engOther.email, PASSWORD);
    check("ENGINEER-A / B / VIEWER / other-org bearer tokens minted", !!(tokA && tokB && tokViewer && tokOther));
    check("deactivated user login -> 401", (await loginStatus(disabled.email, PASSWORD)) === 401);
    check("unauthenticated checkout -> 401", (await api(`/api/cad-documents/${doc.id}/checkout`, { method: "POST" })).status === 401);

    // ---- Authorization header must NEVER fall through to cookie ------
    const url = `/api/cad-documents/${doc.id}/checkout`;
    const authReject = async (label: string, header: string): Promise<void> => {
      // P4C write route
      const co = await fetch(new URL(url, SERVER), { method: "POST", headers: { authorization: header }, redirect: "manual" });
      // P4B read routes (resolveApiActor is shared)
      const plan = await fetch(new URL(`/api/cad-documents/${doc.id}/workspace-plan`, SERVER), { headers: { authorization: header }, redirect: "manual" });
      const content = await fetch(new URL(`/api/file-versions/${v1.fileVersionId}/content`, SERVER), { headers: { authorization: header }, redirect: "manual" });
      check(`${label} -> checkout/plan/content all reject (no cookie fall-through)`,
        [co.status, plan.status, content.status].every((s) => s === 400 || s === 401),
        `${co.status} / ${plan.status} / ${content.status}`);
    };
    await authReject("malformed scheme 'Basic abc'", "Basic abc");
    await authReject("Bearer non-Arch token", "Bearer not-an-arch-token");
    await authReject("Bearer empty", "Bearer ");
    await authReject("Bearer arch_dt_bogus (well-formed, unknown)", "Bearer arch_dt_thisisnotarealtoken");

    // ---- a VALID browser cookie must NOT rescue a bad Authorization header
    try {
      const cookieSession = await loginWithCredentials(SERVER, engA.email, PASSWORD);
      const cookieHeaders = cookieSession.authHeaders() as Record<string, string>;
      // sanity: the cookie alone is a working browser session
      check("cookie-only workspace-plan (browser path) -> 200",
        (await fetch(new URL(`/api/cad-documents/${doc.id}/workspace-plan`, SERVER), { headers: cookieHeaders, redirect: "manual" })).status === 200);

      const cookieAuthReject = async (label: string, authHeader: string): Promise<void> => {
        const co = await fetch(new URL(url, SERVER), {
          method: "POST", headers: { ...cookieHeaders, authorization: authHeader }, redirect: "manual",
        });
        const plan = await fetch(new URL(`/api/cad-documents/${doc.id}/workspace-plan`, SERVER), {
          headers: { ...cookieHeaders, authorization: authHeader }, redirect: "manual",
        });
        check(`valid cookie + ${label} -> P4C write AND P4B read both reject (no cookie fall-through)`,
          [co.status, plan.status].every((s) => s === 400 || s === 401),
          `${co.status} / ${plan.status}`);
      };
      await cookieAuthReject("Authorization: Basic abc", "Basic abc");
      await cookieAuthReject("Authorization: Bearer not-an-arch-token", "Bearer not-an-arch-token");
      await cookieAuthReject("Authorization: Bearer <empty>", "Bearer ");
      await cookieAuthReject("invalid/revoked arch_dt token", "Bearer arch_dt_revoked000000000000000000000000");
    } catch (error) {
      check("valid cookie + malformed Authorization rejection", false, (error as Error).message);
    }

    check("valid bearer + a garbage cookie -> bearer still wins",
      (await api(`/api/cad-documents/${doc.id}/checkout`, {
        method: "POST", token: tokA!, headers: { cookie: "next-auth.session-token=garbage" },
      })).status === 201);
    // reset: A now holds the checkout, undo it so the ordered assertions below start clean
    await api(`/api/cad-documents/${doc.id}/checkout/undo`, { method: "POST", token: tokA!, headers: { "content-type": "application/json" }, body: "{}" });

    // ---- checkout (bearer) -----------------------------------------
    const co1 = await api(url, { method: "POST", token: tokA! });
    const co1b = await co1.json();
    check("checkout by A -> 201 created", co1.status === 201 && co1b?.status === "created", jsonStable(co1b));
    check("checkout base is V1", co1b?.checkout?.baseFileVersionId === v1.fileVersionId, jsonStable(co1b?.checkout));

    const co2 = await api(url, { method: "POST", token: tokA! });
    const co2b = await co2.json();
    check("checkout by A again -> 200 already-mine", co2.status === 200 && co2b?.status === "already-mine");

    const co3 = await api(url, { method: "POST", token: tokB! });
    const co3b = await co3.json();
    check("checkout by B -> 409 conflict", co3.status === 409);
    check("409 names holder A (name/email only, no id-less leak of other data)",
      co3b?.checkout?.checkedOutBy?.email === engA.email && co3b?.checkout?.checkedOutBy?.name === engA.name, jsonStable(co3b));

    const st = await api(url, { token: tokB! });
    const stb = await st.json();
    check("GET status by B -> locked", st.status === 200 && stb?.state === "locked");

    check("VIEWER checkout -> 403", (await api(url, { method: "POST", token: tokViewer! })).status === 403);
    check("cross-tenant checkout -> 404", (await api(url, { method: "POST", token: tokOther! })).status === 404);

    // ---- check-in (bearer) ---------------------------------------
    const v2Bytes = Buffer.concat([randomBytes(6144), Buffer.from("EDIT")]);
    const ci = await api(`/api/cad-documents/${doc.id}/checkin`, {
      method: "POST",
      token: tokA!,
      headers: { "content-type": "application/octet-stream", "x-original-filename": doc.fileName },
      body: v2Bytes,
    });
    const cib = await ci.json();
    check("check-in by A -> 201", ci.status === 201, jsonStable(cib));
    check("new version is V2", cib?.versionNumber === v1.versionNumber + 1, `got ${cib?.versionNumber}`);
    check("returned checksum == sha256(uploaded bytes)", cib?.checksum === sha256Hex(v2Bytes), jsonStable({ got: cib?.checksum, want: sha256Hex(v2Bytes) }));
    check("returned fileSize == uploaded byte length", Number(cib?.fileSize) === v2Bytes.length, `got ${cib?.fileSize}`);
    const v2Id: string = cib?.fileVersionId;

    const content = await api(`/api/file-versions/${v2Id}/content`, { token: tokA! });
    const got = Buffer.from(await content.arrayBuffer());
    check("V2 content -> 200 exact bytes", content.status === 200 && got.equals(v2Bytes));
    check("V2 X-Content-SHA256 == uploaded sha", content.headers.get("x-content-sha256") === sha256Hex(v2Bytes));

    check("check-in again by A -> 409 not-checked-out", (await api(`/api/cad-documents/${doc.id}/checkin`, {
      method: "POST", token: tokA!, headers: { "content-type": "application/octet-stream" }, body: randomBytes(1024),
    })).status === 409);

    // B re-checks-out, A tries to check in -> owned-by-another
    check("checkout by B after A's check-in -> 201", (await api(url, { method: "POST", token: tokB! })).status === 201);
    check("check-in by A (not owner) -> 409", (await api(`/api/cad-documents/${doc.id}/checkin`, {
      method: "POST", token: tokA!, headers: { "content-type": "application/octet-stream" }, body: randomBytes(1024),
    })).status === 409);
    check("VIEWER check-in -> 403", (await api(`/api/cad-documents/${doc.id}/checkin`, {
      method: "POST", token: tokViewer!, headers: { "content-type": "application/octet-stream" }, body: randomBytes(1024),
    })).status === 403);

    // ---- undo (bearer) -----------------------------------------
    const undo = await api(`/api/cad-documents/${doc.id}/checkout/undo`, {
      method: "POST", token: tokB!, headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "itest" }),
    });
    const undob = await undo.json();
    check("undo by B -> 200", undo.status === 200);
    check("undo returns base == V2", undob?.baseFileVersionId === v2Id, jsonStable(undob));
    check("checkout row gone after undo", (await prisma.cadCheckout.count({ where: { cadDocumentId: doc.id } })) === 0);

    // ---- audit -----------------------------------------------
    const events = await prisma.cadCheckoutEvent.findMany({ where: { cadDocumentId: doc.id }, select: { eventType: true } });
    const count = (t: string) => events.filter((e) => e.eventType === t).length;
    // Sequence this run produces: CHECKED_OUT (bearer-vs-cookie probe) + UNDO_CHECKOUT (reset)
    // + CHECKED_OUT (A) + CHECKED_IN (A) + CHECKED_OUT (B) + UNDO_CHECKOUT (B).
    check("audit: 3x CHECKED_OUT", count("CHECKED_OUT") === 3, jsonStable(events.map((e) => e.eventType)));
    check("audit: 1x CHECKED_IN", count("CHECKED_IN") === 1);
    check("audit: 2x UNDO_CHECKOUT", count("UNDO_CHECKOUT") === 2);
    check("audit: no ADMIN_UNLOCK", count("ADMIN_UNLOCK") === 0);

    // ---- cookie-path parity ----------------------------------
    try {
      const sessionA = await loginWithCredentials(SERVER, engA.email, PASSWORD);
      const cookieHeaders = sessionA.authHeaders() as Record<string, string>;
      const cCheckout = await fetch(new URL(url, SERVER), { method: "POST", headers: cookieHeaders, redirect: "manual" });
      const cBody = await cCheckout.json();
      check("cookie checkout -> 201 with { status, checkout }", cCheckout.status === 201 && cBody?.status === "created" && !!cBody?.checkout?.baseFileVersionId, jsonStable(cBody));
      const cUndo = await fetch(new URL(`/api/cad-documents/${doc.id}/checkout/undo`, SERVER), {
        method: "POST", headers: { ...cookieHeaders, "content-type": "application/json" }, body: "{}", redirect: "manual",
      });
      const cUndoBody = await cUndo.json();
      check("cookie undo -> 200 with { baseFileVersionId }", cUndo.status === 200 && !!cUndoBody?.baseFileVersionId);
    } catch (error) {
      check("cookie-path parity", false, (error as Error).message);
    }

    // ---- baseline unchanged ---------------------------------
    check("no collateral writes to non-ITEST rows", (await baselineRowHash(prisma)) === baselineBefore);
  } finally {
    if (cleanup) {
      try {
        await cleanup();
        console.log("  ok   ITEST rows + objects cleaned up");
      } catch (error) {
        failed++;
        console.log(`  FAIL cleanup — ${(error as Error).message}`);
      }
    }
    check("ARCH baseline row-hash unchanged after cleanup", (await baselineRowHash(prisma)) === baselineBefore);
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("integration gate crashed:", error);
  process.exit(1);
});
