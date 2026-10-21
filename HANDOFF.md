# Handing work to Qwen

How a lead agent (Claude) should use `qwen-agent`. Copy the "Rules for the lead agent"
section into the target repo's `CLAUDE.md` so every session follows it.

## Rules for the lead agent

You can delegate coding tasks to a cheaper model through the `qwen-agent` MCP tools
(`delegate_task`, `get_result`, `list_tasks`, `cancel_task`). Delegating only saves effort
when the spec is tight and the result is checked automatically.

**Delegate** work that is bounded and has a contract to follow:
- a new single-file app that follows an existing SDK contract
- tests for existing code, docs/wiki entries, docstrings
- mechanical refactors (move a screen onto a shared UI kit, rename across files)
- parsers, data tables, lookups

**Keep** work where a mistake is expensive or can't be caught from a diff:
- firmware timing, pinouts, voltages, anything verified only on real hardware
- cross-cutting changes to shared servers/frameworks
- deploy, release and migration steps
- anything where you are not sure what "done" looks like

**Write the spec like a ticket**, not a wish:
1. Name the files to touch (`allow_paths`) and the contract to follow.
2. Say what "done" means in checkable terms.
3. Always give `gates`: commands that exit 0 only when the work is right (tests, syntax
   check, lint). A task with no gates comes back unverified. If a gate doesn't exist yet,
   make writing the test part of the task.
4. Say what NOT to touch.
5. Put required side-effects in the spec (changelog entry, wiki page) — Qwen only knows
   what the spec and the repo's `QWEN.md`/`AGENTS.md` tell it.

**Review the result, don't trust it.** `get_result` gives status, files, gate results and
the agent's summary (with its assumptions). Then:
- `status: passed` → read the diff (`include_diff`), check it against the spec, and look for
  weakened tests, hard-coded values that satisfy a gate, and unrelated edits. Then merge the
  branch (`merge_hint`).
- `gates_failed` / `incomplete` → the branch holds WIP. Read why; either fix it yourself,
  or re-delegate with a corrected spec. Don't merge it as is.
- `blocked` → the agent found a problem with the spec. Answer its question and re-delegate.
- `error` / `crashed` → infrastructure (model unreachable, bad config), not a code problem.

Cancelling (`cancel_task`) on Windows is a hard stop with nothing committed; run `qwen-agent clean` afterwards.

Delegate several independent tasks at once; each runs in its own worktree and branch.

## Spec format

Markdown with a frontmatter block (see `examples/benchtool-app.spec.md`):

```
---
title: Short title (becomes the branch name)
gates:
  - name: tests
    run: python3 -m pytest tests/test_x.py -q
    timeout: 300
setup:                     # run once in the fresh worktree before the agent starts
  - pip install -r requirements.txt
allow_paths: [app_sdk/x/, tests/test_x.py]
max_steps: 60
max_fix_rounds: 3
base: main                 # default: current HEAD
---
Task text: what to build, the contract, what done means, what not to touch.
```

Via MCP the same fields are arguments of `delegate_task`.

## What the runner guarantees

- Work happens in a separate `git worktree` on branch `qwen/<title>-<id>`. Your checkout,
  working-tree changes and current branch are never touched. (Uncommitted changes in your
  checkout are *not visible* to the agent; commit or stash what the task depends on.)
- Writes are limited to `allow_paths` when given; `.git` is always protected; paths can't
  escape the repo, including through symlinks.
- Destructive commands, `git push/commit/checkout/reset/...` and `curl | sh` are refused.
  Child processes don't inherit environment variables that look like credentials.
- Failing gates are sent back with their output for up to `max_fix_rounds` rounds.
- The final state is committed on the branch (prefixed `WIP (<status>)` when not passing).
- Models are tried in order from `~/.qwen-agent/config.json`: hosted first, local as the
  fallback. Retryable errors (timeouts, 429, 5xx) are retried before falling back.
