/**
 * P4B disposable integration gate — REAL Get Latest over the desktop bearer.
 *
 * Not part of `npm test`. Needs a running dev server AND the real database +
 * local storage that server uses. Run from the `web/` directory:
 *
 *   1. terminal A:  npm run dev
 *   2. terminal B:  node --experimental-strip-types --env-file=.env \
 *                        scripts/itest-p4b-get-latest.ts
 *
 * What it does, end to end, against a throwaway `ITEST-<rand>` organization:
 *   - creates org + ENGINEER + VIEWER + a deactivated user
 *   - creates an Item + ItemRevision and a CAD graph:
 *       root .iam --COMPONENT--> part-a.ipt --COMPONENT--> nested-c.ipt
 *       root .iam --COMPONENT--> part-b.ipt
 *       root .iam --DRAWING_REFERENCE--> drawing.idw
 *   - uploads a real random binary for every document (server-generated keys)
 *   - mints a bearer token via POST /api/desktop/auth/login
 *   - asserts, over the bearer:
 *       resolve-by-number -> the authoritative cadDocumentId
 *       workspace-plan    -> contract shape, safe:true, all 5 entries pinned
 *       content           -> exact bytes, sha256 == X-Content-SHA256 == plan
 *       VIEWER may read the plan and the content
 *       a second org's bearer -> 404 for the first org's document (no leak)
 *       the deactivated user -> 401 at login
 *       a corrupted stored object -> content 500 (never served)
 *   - asserts the browser COOKIE path returns a byte-identical workspace plan
 *   - snapshots every non-ITEST CadDocument + FileVersion row hash before and
 *     after and asserts it is UNCHANGED (zero collateral writes)
 *   - FK-safe deletes every ITEST row, every uploaded object and empty dirs
 *
 * Security: never prints a token, cookie, password or storage path.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import bcrypt from "bcryptjs";

import { PrismaClient } from "../app/generated/prisma/client.ts";
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

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const jsonStable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

async function baselineRowHash(prisma: PrismaClient): Promise<string> {
  const notItest = { organization: { is: { code: { startsWith: "ITEST-" } } } };
  const docs = await prisma.cadDocument.findMany({
    where: { NOT: notItest },
    orderBy: { id: "asc" },
  });
  const fvs = await prisma.fileVersion.findMany({
    where: { NOT: notItest },
    orderBy: { id: "asc" },
  });
  return createHash("sha256")
    .update(jsonStable({ docs, fvs }))
    .digest("hex");
}

interface DocSpec {
  key: "root" | "partA" | "partB" | "drawing" | "nestedC";
  documentNumber: string;
  fileName: string;
  documentType: "IAM" | "IPT" | "IDW";
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const provider = new LocalFilesystemStorage(resolveStorageRoot());
  const maxBytes = resolveMaxUploadBytes();

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  const otherOrgCode = `ITEST-${rand}X`;

  console.log(`P4B integration gate — org ${orgCode}, server ${SERVER}`);
  const baselineBefore = await baselineRowHash(prisma);

  const createdStorageKeys: string[] = [];
  let cleanup: (() => Promise<void>) | null = null;

  try {
    // ---- fixture: two orgs, users, item, CAD graph -----------------
    const org = await prisma.organization.create({
      data: { name: `Integration Test ${rand}`, code: orgCode },
    });
    const otherOrg = await prisma.organization.create({
      data: { name: `Integration Test ${rand} Other`, code: otherOrgCode },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const engineer = await prisma.user.create({
      data: { organizationId: org.id, email: `eng@${orgCode.toLowerCase()}.example`, name: "ITEST Engineer", role: "ENGINEER", passwordHash, active: true },
    });
    const viewer = await prisma.user.create({
      data: { organizationId: org.id, email: `view@${orgCode.toLowerCase()}.example`, name: "ITEST Viewer", role: "VIEWER", passwordHash, active: true },
    });
    const disabled = await prisma.user.create({
      data: { organizationId: org.id, email: `off@${orgCode.toLowerCase()}.example`, name: "ITEST Disabled", role: "ENGINEER", passwordHash, active: false },
    });
    const otherEngineer = await prisma.user.create({
      data: { organizationId: otherOrg.id, email: `eng@${otherOrgCode.toLowerCase()}.example`, name: "ITEST Other Engineer", role: "ENGINEER", passwordHash, active: true },
    });

    const engineerActor = {
      userId: engineer.id,
      organizationId: org.id,
      role: "ENGINEER" as const,
      name: engineer.name,
      email: engineer.email,
    };

    const item = await prisma.item.create({
      data: { organizationId: org.id, itemNumber: `${orgCode}-AS`, description: "ITEST assembly", type: "ASSEMBLY" },
    });
    const itemRevision = await prisma.itemRevision.create({
      data: { organizationId: org.id, itemId: item.id, revision: "A", lifecycle: "WORKING", createdById: engineer.id },
    });

    const specs: DocSpec[] = [
      { key: "root", documentNumber: `${orgCode}-ROOT`, fileName: "root.iam", documentType: "IAM" },
      { key: "partA", documentNumber: `${orgCode}-PART-A`, fileName: "part-a.ipt", documentType: "IPT" },
      { key: "partB", documentNumber: `${orgCode}-PART-B`, fileName: "part-b.ipt", documentType: "IPT" },
      { key: "drawing", documentNumber: `${orgCode}-DRW`, fileName: "drawing.idw", documentType: "IDW" },
      { key: "nestedC", documentNumber: `${orgCode}-PART-C`, fileName: "nested-c.ipt", documentType: "IPT" },
    ];

    const docs: Record<string, { id: string; bytes: Buffer; fileVersionId: string; checksum: string; size: number }> = {};

    for (const spec of specs) {
      const doc = await prisma.cadDocument.create({
        data: {
          organizationId: org.id,
          documentNumber: spec.documentNumber,
          fileName: spec.fileName,
          documentType: spec.documentType,
          createdById: engineer.id,
        },
      });
      await prisma.itemRevisionDocument.create({
        data: { organizationId: org.id, itemRevisionId: itemRevision.id, cadDocumentId: doc.id, createdById: engineer.id },
      });

      const bytes = randomBytes(4096 + Math.floor(Math.random() * 4096));
      const stored = await storeCadFileVersionForActor(
        engineerActor,
        doc.id,
        Readable.from(bytes),
        spec.fileName,
        maxBytes,
        prisma,
        provider,
      );
      createdStorageKeys.push(stored.storageKey);
      docs[spec.key] = {
        id: doc.id,
        bytes,
        fileVersionId: stored.fileVersionId,
        checksum: stored.checksum,
        size: stored.fileSize,
      };
    }

    // edges: root -> partA, root -> partB, root -> drawing, partA -> nestedC
    const edges: Array<[string, string, "COMPONENT" | "DRAWING_REFERENCE"]> = [
      ["root", "partA", "COMPONENT"],
      ["root", "partB", "COMPONENT"],
      ["root", "drawing", "DRAWING_REFERENCE"],
      ["partA", "nestedC", "COMPONENT"],
    ];
    for (const [parent, child, type] of edges) {
      await prisma.cadDependency.create({
        data: {
          organizationId: org.id,
          parentDocumentId: docs[parent].id,
          childDocumentId: docs[child].id,
          dependencyType: type,
          createdById: engineer.id,
        },
      });
    }

    cleanup = async () => {
      for (const key of createdStorageKeys) {
        try { await provider.delete(key); } catch { /* best effort */ }
      }
      await prisma.cadDependency.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.itemRevisionDocument.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.itemRevision.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.item.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.desktopSession.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } });
      await pruneEmptyStorageDirs();
    };

    // ---- bearer tokens ------------------------------------------------
    const engineerBearer = await login(engineer.email, PASSWORD);
    check("ENGINEER login mints a bearer", engineerBearer !== null);
    const viewerBearer = await login(viewer.email, PASSWORD);
    check("VIEWER login mints a bearer", viewerBearer !== null);
    const otherBearer = await login(otherEngineer.email, PASSWORD);

    check("deactivated user login is 401", (await loginStatus(disabled.email, PASSWORD)) === 401);
    check("unauthenticated workspace-plan is 401", (await api(`/api/cad-documents/${docs.root.id}/workspace-plan`)).status === 401);

    // ---- resolve ----------------------------------------------------
    const resolved = await api(
      `/api/desktop/cad-documents/resolve?documentNumber=${encodeURIComponent(specs[0].documentNumber)}`,
      engineerBearer!,
    );
    const resolvedBody = await resolved.json();
    check("resolve-by-number -> 200", resolved.status === 200);
    check("resolve response carries the desktop-cad-document.v1 contract", resolvedBody?.contract === "arch-plm.desktop-cad-document.v1", jsonStable(resolvedBody));
    check("resolve returns the authoritative cadDocumentId", resolvedBody?.cadDocumentId === docs.root.id, jsonStable(resolvedBody));
    check(
      "resolve returns the identity display fields",
      typeof resolvedBody?.documentNumber === "string" && resolvedBody.documentNumber.length > 0
        && typeof resolvedBody?.fileName === "string" && resolvedBody.fileName.length > 0
        && typeof resolvedBody?.cadType === "string" && resolvedBody.cadType.length > 0,
      jsonStable(resolvedBody),
    );

    check(
      "cross-tenant resolve -> 404 (no leak)",
      (await api(`/api/desktop/cad-documents/resolve?cadDocumentId=${docs.root.id}`, otherBearer!)).status === 404,
    );

    // ---- workspace-plan (bearer) ----------------------------------
    const planRes = await api(`/api/cad-documents/${docs.root.id}/workspace-plan`, engineerBearer!);
    const plan = await planRes.json();
    check("workspace-plan -> 200", planRes.status === 200);
    check("plan contract id", plan?.contract?.id === "arch-plm.cad-workspace-plan");
    check("plan contract version 1.0.0", plan?.contract?.version === "1.0.0");
    check("plan safe:true", plan?.safe === true, jsonStable(plan?.problems));
    check("plan has all 5 documents", Array.isArray(plan?.entries) && plan.entries.length === 5, `got ${plan?.entries?.length}`);

    const rootEntry = plan?.entries?.find((e: { isRoot?: boolean }) => e.isRoot);
    check("plan root entry is the resolved document", rootEntry?.cadDocumentId === docs.root.id);
    check("plan root version is pinned to the uploaded FileVersion", rootEntry?.version?.fileVersionId === docs.root.fileVersionId);
    check("plan root checksum matches the stored object", rootEntry?.version?.checksum === docs.root.checksum);
    check(
      "plan content path is the exact download shape",
      rootEntry?.version?.contentPath === `/api/file-versions/${docs.root.fileVersionId}/content`,
    );

    check(
      "cross-tenant workspace-plan -> 404",
      (await api(`/api/cad-documents/${docs.root.id}/workspace-plan`, otherBearer!)).status === 404,
    );

    // ---- content (bearer) ---------------------------------------
    const contentRes = await api(`/api/file-versions/${docs.root.fileVersionId}/content`, engineerBearer!);
    const contentBuf = Buffer.from(await contentRes.arrayBuffer());
    check("content -> 200", contentRes.status === 200);
    check("content bytes are exact", contentBuf.equals(docs.root.bytes));
    check("content sha256 == stored checksum", sha256Hex(contentBuf) === docs.root.checksum);
    check("X-Content-SHA256 header == plan checksum", contentRes.headers.get("x-content-sha256") === docs.root.checksum);
    check("Content-Length header == stored size", contentRes.headers.get("content-length") === String(docs.root.size));

    check(
      "content refuses a redirect (no 3xx ever)",
      !String((await api(`/api/file-versions/${docs.root.fileVersionId}/content`, engineerBearer!)).status).startsWith("3"),
    );

    // ---- VIEWER may read ---------------------------------------
    check("VIEWER workspace-plan -> 200", (await api(`/api/cad-documents/${docs.root.id}/workspace-plan`, viewerBearer!)).status === 200);
    check("VIEWER content -> 200", (await api(`/api/file-versions/${docs.partB.fileVersionId}/content`, viewerBearer!)).status === 200);

    // ---- cookie-path parity ----------------------------------
    // The two requests are generated at different instants, so the only
    // legitimate difference is the top-level `generatedAt` timestamp; every
    // identity, version, checksum, placement and problem must be identical.
    const stripVolatile = (p: unknown): string =>
      jsonStable({ ...(p as Record<string, unknown>), generatedAt: undefined });
    let cookiePlan: unknown = null;
    try {
      const cookieSession = await loginWithCredentials(SERVER, engineer.email, PASSWORD);
      const cookieRes = await fetch(new URL(`/api/cad-documents/${docs.root.id}/workspace-plan`, SERVER), {
        headers: cookieSession.authHeaders() as Record<string, string>,
        redirect: "manual",
      });
      cookiePlan = await cookieRes.json();
      check("cookie-path workspace-plan -> 200", cookieRes.status === 200);
    } catch (error) {
      check("cookie-path workspace-plan -> 200", false, (error as Error).message);
    }
    check(
      "cookie-path plan is identical to the bearer plan (modulo generatedAt)",
      cookiePlan !== null && stripVolatile(cookiePlan) === stripVolatile(plan),
    );

    // ---- corrupt stored object -> 500 ------------------------
    const corruptKey = createdStorageKeys.find((k) => k.includes(docs.partB.id))
      ?? createdStorageKeys[2];
    await writeFile(path.join(resolveStorageRoot(), corruptKey), randomBytes(docs.partB.size));
    const corruptRes = await api(`/api/file-versions/${docs.partB.fileVersionId}/content`, engineerBearer!);
    check("corrupted stored object -> content 500 (never served)", corruptRes.status === 500, `got ${corruptRes.status}`);

    // ---- baseline unchanged ----------------------------------
    const baselineDuring = await baselineRowHash(prisma);
    check("no collateral writes to non-ITEST CadDocument/FileVersion rows", baselineDuring === baselineBefore);
  } finally {
    if (cleanup) {
      try {
        await cleanup();
        console.log("  ok   ITEST rows + objects cleaned up");
      } catch (error) {
        console.log(`  FAIL cleanup — ${(error as Error).message}`);
        failed++;
      }
    }
    const baselineAfter = await baselineRowHash(prisma);
    check("ARCH baseline row-hash unchanged after cleanup", baselineAfter === baselineBefore);
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function pruneEmptyStorageDirs(): Promise<void> {
  const root = resolveStorageRoot();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name));
      }
    }
    try {
      const remaining = await readdir(dir);
      if (remaining.length === 0 && dir !== root) {
        await rm(dir, { recursive: false });
      }
    } catch { /* best effort */ }
  };
  if (await stat(root).then(() => true).catch(() => false)) {
    await walk(root);
  }
}

// ---- HTTP helpers ------------------------------------------------------

async function api(pathAndQuery: string, bearer?: string): Promise<Response> {
  return fetch(new URL(pathAndQuery, SERVER), {
    headers: bearer ? { authorization: `Bearer ${bearer}`, accept: "application/json" } : { accept: "application/json" },
    redirect: "manual",
  });
}

async function loginStatus(email: string, password: string): Promise<number> {
  const res = await fetch(new URL("/api/desktop/auth/login", SERVER), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, clientLabel: "p4b-itest" }),
    redirect: "manual",
  });
  return res.status;
}

async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch(new URL("/api/desktop/auth/login", SERVER), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, clientLabel: "p4b-itest" }),
    redirect: "manual",
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body?.token === "string" ? body.token : null;
}

main().catch((error) => {
  console.error("integration gate crashed:", error);
  process.exit(1);
});
