# ARCH PLM — Lightweight AI Development Workflow

A local, file-based coordination framework for the three-role loop used to
build this project:

```
Project Manager  ->  Implementer (Claude)  ->  Reviewer (Codex)  ->  Release gate
```

It exists only to cut the manual copy/paste between roles.

**This is development tooling only.** It does not touch application logic, the
Prisma schema, migrations, or P4A functionality. It never calls an AI API,
adds a dependency, stores a secret, runs git, or commits/pushes anything.

---

## Roles

| Role | Reads | Writes |
|---|---|---|
| **Project Manager** (you) | the reports | `milestone.md`, `implementer-task.md`, `reviewer-task.md`, the `DECISION:` in `release-gate.md` |
| **Implementer** (Claude Code) | `milestone.md`, `implementer-task.md` | the actual code change + `implementer-report.md` |
| **Reviewer** (Codex) | `milestone.md`, `reviewer-task.md`, `implementer-report.md`, the current `git diff` | `reviewer-report.md` |
| **Release gate** | both reports | `release-gate.md` |

---

## The loop

1. **Plan.** PM fills in `milestone.md` (id, objective, scope, exclusions,
   acceptance criteria) and `implementer-task.md` (the one concrete ask).
2. **Implement.** Claude reads `milestone.md` + `implementer-task.md`, makes
   the change on a clean working tree, runs the validation gate, and writes
   `implementer-report.md`.
3. **Review.** PM fills in `reviewer-task.md` (what to scrutinise). Codex
   reads it plus the `git diff` (staged or unstaged) and writes
   `reviewer-report.md`, bucketing every finding CRITICAL / HIGH / MEDIUM /
   LOW and ending with a `PASS` line.
4. **Gate.** The findings are consolidated into `release-gate.md`, which ends
   with one `DECISION:` line: `SAFE TO COMMIT` or `NOT SAFE TO COMMIT`.
5. **Fix or commit.** If NOT SAFE, PM writes a fix-only `implementer-task.md`
   and the loop repeats from step 2. If SAFE, the PM commits (manually).
6. **Reset.** `scripts/ai-reset.ps1` returns the six working files to their
   templates for the next milestone. `README.md` and `templates/` are never
   touched.

---

## Files

```
.ai/
  README.md              this document (never reset)
  milestone.md           the current milestone definition            (PM)
  implementer-task.md    the concrete task for the implementer        (PM)
  implementer-report.md  what was done, files changed, validation     (Claude)
  reviewer-task.md       what the reviewer should focus on            (PM)
  reviewer-report.md     findings, bucketed by severity               (Codex)
  release-gate.md        consolidated severities + commit decision    (PM/gate)
  templates/             pristine sources; ai-reset.ps1 restores from here
scripts/
  ai-status.ps1          one-screen read-only status snapshot
  ai-reset.ps1           restore the six working files from templates
```

The six top-level `*.md` files are live working copies. `templates/*.template.md`
are the pristine versions `ai-reset.ps1` copies back.

---

## Conventions

- Every working file has a `Status:` line near the top. `ai-status.ps1` reads
  it. Valid values are listed as an HTML comment right under each one.
- `release-gate.md` uses a strict, greppable block. Put content on the line(s)
  under each key; write `none` when a bucket is empty:

  ```
  CRITICAL:
  HIGH:
  MEDIUM:
  LOW:
  PASS:
  DECISION:
  ```

  `DECISION:` is exactly one of `SAFE TO COMMIT`, `NOT SAFE TO COMMIT`,
  `PENDING`.
- The validation gate every implementer task must run:

  ```
  npm test
  npm run lint
  npm run build
  git diff --check
  npx prisma validate
  npx prisma migrate status
  ```

- Nothing in `.ai/` or `scripts/ai-*.ps1` runs git, hits the network, or
  auto-commits. Committing is always a manual PM action.

---

## Scripts

### `scripts/ai-status.ps1`

Read-only. Prints: repo HEAD + branch + subject, git status summary,
milestone id/title/base/status, the state of the two task files and two
report files, and the release-gate buckets + decision. Safe to run any time.

### `scripts/ai-reset.ps1`

Restores `milestone.md`, `implementer-task.md`, `implementer-report.md`,
`reviewer-task.md`, `reviewer-report.md`, `release-gate.md` from
`.ai/templates/`. Prompts for confirmation unless `-Force`. It only ever
writes inside `.ai/`; it never touches source code and never runs
`git reset` / `git clean` / `git checkout`.
