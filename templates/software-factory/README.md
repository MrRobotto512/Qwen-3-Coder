# Software factory (for Qwen Workspace)

A pipeline that takes a feature from idea to a reviewed git branch, writing a record of each
stage. Adapted for a single local model from the multi-agent original.

## Use it

In Qwen Workspace, with this project open and Agent mode on, say:

> run the factory: add a dark-mode toggle

Qwen loads the `factory` skill and runs it: **spec → build → review (code + security) → decide →
report**. Each stage is written to `factory/jobs/<job-id>/`:

```
factory/jobs/003-dark-mode/
  spec.md            what to build and what "done" means
  build.md           files changed, commands run and their results
  review-code.md     VERDICT: PASS | CHANGES, then findings
  review-security.md VERDICT: PASS | CHANGES, then findings
  decision.md        APPROVE | ESCALATE, then why
```

The work goes on a `factory/<job-id>` branch. Nothing is merged or pushed without you asking.

## Set up your project

Put your build, test and lint commands in `AGENTS.md` or `QWEN.md` at the project root, e.g.:

```
## Commands
- Install: npm install
- Dev server: npm run dev
- Test: npm test
- Build: npm run build
- Lint: npm run lint
```

If they are missing, the factory asks you for them and saves your answers.

`factory/jobs/` holds runtime state; it is kept out of git by the included `.gitignore` entry.
