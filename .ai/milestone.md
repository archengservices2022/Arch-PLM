# Milestone

Status: IN REVIEW
<!-- Status: PLANNING | IN PROGRESS | IN REVIEW | GATED | DONE -->

- Milestone ID:   P4B-1
- Title:          Real Get Latest from Autodesk Inventor
- Repos:          web  (C:\Users\skota\ArchPLM\web)  +  inventor  (C:\Users\skota\ArchPLM\inventor)
- Stable HEAD:    web 23533e8 - Add local AI development workflow
                  inventor 53ba562 - Build Inventor CAD Connect foundation
- Date opened:    2026-09-06
- Date implemented: 2026-09-06

## Review note

Slices 1-10 implemented. Both validation gates green; the disposable
integration gate passes 30/0 with the ARCH baseline row-hash unchanged. See
`.ai/implementer-report.md`. ONE acceptance item is outstanding and cannot be
done in this environment: the manual Inventor 2025 click-path (ribbon ->
GetLatestDialog -> summary modal -> Status shows MANAGED). Nothing is
committed or pushed in either repo.

## Objective

Make `ARCH ENGINEERING > Get Latest` in the Inventor add-in perform a REAL
authenticated PDM Get Latest, reusing the existing P3B server pipeline:

    Inventor CAD Connect
      -> authenticated Arch PLM API (bearer session from P4A)
      -> resolve a managed CAD document by stable PLM identity
      -> GET the existing workspace-plan (version-pinned Get Latest package)
      -> download the exact pinned FileVersions (size + SHA-256 verified)
      -> safely materialize a managed local working-copy workspace
      -> report a truthful per-file result to the user

No new server business logic: the workspace-plan / Get Latest / dependency
closure / version resolution already exist and are tenant-safe. P4B adds
(a) bearer auth on the read endpoints, (b) one tiny document-resolve
endpoint, and (c) a faithful C# port of the P3B client path
(plan fetch + content download + safe materialization).

## Scope

Server (`web`) - minimal:
- Accept a P4A desktop bearer token on the read endpoints the client needs:
  `GET /api/cad-documents/:id/workspace-plan` and
  `GET /api/file-versions/:id/content` -> swap `getActor()` for the existing
  `resolveApiActor(request)` (bearer OR cookie; cookie behaviour unchanged).
- New endpoint `GET /api/desktop/cad-documents/resolve?documentNumber=<n>`:
  bearer-auth, tenant-scoped, VIEWER-ok, returns the authoritative
  `{ cadDocumentId, documentNumber, fileName, cadType }` or 404. Read-only.
- No change to `get-latest` route in P4B (client path uses `workspace-plan`);
  note it as an optional later adaptation.

CAD Connect (`inventor`) - the real work:
- `IArchApi.GetLatestAsync` implemented end to end.
- C# ports of the P3B reference client (see `web/cli/*` and
  `web/app/lib/workspace-materialize-core.ts`), same invariants:
  workspace-plan fetch + validation, origin-bound bearer content download
  (refuse ALL redirects, whole-transfer timeout), staged -> verify size +
  SHA-256 -> atomic non-overwriting promote, per-entry
  downloaded/already-current/blocked/failed report.
- Managed-identity binding (see design question below).
- Get Latest dialog: root document number + workspace folder picker.
- Ribbon: Get Latest enabled iff Connected; truthful result summary.
- `CadDocumentContext.PlmIdentity` populated from the workspace manifest.

## Design question - managed document identity binding

P4A leaves `CadDocumentContext.PlmIdentity` null. P4B's truthful first
mechanism (smallest safe, evolvable):

1. Root selection is EXPLICIT and server-verified: the user supplies the root
   CAD document NUMBER (or pastes a cadDocumentId). The client calls
   `/api/desktop/cad-documents/resolve` to get the authoritative id.
   documentNumber is unique per tenant (`@@unique([organizationId,
   documentNumber])`) - a lookup, NOT filename inference.
2. After materialization the client writes/merges
   `<workspaceRoot>/.arch/workspace.json` (schema
   `arch-plm.workspace-manifest.v1`) recording per file:
   `cadDocumentId, documentNumber, fileName, cadType, relativePath,
   fileVersionId, versionNumber, checksum, fileSize` plus
   `serverOrigin, organization, root, retrievedAtUtc`.
   A local file is bound to PLM identity because the CLIENT recorded it from
   a SERVER response - never because of its filename.
3. `CadDocumentContext.PlmIdentity` is filled when the active Inventor
   document's full path resolves to a `relativePath` in a known
   `.arch/workspace.json`. No match -> null -> UNMANAGED (truthful).
