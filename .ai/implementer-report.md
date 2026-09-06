# Implementer Report

Status: COMPLETE
<!-- Status: NOT STARTED | IN PROGRESS | COMPLETE -->

- Milestone:   P4B-1  (Real Get Latest from Autodesk Inventor)
- Task type:   feature (coordinated - two repos)
- Base HEAD:   web 23533e8 · inventor 53ba562
- Date:        2026-09-06

## 1. Summary

`ARCH ENGINEERING > Get Latest` now performs a real, authenticated,
version-pinned Get Latest. The Inventor add-in resolves an explicit root
document number to a stable `cadDocumentId`, fetches the existing P3B
workspace plan over a P4A bearer session, downloads the exact pinned
FileVersions (size + SHA-256 verified, streamed, never buffered), materializes
a flat managed workspace without ever overwriting a user file, and writes
`.arch/workspace.json` atomically only for what it actually verified. The
server side adds bearer auth on two existing read endpoints plus one small
tenant-scoped resolve endpoint - no business logic, no schema change.

## 2. Files changed

### web (server) - all diffs independently reviewable, cookie/browser path untouched

| File | Change |
|---|---|
| `app/lib/api-actor.ts` | `resolveApiActor(request)` now enforces the P4A transport protection for a `Bearer` request (`assertRequestTransportAllowed`) before resolving the desktop session; re-exports `DesktopAuthError`. Cookie path unchanged - still `getActor()` when no bearer header. |
| `app/api/cad-documents/[cadDocumentId]/workspace-plan/route.ts` | `GET(request, ctx)` passes `request` to `resolveApiActor`; catches `DesktopAuthError` -> `{status}`. Same `getWorkspacePlanHttpResult(actor, id)` call, same body, same headers. |
| `app/api/file-versions/[fileVersionId]/content/route.ts` | Same bearer adaptation; still `401` on null actor; streaming + `X-Content-SHA256` + `Content-Length` unchanged. |
| `app/lib/desktop-cad-documents-core.ts` (new) | Pure: `parseCadDocumentQuery` (exactly one of `documentNumber` / `cadDocumentId`, `<= 200` chars, never echoes the value), `DesktopCadDocError`, `ResolvedCadDocumentDto`, contract id `arch-plm.desktop-cad-document.v1`. |
| `app/lib/desktop-cad-documents-db.ts` (new) | Prisma-shaped, not `server-only`. `resolveCadDocumentForActor` - tenant-scoped `cadDocument.findFirst` by number or id; cross-tenant / unknown -> `DesktopCadDocError(404)` with a fixed message. `desktopResolveHttpResult` -> `{status, body}` (401 no actor). |
| `app/lib/desktop-cad-documents.ts` (new) | `server-only` shim supplying real `prisma`. |
| `app/api/desktop/cad-documents/resolve/route.ts` (new) | `GET` -> transport check -> `resolveApiActor` -> `desktopResolveHttpResult`; `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `Cache-Control: private, no-store`. |
| `tests/desktop-cad-documents-db.test.ts` (new) | 9 tests: parse bounds / exactly-one / no-echo; resolve by number; resolve by id re-validates tenant; cross-tenant 404 no leak; unknown 404; no actor 401; VIEWER 200. |
| `scripts/itest-p4b-get-latest.ts` (new) | Disposable live gate (see §5). Added `npm run itest:p4b-get-latest`. |
| `get-latest/route.ts` | **Deliberately left cookie-only** in P4B. Follow-up if/when a desktop Get-Latest-manifest call is needed directly. |

### inventor (CAD Connect) - Core has no Inventor/COM/HTTP; Api has no COM

| File | Change |
|---|---|
| `Core/Workspace/WorkspacePlan.cs` (new) | Records mirroring the server `WorkspacePlan` JSON + `WorkspacePlanContract` (id `arch-plm.cad-workspace-plan`, `1.0.0`, `HasValidShape`). |
| `Core/Workspace/SafeWorkspacePath.cs` (new) | Port of `assertSafeWorkspacePath` + P3B-2B materialization rules: FLAT filename only, reject nested / traversal / absolute / drive / reserved device names / bad segments; Windows case-insensitive containment under an absolute root. |
| `Core/Workspace/MaterializationReport.cs` (new) | `MaterializationStatus` (Downloaded / AlreadyCurrent / Blocked / Failed), per-entry result, summary, `ReachedValidState`, `ToSummaryLine()`. |
| `Core/Workspace/GetLatestRequest.cs` (new) | `CadDocumentLookup` (ByNumber / ById + `QueryParameter`), `ResolvedCadDocument`, `GetLatestRequest { Root, WorkspaceRoot }`. |
| `Core/Workspace/WorkspaceManifest.cs` (new) | `.arch/workspace.json` schema `arch-plm.workspace-manifest.v1`. `LoadOrEmpty` (corrupt/missing -> empty, never throws), `ApplyRun` (Verified only for size+SHA-verified this run; Blocked/Failed with a prior binding -> downgraded to Unverified, identity kept; no prior -> nothing written; other paths preserved), `SaveAtomic` (temp + move), `FindByAbsolutePath` (exact `root + relativePath`, never by filename). |
| `Core/Workspace/WorkspaceBindingResolver.cs` (new) | Given an absolute path + known workspace roots -> `PlmIdentity` + manifest state, or null. Only an exact manifest match; never filename inference. |
| `Api/Workspace/IContentDownloader.cs` + `HttpContentDownloader.cs` (new) | Port of `http-content-downloader.ts`. Only the exact `/api/file-versions/{id}/content` shape against the server origin; refuses ALL 3xx; rejects non-2xx; one timeout across headers + the whole streamed body; origin-bound bearer; no cookies, no auto-redirect. |
| `Api/Workspace/WorkspacePlanClient.cs` (new) | Port of `workspace-plan-client.ts`: origin -> no-redirect -> 2xx -> shape -> contract id -> supported version -> `safe === true`, else `UnsafeWorkspacePlanException(problems)`. |
| `Api/Workspace/WorkspaceMaterializer.cs` (new) | Port of `workspace-materialize-core.ts`: cross-entry case-insensitive collision pre-pass; per entry validate contentPath + safe path, existing-file compare (same sha+size -> AlreadyCurrent, differ -> Blocked "local-conflict", never overwritten), stage to `.arch/.staging/*.part` with incremental SHA-256 + size cap, verify size AND sha256, atomic exclusive-create promote. |
| `Api/Workspace/GetLatestOrchestrator.cs` (new) | resolve -> fetch+validate plan -> materialize -> **then** load+`ApplyRun`+`SaveAtomic` the manifest inside a best-effort catch. Manifest touched only after a completed materialization (PM control 1). `ResolveViaHttpAsync` for the resolve endpoint. |
| `Api/IArchApi.cs` + `ArchApiClient.cs` | Added `ResolveCadDocumentAsync` + `GetLatestAsync` (real); removed `GetLatestResultDto`; P4C write ops still throw `NotImplemented`. |
| `Api/ArchConnectionManager.cs` | `GetLatestAsync(request, ct)` - requires a session; a mid-op auth failure transitions the connection to `Unauthorized` and rethrows. |
| `Core/Ribbon/ArchCommand.cs` | `IsImplementedInP4A` -> `IsImplemented`; `GetLatest` is now implemented; new tooltip; "not implemented" wording softened. |
| `Core/Ribbon/RibbonCommandPolicy.cs` | `GetLatest` enabled iff `ConnectionState == Connected` (no open document required). Checkout / CheckIn / UndoCheckout / info commands still disabled. |
| `Inventor/Ui/GetLatestDialog.cs` (new) | Root document-number field + workspace folder picker; validates a full path; remembers the folder (non-secret) in `ConnectSettings.LastWorkspaceRoot`. |
| `Inventor/Ui/ConnectSettings.cs` + `SignInDialog.cs` | Added `LastWorkspaceRoot`; sign-in now merges rather than overwrites settings. |
| `Inventor/ArchAddInController.cs` | `GetLatest` -> dialog -> `RunBackground` (15-min budget) -> `_connection.GetLatestAsync` -> refresh the active document + ribbon -> modal summary (`ToSummaryLine()` + every blocked/failed entry + reason). Maps `UnsafeWorkspacePlanException` / `UnsupportedWorkspaceContractException` / `WorkspaceRootException` to controlled messages. |
| `Inventor/Documents/DocumentContextFactory.cs` + `InventorDocumentObserver.cs` | Populate `CadDocumentContext.PlmIdentity` via `WorkspaceBindingResolver` against the known workspace roots; unmanaged files stay unmanaged. |
| test files | `Core.Tests/Ribbon/RibbonCommandPolicyTests.cs`, `Core.Tests/Workspace/{SafeWorkspacePath,WorkspaceManifest,WorkspaceBindingResolver}Tests.cs`, `Api.Tests/Workspace/{FakeContentDownloader,HttpContentDownloader,WorkspacePlanClient,WorkspaceMaterializer,GetLatestOrchestrator,WorkspaceTestSession}Tests.cs`, `Api.Tests/ArchApiClientGetLatestTests.cs`; P4A fakes updated for the `IArchApi` change. |

## 3. Implementation notes

- **No Prisma migration.** `CadDocument` already has `documentNumber` /
  `fileName` / `documentType` and `@@unique([organizationId, documentNumber])`.
  Resolve is a pure read; bearer is authz only. Nothing in `prisma/` changed.
- **Identity binding is truthful (PM control 2).** `documentNumber` is only a
  bootstrap selection: server resolves `organization + documentNumber ->
  cadDocumentId`, and from then on `cadDocumentId` is authoritative. An
  already-managed file is bound only through an exact `root + relativePath`
  match in the verified manifest - never re-inferred from a filename.
- **Manifest atomicity (PM control 1).** `GetLatestOrchestrator` calls
  `WorkspaceManifest.ApplyRun` + `SaveAtomic` only after `MaterializeAsync`
  returns. If the plan is refused or materialization throws, the manifest is
  not opened. A Blocked/Failed entry never keeps a "current" claim - it is
  downgraded to `Unverified` (identity kept) or not written at all.
- **Transport protections retained (P4A).** Bearer requests: origin-bound
  token, `AllowAutoRedirect = false`, `UseCookies = false`, ALL 3xx refused,
  one timeout across headers + body. `assertRequestTransportAllowed` on the
  server uses only `new URL(request.url)` - no forwarded headers.
- **One timeout deviation, documented in code:** the C# content downloader
  uses a 5-minute transfer budget (vs the CLI's 30s) because a real CAD
  assembly binary is far larger than the CLI's test fixtures; the controller
  wraps the whole Get Latest in a 15-minute budget.
- **Reuse, not duplication.** The server closure / version-resolution /
  plan-safety logic is untouched and reached only through the API. The C#
  materializer / downloader / plan client are test-for-test ports of the P3B
  reference client in `web/cli` + `web/app/lib`.

## 4. Out of scope / deferred

- No P4C checkout / check-in / undo. No P5 reference scanner / `.ipj` repair.
  No Copy Design / BOM / change management. No auto-open of retrieved files.
- No nested workspace folders (FLAT only this milestone).
- `get-latest/route.ts` left cookie-only (follow-up noted above).
- `Status` ribbon command still shows `Unknown`; wiring the
  manifest-derived `MANAGED <n> vN` / `UNMANAGED` string into the Information
  panel is a small follow-up (the identity is already on
  `CadDocumentContext.PlmIdentity`).

## 5. Validation results

### web

| Command | Result |
|---|---|
| `npm test` | 327 passed / 0 failed |
| `npm run lint` | clean |
| `npm run build` | compiled + type-checked OK (18 routes, incl. `/api/desktop/cad-documents/resolve`) |
| `git diff --check` | clean (only pre-existing LF/CRLF advisory warnings) |
| `npx prisma validate` | valid |
| `npx prisma migrate status` | up to date - 13 migrations, no new migration |

### inventor

| Command | Result |
|---|---|
| `dotnet restore` | ok |
| `dotnet build` (clean) | Build succeeded - 0 Warning(s), 0 Error(s) (`TreatWarningsAsErrors=true`) |
| `dotnet test` | Core.Tests 121 passed / 0 · Api.Tests 79 passed / 0 (200 total) |

### disposable integration gate - `npm run itest:p4b-get-latest`

Ran against `npm run dev` + the real DB + `.pdm-storage`. Throwaway
`ITEST-<rand>` org, ENGINEER + VIEWER + deactivated user, an Item + a 5-node
CAD graph (root .iam -> part-a.ipt -> nested-c.ipt; root -> part-b.ipt;
root --DRAWING_REFERENCE--> drawing.idw), real `randomBytes` binaries stored
through `storeCadFileVersionForActor` (server-generated keys).

**32 checks passed / 0 failed**, including: bearer login (ENGINEER + VIEWER);
resolve response carries the `arch-plm.desktop-cad-document.v1` contract + all
identity display fields; deactivated login -> 401; unauthenticated plan -> 401;
resolve-by-number -> authoritative `cadDocumentId`; cross-tenant resolve + plan
-> 404 (no leak); plan contract shape + `safe:true` + all 5 pinned entries;
content bytes exact, `sha256 == X-Content-SHA256 == plan checksum`,
`Content-Length` exact; VIEWER may read plan + content; **cookie-path plan
identical to the bearer plan** (modulo the `generatedAt` timestamp); a
corrupted stored object -> content `500` (never served); non-ITEST
`CadDocument` / `FileVersion` row-hash **unchanged** before/during/after;
FK-safe cleanup of every ITEST row + every uploaded object + empty dirs
verified.

### C# orchestrator integration test (in `dotnet test`)

`GetLatestOrchestratorTests` + `ArchApiClientGetLatestTests` drive the full
resolve -> plan -> content -> materialize -> manifest path against a scripted
`HttpMessageHandler` into a temp dir: end-to-end materialize + manifest;
re-run -> all AlreadyCurrent (no content requests); unsafe plan -> manifest
untouched (byte-compared); resolve 404 -> `NotFound`, no `.arch`; 401 on the
plan -> clean abort, nothing downloaded; local-conflict on re-run -> Blocked +
downgrade to Unverified without overwriting.

## 6. Known limitations / risks

- **Manual Inventor 2025 acceptance NOT performed** during initial
  implementation - no Inventor install in that environment. The ribbon /
  dialog / controller code compiles clean against the Inventor interop and all
  COM-free logic is unit-tested, but the end-user click-path had not been
  exercised in Inventor at report time.
- The integration gate needs a running dev server; it is not part of
  `npm test` (by design - it writes to the real DB/storage, then cleans up).
- `WorkspaceBindingResolver` reads `.arch/workspace.json` on every document
  activate. The file is tiny and the read is wrapped, but on a very slow
  network drive this is a synchronous-ish cost on the UI thread; acceptable
  for P4B, worth revisiting if it ever grows.

## 7. Git status

Nothing committed, nothing pushed in either repo. `.ai/implementer-task.md` /
`.ai/milestone.md` were already modified by the planning/approval steps.

### inventor

```
 M src/Arch.CadConnect.Api/ArchApiClient.cs
 M src/Arch.CadConnect.Api/ArchConnectionManager.cs
 M src/Arch.CadConnect.Api/IArchApi.cs
 M src/Arch.CadConnect.Core/Ribbon/ArchCommand.cs
 M src/Arch.CadConnect.Core/Ribbon/RibbonCommandPolicy.cs
 M src/Arch.CadConnect.Inventor/ArchAddInController.cs
 M src/Arch.CadConnect.Inventor/Documents/DocumentContextFactory.cs
 M src/Arch.CadConnect.Inventor/Documents/InventorDocumentObserver.cs
 M src/Arch.CadConnect.Inventor/Ui/ConnectSettings.cs
 M src/Arch.CadConnect.Inventor/Ui/SignInDialog.cs
 M tests/Arch.CadConnect.Api.Tests/ArchApiClientTests.cs
 M tests/Arch.CadConnect.Api.Tests/ArchConnectionManagerTests.cs
?? src/Arch.CadConnect.Api/Workspace/
?? src/Arch.CadConnect.Core/Workspace/
?? src/Arch.CadConnect.Inventor/Ui/GetLatestDialog.cs
?? tests/Arch.CadConnect.Api.Tests/ArchApiClientGetLatestTests.cs
?? tests/Arch.CadConnect.Api.Tests/Workspace/
?? tests/Arch.CadConnect.Core.Tests/Ribbon/
?? tests/Arch.CadConnect.Core.Tests/Workspace/
```

### web

```
 M .ai/implementer-report.md
 M .ai/implementer-task.md
 M .ai/milestone.md
 M app/api/cad-documents/[cadDocumentId]/workspace-plan/route.ts
 M app/api/file-versions/[fileVersionId]/content/route.ts
 M app/lib/api-actor.ts
 M package.json
?? app/api/desktop/cad-documents/
?? app/lib/desktop-cad-documents-core.ts
?? app/lib/desktop-cad-documents-db.ts
?? app/lib/desktop-cad-documents.ts
?? scripts/itest-p4b-get-latest.ts
?? tests/desktop-cad-documents-db.test.ts
```

## 8. Codex final fixes (2026-09-06)

Two review findings addressed. inventor repo only - no server file changed.

### 8.1 Staging-cleanup design (MEDIUM)

**Before:** `WorkspaceMaterializer.StageDownloadAsync` removed the staged
`.part` file only on the oversized-response path. A source read fault, a
destination write / flush fault, or a stream-disposal fault left the entry
reported `Failed` but the `.part` file orphaned in `.arch\.staging\`.

**After:** `StageDownloadAsync` opens the content stream, then runs the whole
stage-and-hash in a `try` whose single `catch` (catch-all) removes the staged
`.part` file and rethrows. The content stream is disposed *explicitly inside
that guarded region* (`await source.DisposeAsync()` before the successful
`return`), so a disposal fault is handled exactly like a read fault. A second
best-effort dispose in the catch, and `TryDelete` (now swallows *every*
exception), guarantee cleanup never masks the original download / integrity
error. The oversized branch just `throw`s now - the same `catch` cleans up.
A fully successful stage returns the `.part` path unchanged for the caller's
verify + atomic exclusive-create promotion, which consumes it; the existing
`finally { TryDelete(stagedPath); }` around the verify/promote step is
untouched.

**Failure paths now covered (all delete the staged file, none promote a
partial):** source read fault mid-stream · source stream disposal fault ·
oversized response (size cap) · truncated response (size check) · same-size
wrong-checksum (SHA check) · a cleanup that itself cannot delete (original
error still surfaces) · cancellation.

### 8.2 Resolve-response contract validation (LOW)

**Before:** `GetLatestOrchestrator.ResolveViaHttpAsync` accepted any 2xx
resolve body with a non-empty `cadDocumentId`.

**After:** it now requires the exact server contract
`arch-plm.desktop-cad-document.v1` (new `Core/Workspace` type
`DesktopCadDocumentContract`, mirroring `DESKTOP_CAD_DOC_CONTRACT` in
`web/app/lib/desktop-cad-documents-core.ts` - the version is embedded in the
id, there is no separate version field) **and** a non-blank
`cadDocumentId` / `documentNumber` / `fileName` / `cadType`. A missing /
unsupported / malformed response throws `ArchApiException(Server)` from inside
`RunAsync`'s first step - before any workspace-plan fetch, any content
download, or any manifest / workspace-file write. `cadDocumentId` remains the
only identity; `documentNumber` / `fileName` are validated-present but never
used as identity.

### 8.3 Tests added

- `Api.Tests/Workspace/WorkspaceMaterializerTests.cs` (+6): source-read fault ->
  no `.part`; source-dispose fault -> no `.part`; cleanup-failure does not mask
  the original error; every-failure-path aggregate leaves no `*.part`;
  successful download leaves the staging dir empty; (existing truncated /
  wrong-checksum / oversized tests gained a "no staging artifacts" assertion).
  Two fault-injecting `Stream` helpers.
- `Api.Tests/Workspace/GetLatestOrchestratorTests.cs` (+6): valid contract
  accepted; wrong contract / no contract / empty `cadDocumentId` / missing
  display fields / malformed JSON each rejected with **no** workspace-plan
  request, **no** content request, **no** `.arch` directory, **no** files
  written.
- `Core.Tests/Workspace/DesktopCadDocumentContractTests.cs` (new, +6).
- Existing orchestrator / client test fixtures updated to send the `contract`
  field the real server always sends.

### 8.4 Validation results (post-fix)

| Gate | Result |
|---|---|
| inventor `dotnet restore` / `build` / `test` | ok · 0 warnings · **200 passed / 0** (Core 121, Api 79) |
| web `npm test` / `lint` / `build` / `prisma validate` / `migrate status` / `diff --check` | 327/0 · clean · ok · valid · up to date · clean (no web file changed) |
| `npm run itest:p4b-get-latest` (disposable live gate) | **32 passed / 0** · ARCH baseline row-hash unchanged · cleanup verified |

### 8.5 Preserved (re-verified)

bearer + cookie server auth · tenant isolation · VIEWER reads · stable
`cadDocumentId` identity · exact pinned FileVersions · redirect rejection ·
full-transfer timeout · streaming (no whole-file buffering) · SHA-256 + size
verification before promote · local-conflict / no-overwrite · atomic
`.arch/workspace.json` update · failed run publishes no false manifest · P4A
auth · P3 Get Latest behavior. Nothing committed or pushed in either repo.
