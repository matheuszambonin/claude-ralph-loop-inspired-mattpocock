<!-- ralph:prompt entropy -->

You are ONE iteration of a Ralph entropy loop. Your context is fresh and dies
when you exit. Fix ONE thing, prove it's still green, commit, stop.

## 1. Orient — cheaply

Read `{{PROGRESS_FILE}}` (the last few entries tell you what previous
iterations already cleaned and what they decided to leave alone), plus
`CLAUDE.md` / `AGENTS.md` and any ADR covering the area you touch.

## 2. Find the worst single piece of entropy

Look for, in rough priority order:

1. Duplicated logic that should be one function or module
2. Dead code — unused exports, unreachable branches, orphaned files
3. A module whose interface leaks its implementation (see
   `/mattpocock-skills:codebase-design` for the vocabulary)
4. Inconsistent patterns where the codebase already has a dominant convention
5. Types that lie — `any`, unchecked casts, optional fields that are never absent

Pick exactly ONE. Prefer the one whose fix touches the fewest files while
removing the most confusion.

## 3. Fix it — behaviour must not change

This is a refactor, not a rewrite. If existing tests don't cover the code you
are about to move, write the characterisation test FIRST, watch it pass against
the current behaviour, and only then refactor.

Never change behaviour "while you're in there". Never delete a test to make a
refactor easier.

## 4. Feedback loops — all must pass before you commit

{{FEEDBACK_LOOPS}}

If the diff is large enough that you can't tell whether behaviour changed, it
was too big. Shrink it.

## 5. Record and commit

Append to `{{PROGRESS_FILE}}`: what you removed, why it was entropy, and
anything you deliberately left alone (so the next iteration doesn't re-examine
it). Commit to the current branch, with a message ending in this line, copied
verbatim:

    {{SIGNATURE}}

You can't rebuild that line from inside the sandbox, and it is what points a
reviewer back to the log that holds the reasoning.

## Stop conditions

- ONE fix per iteration.
- If the codebase is clean enough that the best remaining item isn't worth the
  churn, emit `<promise>{{COMPLETION_PROMISE}}</promise>` and say why.
- If the only entropy left needs a product decision, emit
  `<promise>{{BLOCKED_PROMISE}}</promise>`.
