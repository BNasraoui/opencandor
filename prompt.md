# OpenCandor Drain-Beads Task Prompt

This project uses `drain-beads` to execute Beads issues. Follow this loop for every task.

## Required Workflow

1. Read the Beads issue fully before changing files.
   - Run `bd show <issue-id>`.
   - Inspect blockers and dependents with `bd dep tree <issue-id>` when relevant.
   - Append important discoveries to the issue with `bd update <issue-id> --append-notes "..."`.

2. Inspect related Provenance work before designing the change.
   - If the Beads issue has an external ref like `prov:<id>`, run `statesman provenance graph <id> --project-id "ec005c97-1bb0-470f-aae2-ac00fb03e99f" --json`.
   - If no specific Provenance id is attached, inspect the root requirement with `statesman provenance graph jn71kyw3mwmexcmzh7t4eqsna988m354 --project-id "ec005c97-1bb0-470f-aae2-ac00fb03e99f" --json`.
   - Use requirements, resolutions, rules, and thread notes to constrain the implementation.

3. Use test-driven development.
   - Load the `test-driven-development` skill before implementation work.
   - Write failing tests or fixtures first.
   - If a task genuinely cannot start with a test, record why in the Beads issue before implementing.

4. Implement the smallest correct change.
   - Keep host adapters thin.
   - Keep provider-specific code out of core unless the Beads issue explicitly requires it.
   - Preserve the Provenance requirements around intent preservation, prompt-laundering safety, and host capability honesty.

5. Make the tests pass.
   - Run the focused tests for the task.
   - Run the relevant broader test/build/lint commands before considering the task complete.
   - Record any unavailable or failing verification in the Beads issue.

6. Run an isolated thermonuclear review loop.
   - Spawn a separate review agent.
   - Instruct it to load the `thermo-nuclear-code-quality-review` skill.
   - The review agent must review the total current working-tree diff every time.
   - Never bias the review agent toward only the latest fix, the previous review comment, or a narrow patch slice.
   - Give the reviewer the full accumulated diff and relevant Beads/Provenance context.
   - If the reviewer finds issues, fix them, rerun tests, then spawn a fresh review pass over the full diff again.
   - Repeat fix, test, full-diff review until the reviewer is content or only explicitly accepted residual risks remain.

7. Complete the Beads issue.
   - Update notes with implementation summary, tests run, review result, and any residual risks.
   - Close the issue with `bd close <issue-id> --reason "..."` only after tests and review are complete.

8. Commit and push the work.
   - Inspect `git status`, `git diff`, and `git log --oneline -10` before committing.
   - Stage only files intended for the task.
   - Commit with a concise message that matches the project style.
   - Push the branch after committing.
   - If no remote is configured or push fails for an environmental reason, report that clearly and leave the local commit in place.

## Review Agent Prompt Requirements

Every review pass must be framed as a full independent review of the entire diff. Use language like:

```text
Load the thermo-nuclear-code-quality-review skill. Review the entire current working-tree diff for maintainability, abstraction quality, unnecessary complexity, giant-file risk, spaghetti-condition growth, test coverage, and behavioral regressions. Do not focus only on the last fix or prior review feedback. Treat this as a fresh review of the full accumulated change set.
```

Do not use language like:

```text
Check whether I fixed your previous finding.
```

That anchors the reviewer and is not acceptable for this project.

## Project Context

- Provenance project id: `ec005c97-1bb0-470f-aae2-ac00fb03e99f`
- Root Provenance requirement: `jn71kyw3mwmexcmzh7t4eqsna988m354`
- MVP epic: `opencandor-mvp`
- First implementation task: `opencandor-scaffold`
