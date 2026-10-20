---
name: factory
description: Run a feature through a spec → build → review → decide pipeline on its own git branch, writing a record of each stage. Use when the user says "run the factory", "factory <feature>", or wants a feature built end to end with review.
---

# Software factory

A pipeline that takes one feature from idea to a reviewed branch. It is adapted from the
multi-agent "software factory" for a single model: you play each role in turn and write that
role's file, so the record and the flow are the same. Follow it in order.

Pipeline: **spec → build → review (code + security) → decide → report.**

## Before you start

1. Read `AGENTS.md` or `QWEN.md` for how to set up, run, test, build and lint this project. If the
   build and test commands are not written down, ask the user with `ask_user` and save the answers
   to `QWEN.md`.
2. Pick a job id: `NNN-short-slug` (next free number in `factory/jobs/`, e.g. `003-dark-mode`).
3. Track the stages with `todo_write`: spec, build, review, decide.
4. Make a branch for the work: `run_command` with `git checkout -b factory/<job-id>` (skip if the
   project is not a git repo; say so).

Create the job folder and write each stage's file under `factory/jobs/<job-id>/` as you go.

## Stage 1 — spec (write `factory/jobs/<job-id>/spec.md`)

Restate the feature, the acceptance criteria (what "done" means), the files likely involved, and
anything out of scope. Keep it short. If the feature is ambiguous, use `ask_user` first.

## Stage 2 — build (write `factory/jobs/<job-id>/build.md`)

Implement the feature with `edit_file` and `write_file`, in focused commits. After building, run
the project's test, build and lint commands with `run_command` and fix what fails. In `build.md`
list the files you changed, the commands you ran and their results.

## Stage 3 — review (write `review-code.md` and `review-security.md`)

Review your own work with fresh eyes, in two passes. Start each file with `VERDICT: PASS` or
`VERDICT: CHANGES`, then the findings.
- **Code:** correctness, edge cases, tests, readability, and whether it meets the spec.
- **Security:** input handling, injection, secrets, unsafe file or command use, dependencies.

If either verdict is CHANGES, go back to Stage 2, fix the findings, and review again (at most
twice). Keep each round's files.

## Stage 4 — decide (write `factory/jobs/<job-id>/decision.md`)

Start the file with `APPROVE` or `ESCALATE`.
- **APPROVE** when both reviews pass and the tests pass: commit the work on the branch.
- **ESCALATE** when something needs the user's judgement (risky change, failing tests you cannot
  fix, an unclear requirement): say exactly what and why.

## Stage 5 — report

Tell the user the job id, the branch, what you changed, the verdicts, the decision, and the next
step (how to review the branch and merge, or what you need from them). Record the toolchain and
build commands in `QWEN.md` if they were not already there.

Do not merge to the main branch or push without the user asking. Keep `factory/jobs/` out of
version control (it is runtime state); add it to `.gitignore` if it is not already there.
