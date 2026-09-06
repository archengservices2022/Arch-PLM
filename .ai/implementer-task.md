# Implementer Task

Status: ASSIGNED
<!-- Status: NOT ASSIGNED | ASSIGNED | IN PROGRESS | DONE -->

- For milestone:  P4B-1  (Real Get Latest from Autodesk Inventor)
- Task type:      feature (coordinated - TWO repos)
- Working tree:   both repos must start CLEAN at the Stable HEADs in
                  milestone.md (web 23533e8, inventor 53ba562)

## Ask

Implement P4B exactly as defined in `.ai/milestone.md`: `ARCH ENGINEERING >
Get Latest` performs a real, authenticated, version-pinned Get Latest that
materializes a safe managed local workspace and reports a truthful per-file
result. Reuse the existing P3B server pipeline via the API; port (do not
duplicate) the P3B reference client path to C#.

Build it in the slices listed in the milestone ("Implementation slices /
order"), 1 -> 10. Do not start a later slice before its earlier dependency is
green.

## Plan coverage (the 15 required points, with concrete guidance)

1. **Existing P3B server APIs to reuse.** See milestone "Reuse map".
   Client path: `resolve` -> `GET /api/cad-documents/:id/workspace-plan` ->
   per entry `GET /api/file-versions/:id/content`. Never call `get-latest`
   directly (the plan already IS the pinned package). Never re-resolve
   "latest" mid-operation - fetch the plan once, hand it to the materializer
   unmodified.

2. **Minimal server API changes for bearer CAD Connect.**
   - `workspace-plan/route.ts` and `file-versions/[id]/content/route.ts`:
     `const actor = await resolveApiActor(request)` (pass `request`;
     un-underscore `_request`). Nothing else changes - both already take
     `actor: Actor | null`, scope by `actor.organizationId`, and do NOT gate
     reads on write roles (VIEWER-ok). `resolveApiActor` returns `getActor()`
     when there is no `Authorization: Bearer` header, so cookie/browser
     behaviour is untouched.
   - NEW `GET /api/desktop/cad-documents/resolve?documentNumber=<n>`
     (also accept `?cadDocumentId=<id>` as an identity passthrough that just
     validates tenant ownership). Pure read: `resolveApiActor` -> 401;
     `prisma.cadDocument.findFirst({ where: { organizationId:
     actor.organizationId, documentNumber } , select: { id, documentNumber,
     fileName, documentType } })` -> `{ cadDocumentId, documentNumber,
     fileName, cadType }` or 404. Bound `documentNumber` length (<= 200),
     reject empty. Follow the P4A module shape:
     `desktop-cad-documents-core.ts` (pure: input validation, DTO,
     `DesktopCadDocError`), `-db.ts` (Prisma-shaped, testable with a fake),
     `.ts` server-only shim, thin route. `runtime = "nodejs"`,
     `dynamic = "force-dynamic"`, `Cache-Control: private, no-store`.
     Reuse `assertRequestTransportAllowed` for parity with the auth routes.
   - `get-latest/route.ts`: leave cookie-only in P4B. Note as follow-up.

3. **Managed document identity / binding.** As in milestone "Design
   question". Deliverables:
   - Core `WorkspaceManifest` type + reader/merger/writer for
     `<root>/.arch/workspace.json` (schema `arch-plm.workspace-manifest.v1`).
     Corrupt/missing -> treat as no bindings, never throw to the UI.
   - Core `WorkspaceBindingResolver`: given an absolute file path and the
     known workspace root(s), return `PlmIdentity` or null. Never infer from
     filename alone - only an exact `root + relativePath` match against a
     manifest entry counts.
   - `DocumentContextFactory` (inventor) uses it to populate
     `CadDocumentContext.PlmIdentity`. The "known workspace root" is the last
     root the user used, remembered in `ConnectSettings` (non-secret).

4. **Get Latest request/response contract.** Request: bearer, `Accept:
   application/json`, `redirect: manual`, origin-bound. Response: the
   EXISTING `WorkspacePlan` (`arch-plm.cad-workspace-plan` / `1.0.0`) -
   unchanged. Validate: origin match -> no redirect -> 2xx -> shape ->
   contract id -> supported major version -> `safe === true`. Port the exact
   checks from `web/cli/workspace-plan-client.ts`. If `safe !== true`, refuse
   the WHOLE operation and surface `plan.problems` - download nothing.

5. **Workspace root + safe path / materialization rules.**
   - Root: user-picked ABSOLUTE directory (folder browser in the dialog),
     remembered per-server. Never from the plan or any server response.
     Reject relative paths; basic guard against obvious system locations.
   - `SafeWorkspacePath` (Core): port `assertSafeWorkspacePath` rules + the
     P3B-2B materialization constraints - FLAT filename only (reject nested),
     Windows case-insensitive containment under the root. Also do the
     case-insensitive cross-entry collision pre-pass -> block colliding
     entries.

6. **Binary download + integrity.**
   - `HttpContentDownloader` (Api): port `web/cli/http-content-downloader.ts`.
     Only fetch the exact `/api/file-versions/{fileVersionId}/content` shape,
     resolved against the server origin; refuse ALL 3xx unconditionally;
     reject non-2xx; ONE timeout across headers + the entire streamed body
     (reuse the P4A whole-exchange pattern from `ArchApiClient`); stream, no
     whole-file buffering.
   - Verify staged `size == version.fileSize` AND
     `sha256 == version.checksum` (the PLAN's pinned values are
     authoritative) BEFORE any promote. Optionally also assert the
     `X-Content-SHA256` header equals the plan checksum. Mismatch -> discard
     staged file -> entry `failed`.

7. **Assembly / dependency package behaviour.** The plan already contains the
   full CadDependency closure, each entry pinned. Materialize EVERY entry
   (flat, one file each). No client graph walk. Record `dependsOn` +
   `isRoot` in the manifest for future reference intelligence, but do NOT
   touch Inventor `.ipj` / reference resolution in P4B. `safe:false` (missing
   binary / dangling dep / collision) -> whole operation refused.

8. **Existing local file conflict behaviour.** Same checksum+size ->
   `already-current` (no download, no write). Different -> `blocked`
   ("local-conflict"), file left untouched. A file that appears mid-op ->
   `blocked` (race), never overwritten. `.arch/` and `.arch/.staging/` are
   client-managed and excluded from conflict logic. NEVER overwrite or delete
   a user file.

9. **Inventor ribbon enablement / state.**
   - `RibbonCommandPolicy`: `GetLatest` is now implemented-in-P4B; enabled
     iff `ConnectionState == Connected` (does NOT require an open document).
   - Checkout / Check In / Undo Checkout: still disabled (P4C).
   - `Status` MAY show the active document's manifest-derived identity
     (`MANAGED <docNumber> vN` / `UNMANAGED`). A live OUT_OF_DATE check is
     OPTIONAL for P4B; if included it is a single extra workspace-plan call
     comparing pinned vs local checksum, never a write.
   - During a run: button busy; result shown in a modal summary listing
     counts + every blocked/failed entry with its reason.

10. **Error handling** - map each to a controlled, non-destructive outcome:
    | Case | Outcome |
    |---|---|
    | 401 any endpoint | `ArchApiException(Unauthorized)`; connection -> Unauthorized; discard local session; prompt re-sign-in; nothing downloaded |
    | network / timeout / 5xx | `ArchApiException(Network/Timeout/Server)`; connection -> ServerUnavailable; session kept; "try again"; nothing downloaded |
    | resolve 404 (unmanaged / unknown number) | dialog: "No CAD document '<n>' in your organization."; no workspace change |
    | `safe:false` / a `problems` entry | whole op refused; show the problems list; nothing downloaded |
    | checksum / size mismatch | that entry `failed` (expected vs got, filename only - no server paths); staged discarded; other entries still processed |
    | unsafe path / nested / escapes root | that entry `blocked`; nothing written for it |
    | local conflict | that entry `blocked` "local-conflict"; existing file untouched |
    | content redirect / 403 | hard failure for that entry (`failed`) / "no access" |

11. **Disposable integration-test strategy.**
    - Server live gate (script, run via `node --experimental-strip-types
      --env-file=.env`): create `ITEST-<rand>` org + ENGINEER + VIEWER users,
      an Item + CadDocument graph (root IAM -> 2x IPT + 1x IDW, plus one
      nested child to exercise the closure), upload real `randomBytes`
      binaries via `storeCadFileVersion`, mint a bearer token via the P4A
      login route, then: resolve-by-number, workspace-plan (bearer) shape +
      `safe:true`, content download (bearer) -> bytes + sha256 match; VIEWER
      can read; cross-tenant -> 404; deactivated user -> 401; corrupt one
      stored object -> content 500. FK-safe cleanup of ALL rows + storage
      objects + empty dirs. Snapshot non-ITEST `CadDocument` / `FileVersion`
      row hashes before/after -> assert unchanged.
    - C# integration test: run `GetLatestOrchestrator` against a fake
      `HttpMessageHandler` (canned plan + canned binary streams) into
      `%TEMP%\arch-cc-test-<guid>`; assert `MaterializationReport` +
      `.arch/workspace.json`; delete the temp dir. Re-run -> all
      `already-current`. Corrupt a temp file -> that entry `blocked`.

12. **Web tests + C# tests + manual Inventor 2025 acceptance.**
    - Web: unit for resolve `-core`/`-db` (tenant scope, 404, VIEWER-ok,
      input bounds); a test proving the adapted routes still serve the
      cookie path identically AND now serve a valid bearer token; full gate.
    - C#: port test-for-test from `workspace-materialize-core.test.ts`
      (downloaded / already-current / local-conflict / checksum-mismatch /
      unsafe-path / collision / never-overwrite / staged-then-verify), plus
      `HttpContentDownloader` (origin bind, redirect refuse, non-2xx,
      body-stall timeout, contentPath shape), `WorkspacePlanClient`
      (shape/contract/safe), `WorkspaceManifest` (write/merge/read/corrupt),
      `ArchApiClient.GetLatestAsync` end-to-end. `dotnet build` 0 warnings,
      `dotnet test` green.
    - Manual Inventor 2025 (disposable folder + disposable IAM, add-in
      installed + signed in): Get Latest -> enter root number -> pick fresh
      folder -> summary shows N downloaded -> files on disk match ->
      `.arch/workspace.json` present -> re-run -> all already-current ->
      edit one file -> re-run -> that one blocked (local-conflict), rest
      already-current -> open a retrieved file -> Status shows MANAGED.
      Paste the checklist + outcomes into implementer-report.md.

13. **Explicit exclusions.** See milestone "Exclusions". In particular: no
    schema/migration change, no P4C, no P5 reference-repair, no Copy Design,
    no nested folders, no auto-open, no write-back, no Inventor 2026 run, no
    root git repo, no commit/push.

14. **Rollback / recovery.** Per-file atomic exclusive-create after full
    verify. Never overwrite/delete a user file. A crash leaves only
    `.arch/.staging/*.part` (cleaned next run). Manifest write failure ->
    files still valid, manifest rebuilt next run. Corrupt manifest -> "no
    bindings", recovered by re-running. 401 mid-op -> clean abort + discard
    session. Zero server-side state change (pure reads) -> nothing to roll
    back on the server.

15. **Definition of DONE.** All milestone acceptance criteria checked; both
    validation gates green; disposable-ITEST live gate passed with ARCH
    baseline unchanged; manual Inventor 2025 acceptance recorded;
    implementer-report.md complete; nothing committed or pushed in either
    repo.

## Constraints

- Do NOT modify application logic beyond what slices 1-2 require on the
  server; do NOT touch `prisma/` at all (if analysis says a migration is
  needed, STOP and escalate).
- Do NOT change any existing route's cookie/browser response.
- Do NOT duplicate server Get Latest / workspace-plan / closure / version
  logic - reuse it through the API.
- Do NOT infer identity from filename. Do NOT overwrite/delete user files.
- Do NOT commit or push in either repo. Do NOT create a root git repo.
- Keep the two repos' diffs independently reviewable.

## Definition of done

- Slices 1-10 complete and green.
- Web validation gate + C# validation gate both green (record in report).
- Disposable-ITEST server live gate passed; cleanup verified; ARCH baseline
  row-hash unchanged.
- Manual Inventor 2025 acceptance checklist done and pasted into the report.
- implementer-report.md filled (Status: COMPLETE), including a per-repo
  `git status --porcelain` confirming nothing committed/pushed.

## Validation gate

web:

    npm test
    npm run lint
    npm run build
    git diff --check
    npx prisma validate
    npx prisma migrate status

inventor:

    dotnet restore
    dotnet build      # expect 0 warnings
    dotnet test

manual:

    Inventor 2025 acceptance checklist (point 12 above)
