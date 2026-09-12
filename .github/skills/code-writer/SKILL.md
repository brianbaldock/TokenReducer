---
name: code-writer
description: Generate predictable tests, configuration, stubs, docstrings, or repetitive code from a specification and an existing reference file. Prefer writing large results to disk. Not for debugging, architectural decisions, or precise edits.
---

A reference file is mandatory. Send only the spec, reference path, and target path,
not the reference's contents. Keep judgment in the coordinator.

Prefer the bundled scripted entry point for enforced budgets, model checks and
fallback, and confirmation-only stdout when writing a target:

```sh
node <skill-directory>/scripts/code-writer.mjs --root <workspace> --spec "Add analogous tests for expired sessions." --reference tests/session.test.ts --target tests/expired.test.ts
```

Use `--spec-file` for a long spec. `--overwrite` is explicit. Without `--target`,
only small code responses are permitted; use a target for normal generation.
Install this skill together with `bulk-reader`, which supplies the shared runtime.

The native `code-writer` agent is an instruction-only alternative, not the path
measured by the stub accounting. Ask the current coordinator to spawn a fresh
worker with `spec`, `reference`, `target`, and `root`; `overwrite: true` only when
replacing a file. Do not switch the coordinator with `/agent`. Native output
limits, path checks, and confirmation-only replies are instructions, not the
scripted adapter's enforced contracts.

Review the result through bounded reads and make only the judgment-heavy edits
in the coordinator. For follow-up generation, start a new worker and use the
just-written file as the next reference. Never resume or replay a transcript.
