# Implementer Task

Status: NOT ASSIGNED
<!-- Status: NOT ASSIGNED | ASSIGNED | IN PROGRESS | DONE -->

- For milestone:  <milestone id from milestone.md>
- Task type:      <feature | fix-only | refactor | investigation>
- Working tree:   must start CLEAN at the Stable HEAD in milestone.md

## Ask

<Precise description of the ONE change. If this is a fix-only pass, list the
exact reviewer findings being addressed and nothing else.>

## Constraints

- Do NOT expand scope beyond the ask.
- Do NOT commit or push.
- Do NOT modify: <copy the milestone's exclusions here>
- Preserve: <invariants that must not regress>

## Definition of done

- Change implemented and self-reviewed.
- Validation gate run and green (or every failure explained).
- implementer-report.md filled in; its Status set to COMPLETE.

## Validation gate (run all, record results in the report)

    npm test
    npm run lint
    npm run build
    git diff --check
    npx prisma validate
    npx prisma migrate status
