# Milestone

Status: IN REVIEW
<!-- Status: PLANNING | IN PROGRESS | IN REVIEW | GATED | DONE -->

- Milestone ID:   AIWF-1
- Title:          Lightweight local AI development workflow
- Repo:           C:\Users\skota\ArchPLM\web
- Stable HEAD:    2b5f037 - Add secure desktop authentication for CAD Connect
- Date opened:    2026-09-06

## Objective

Add a local, file-based coordination framework (.ai/ + scripts/ai-*.ps1) so
the Project Manager -> Claude -> Codex loop stops relying on manual
copy/paste. Development tooling only; no application code, schema, migration
or P4A behaviour changes.

## Scope

- .ai/ with README, milestone/task/report templates and a strict release gate.
- .ai/templates/ as the pristine source for ai-reset.ps1.
- scripts/ai-status.ps1 (read-only snapshot) and scripts/ai-reset.ps1
  (restore working files from templates).
- .ai/ tracked in git (not ignored).

## Exclusions

- Do NOT modify application logic, Prisma schema, or migrations.
- Do NOT modify P4A functionality.
- No AI API calls, no dependencies, no secrets, no auto-commit / auto-push.

## Acceptance criteria

- [x] .ai/ and scripts/ created exactly as specified.
- [x] release-gate.md uses the strict CRITICAL/HIGH/MEDIUM/LOW/PASS/DECISION block.
- [x] ai-status.ps1 prints HEAD, git status, milestone, report states, gate decision.
- [x] ai-reset.ps1 restores only the six working files; never touches source or runs git reset/clean.
- [x] `git diff --check` clean.
- [x] Nothing committed or pushed.

## Notes

The framework is self-hosting: this milestone was defined through the very
files it creates. Run `scripts\ai-reset.ps1` to blank it for the first real
milestone (P4B).
