<!-- ralph:prompt test-coverage -->

You are ONE iteration of a Ralph coverage loop. Your context is fresh and dies
when you exit. Cover ONE gap, commit, stop.

## 1. Orient — cheaply

Read `{{PROGRESS_FILE}}` for what previous iterations covered and what they
judged not worth testing. Read `CLAUDE.md` / `AGENTS.md` for this repo's
testing conventions.

Run the coverage report. If this repo has no coverage tooling, emit
`<promise>{{BLOCKED_PROMISE}}</promise>` and say what needs configuring.

## 2. Pick the most valuable uncovered gap

Rank by risk, not by percentage: money, auth, data loss, and error paths first;
getters and generated code last. Prefer a gap at an existing test seam.

Coverage is the symptom you're measuring, not the goal. A test that exists only
to move the number is worse than no test — it locks in implementation details
and future iterations will fight it.

## 3. Write the test

Follow `/mattpocock-skills:tdd`. Test external behaviour through the highest
seam that exercises the gap — never reach into internals to force a branch.

If a gap can't be covered without contorting the code, that's a design signal:
record it in `{{PROGRESS_FILE}}` and move to the next gap instead.

## 4. Feedback loops — all must pass before you commit

{{FEEDBACK_LOOPS}}

The new test must fail if you break the behaviour it covers. Prove it: break
the code deliberately, watch the test go red, restore it.

## 5. Record and commit

Append to `{{PROGRESS_FILE}}`: what you covered, the before/after number, and
gaps you deliberately skipped with the reason. Commit to the current branch.

## Stop conditions

- ONE gap per iteration.
- When the remaining uncovered code is genuinely not worth testing, emit
  `<promise>{{COMPLETION_PROMISE}}</promise>` with the final number and what's
  left uncovered.