4. `.arch/` is a client-managed working-copy cache; the server stays
   authoritative. Future P4C/P5 read and extend this manifest (it can later
   carry real Inventor project-relative reference paths).

## Exclusions

- Do NOT modify Prisma schema or migrations (analysis: not required - see Notes).
- Do NOT change browser/cookie behaviour of any existing route.
- No P4C Checkout / Check-In / Undo Checkout implementation.
- No P5 Inventor dependency scanner / reference-repair / `.ipj` editing.
- No Copy Design. No BOM / change-management.
- No new infrastructure / microservices. No paid services.
- No nested-folder materialization (flat filename per entry, same as P3B-2B).
- No auto-open of retrieved files in Inventor. No write-back to the server.
- No Inventor 2026 runtime testing (design-validated only).
- Do NOT infer managed identity from the currently open filename.
- Do NOT overwrite or delete any existing user CAD file, ever.
- Do NOT test against production CAD files - disposable data/workspaces only.
- Do NOT create a root ArchPLM git repo. Do NOT commit or push.

## Acceptance criteria

- [ ] `workspace-plan` + `file-versions/content` routes accept a valid P4A
      bearer token (tenant-scoped, VIEWER-ok); cookie/browser responses
      byte-identical to HEAD.
- [ ] `/api/desktop/cad-documents/resolve` returns the authoritative
      cadDocumentId for a tenant document number; 404 otherwise; 401 without
      a valid token; input length bounded.
- [ ] No Prisma migration; `npx prisma validate` + `npx prisma migrate status`
      unchanged.
- [ ] C# Get Latest: resolve -> workspace-plan -> exact pinned downloads
      (size + SHA-256 verified before promote) -> materialized workspace ->
      `MaterializationReport`. Never overwrites a user file. `safe:false`
      plan is refused wholesale.
- [ ] `.arch/workspace.json` written/merged; identity binding works;
      `CadDocumentContext.PlmIdentity` populated for known-workspace files.
- [ ] Ribbon: Get Latest enabled iff Connected, runs the real op, shows a
      truthful summary (downloaded / already-current / blocked / failed +
      the blocked/failed list). PDM write buttons still disabled. No faked
      success anywhere.
- [ ] Error paths handled: unauthorized, server unavailable, unmanaged
      document, missing FileVersion / incomplete package, checksum mismatch,
      unsafe path, local conflict.
- [ ] Web gate green: npm test, npm run lint, npm run build, git diff --check,
      npx prisma validate, npx prisma migrate status.
- [ ] C# gate green: dotnet restore, dotnet build (0 warnings), dotnet test.
- [ ] Disposable-ITEST server live gate passes; ARCH baseline unchanged.
- [ ] Manual Inventor 2025 acceptance checklist completed and pasted into
      implementer-report.md.
- [ ] Nothing committed or pushed by the implementer, in either repo.

## Notes

### Reuse map (do NOT duplicate server logic)

| Need | Existing server code (reuse via API) |
|---|---|
| version-pinned Get Latest package | `app/lib/workspace-plan-db.ts` -> `getWorkspacePlanHttpResult(actor, id, ...)` (composes `get-latest-db.ts` + `workspace-plan-core.ts`); route `GET /api/cad-documents/:id/workspace-plan` |
| dependency closure + latest binary resolution + path-collision detection | inside the above (`get-latest-core.ts`, `file-version-resolution-core.ts`) |
| exact FileVersion byte stream + server-side SHA-256 verify | `app/lib/storage.ts` `readCadFileVersionForActor`; route `GET /api/file-versions/:id/content` (`X-Content-SHA256`, `Content-Length`) |
| bearer OR cookie actor resolution | `app/lib/api-actor.ts` `resolveApiActor(request)` (P4A) - already accepts `Authorization: Bearer arch_dt_...`; tenant + role re-derived server-side |
| tenant isolation / VIEWER read policy | `workspace-plan-db.ts` / `get-latest-db.ts` already scope every query by `actor.organizationId` and do NOT gate reads on write roles |

| Need | Reference client to PORT to C# (spec, not callable) |
|---|---|
| plan fetch + validation | `web/cli/workspace-plan-client.ts` |
| binary download (origin bind, no redirect, whole-transfer timeout, stream) | `web/cli/http-content-downloader.ts` |
| safe path resolution + materialization state machine | `web/app/lib/workspace-materialize-core.ts` (`resolveWithinWorkspaceRoot`, `materializeWorkspacePlan`, `LocalWorkspaceFs`) |
| safe-path rules | `web/app/lib/get-latest-core.ts` `assertSafeWorkspacePath` |
| orchestration shape | `web/cli/orchestrate-workspace-get.ts` `runWorkspaceGet` |

### Prisma migration required? NO.

