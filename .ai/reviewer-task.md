# Reviewer Task

Status: NOT ASSIGNED
<!-- Status: NOT ASSIGNED | ASSIGNED | IN PROGRESS | DONE -->

- For milestone:        <id>
- Review of:            <staged diff | unstaged diff | commit range>
- Implementer report:   .ai/implementer-report.md

## Inputs

- milestone.md          - scope, exclusions, acceptance criteria
- implementer-report.md - what the implementer claims was done
- git diff              - the actual change under review

## Focus areas

<What to scrutinise hardest for THIS milestone. Delete what does not apply,
add specifics.>

- Security: auth, tenant isolation, secret handling, transport, input bounds.
- Correctness: edge cases, error paths, concurrency, off-by-one.
- Scope: anything touched outside the milestone's stated scope or exclusions.
- Tests: are the new/changed paths actually exercised.
- Regressions: P4A and earlier milestones still hold.

## Output rules

- Write findings into reviewer-report.md; set its Status to COMPLETE.
- Bucket EVERY finding: CRITICAL / HIGH / MEDIUM / LOW.
- Each finding names a `file:line` and a concrete failure scenario.
- Empty bucket => write `none`.
- End with a `PASS` line: does the change meet the milestone's acceptance
  criteria as written (PASS / FAIL + one line why).
- Do NOT commit, push, or modify code.
