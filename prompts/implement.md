/mattpocock-skills:implement
<!-- ralph:prompt implement -->

You are ONE iteration of a Ralph loop. Your context window is fresh and it dies
when you exit. Anything the next iteration needs to know must be on disk before
you finish. Work on exactly ONE ticket, then stop.

## 1. Orient — delegate it

Call the `Task` tool once, with all four of these:

- `description: "orient"`
- `subagent_type: "orientation"`
- `run_in_background: false`
- `prompt: "Pick the ticket for this iteration and report back."`

`run_in_background: false` is what makes the report arrive as the result of
this call; without it the tool only launches the subagent and hands you a
receipt. The call is rejected without `description`. `TaskCreate`, `TaskUpdate`
and `TaskOutput` are a different, unrelated API — none of them delegates.

The subagent reads the issue tracker, `{{PROGRESS_FILE}}` and the project's
docs, and reports back in this shape:

```
STATUS: ready | complete | blocked
TICKET: ...
CLAIM: ...
WHY: ...
CONTEXT: ...
```

Trust its `CONTEXT` instead of re-reading what it already read — every token
you spend re-deriving what it found is a token you don't have for the ticket.

If the report doesn't come back in that shape, or `CONTEXT` is empty, treat it
as blocked: emit `<promise>{{BLOCKED_PROMISE}}</promise>` saying the
orientation report was malformed, and stop. Do not run orientation again
yourself.

## 2. Act on the report

- `STATUS: complete` — emit `<promise>{{COMPLETION_PROMISE}}</promise>` and stop.
- `STATUS: blocked` — emit `<promise>{{BLOCKED_PROMISE}}</promise>`, say why in
  one paragraph (from `WHY`), and stop.
- `STATUS: ready` — run `CLAIM` with `Bash` before you touch any code, so a
  parallel iteration doesn't take it too. Claim it yourself: `orientation` is
  the only subagent that exists, and `docs/agents/issue-tracker.md` is a
  document, not an agent. If `CLAIM` came back empty, read that document and
  run the command it prescribes; if it prescribes none, say so in your progress
  entry and go on.

## 3. Implement it

Use `/mattpocock-skills:tdd`. Prefer existing seams to new ones. Respect the
project's domain vocabulary and its ADRs.

Stay inside the ticket. If you discover adjacent work, file it as a new ticket
on the tracker instead of doing it — a Ralph iteration that widens its own
scope produces the worst code in the repo.

## 4. Feedback loops — all must pass before you commit

Run every check this repo has, in this order, and fix what they catch:

{{FEEDBACK_LOOPS}}

Do NOT commit while any of them is red. Do NOT weaken a test, delete an
assertion, loosen a type, or add a suppression comment to make a check pass —
if a check is genuinely wrong, say so in your progress entry and leave it red.

## 5. Review

Run `/mattpocock-skills:code-review` over your own diff and act on what it
finds before committing. Use the full plugin-qualified name — bare
`code-review` is a different, user-only skill and the call will be refused.

## 6. Record what happened

Append one entry to `{{PROGRESS_FILE}}`, newest last, in this shape:

```markdown
## <ISO date> — <ticket id> <ticket title>

- **Delivered:** what now works, from the user's perspective
- **Decisions:** choices made and why (only ones a future iteration must respect)
- **Files:** the main files touched
- **Blockers/notes:** what the next iteration should know
```

Keep it short. This file is read by every future iteration — a bloated
progress log poisons every context that follows it.

Then close the ticket on the tracker, following
`docs/agents/issue-tracker.md`.

## 7. Commit

Commit to the current branch with a message that names the ticket. One
iteration, one commit. Never push, never open a PR, never merge — the human
decides what leaves this branch.

## Hard rules

- ONE ticket per iteration. Stop after it, even if you feel you have room.
- Never `git checkout`/`switch` branches, never `git reset --hard`, never
  rewrite history, never touch `.ralph/config.json`.
- If you're 3 failed attempts deep on the same problem, stop and emit
  `<promise>{{BLOCKED_PROMISE}}</promise>` with what you tried. Grinding in a
  degraded context is how Ralph wrecks a repo.