`CadDocument` already has `documentNumber`, `fileName`, `documentType` and
`@@unique([organizationId, documentNumber])`. The resolve endpoint is a pure
tenant-scoped read. Bearer auth is transport/authz only. Nothing about P4B
needs a new column, table, index or enum. If implementation analysis proves
otherwise, STOP and escalate to the PM before touching `prisma/`.

### Files likely to change

web (small):
- `app/api/cad-documents/[cadDocumentId]/workspace-plan/route.ts` (getActor -> resolveApiActor)
- `app/api/file-versions/[fileVersionId]/content/route.ts` (getActor -> resolveApiActor)
- NEW `app/lib/desktop-cad-documents-core.ts` + `-db.ts` + `.ts` shim
- NEW `app/api/desktop/cad-documents/resolve/route.ts`
- NEW `tests/desktop-cad-documents-db.test.ts` (+ core)
- possibly extend an existing route/plan test to cover the bearer path

inventor (the bulk):
- NEW `src/Arch.CadConnect.Core/Workspace/` - `WorkspacePlan` DTOs,
  `SafeWorkspacePath`, `WorkspaceManifest`, `MaterializationReport`
- NEW `src/Arch.CadConnect.Api/Workspace/` - `WorkspacePlanClient`,
  `HttpContentDownloader`, `WorkspaceMaterializer`, `GetLatestOrchestrator`
- `src/Arch.CadConnect.Api/ArchApiClient.cs` - implement `GetLatestAsync`
  (resolve + orchestrate); add `ResolveDocumentAsync`
- `src/Arch.CadConnect.Api/IArchApi.cs` - real `GetLatestAsync` return type
  (a `MaterializationReport`, replacing the `GetLatestResultDto` stub)
- `src/Arch.CadConnect.Core/Ribbon/{ArchCommand,RibbonCommandPolicy}.cs` -
  GetLatest implemented-in-P4B, enabled iff Connected
- `src/Arch.CadConnect.Inventor/Ui/GetLatestDialog.cs` (NEW) + wiring in
  `ArchAddInController.cs`
- `src/Arch.CadConnect.Inventor/Documents/DocumentContextFactory.cs` +
  a Core `WorkspaceBindingResolver` - populate `PlmIdentity` from the manifest
- NEW tests under `tests/Arch.CadConnect.Core.Tests` and
  `tests/Arch.CadConnect.Api.Tests`
- NEW `scripts/` or `.ai`-referenced disposable ITEST live-gate script

### Major risks

1. Re-implementing the materializer/path rules in C# and drifting from the
   TS reference. Mitigation: port test-for-test; keep the same outcome enum
   and the same invariants; cross-check against `workspace-materialize-core.test.ts`.
2. Atomic non-overwriting create on Windows/NTFS in .NET (no direct
   `link()`); use `File.Open(FileMode.CreateNew)` or `File.Move` with an
   explicit exists check + retry, never `overwrite: true`.
3. Bearer-adapting shared routes without regressing the browser path.
   Mitigation: `resolveApiActor` already falls through to `getActor()` when
   no bearer header; add a test asserting cookie responses are unchanged.
4. Identity binding UX: users may expect "it just knows" from the open file.
   The manifest + explicit root number is the honest minimum; document it.
5. Timeout/stream semantics for large CAD binaries; reuse the P4A
   whole-exchange timeout pattern from `ArchApiClient`.
6. Coordinated two-repo change with no shared CI; the release gate must
   cover both repos' validation before DECISION.

### Implementation slices / order

1. web: bearer-adapt `workspace-plan` + `content` routes; test cookie
   unchanged + bearer works. (smallest, unblocks everything)
2. web: `/api/desktop/cad-documents/resolve` endpoint + tests.
3. inventor Core: `WorkspacePlan` DTOs + `SafeWorkspacePath` + tests
   (port `assertSafeWorkspacePath` + flat-only + containment).
4. inventor Api: `HttpContentDownloader` + `WorkspacePlanClient` + tests
   (fake `HttpMessageHandler`).
5. inventor Api: `WorkspaceMaterializer` + `MaterializationReport` + tests
   (temp dirs; all outcome cases).
6. inventor: `WorkspaceManifest` read/merge/write + `WorkspaceBindingResolver`
   + `PlmIdentity` population + tests.
7. inventor Api: `ArchApiClient.ResolveDocumentAsync` + `GetLatestAsync`
   orchestrator wiring `2-6`; `IArchApi` return type.
8. inventor UI/ribbon: `GetLatestDialog`, controller wiring, `RibbonCommandPolicy`.
9. Disposable-ITEST server live gate script; run it.
10. Manual Inventor 2025 acceptance; fill implementer-report.md.
