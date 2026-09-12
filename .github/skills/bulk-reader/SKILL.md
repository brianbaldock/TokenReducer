---
name: bulk-reader
description: Answer focused questions about files over 350 lines, several files, or large saved diffs without loading their bodies into the coordinator. Use after a TokenReducer read-gate denial. Not for debugging, architecture, precise edits, or a single small file.
---

Keep the selected coordinator model. Send paths and a question, never pasted file bodies.

Prefer this skill's bundled scripted entry point. It enforces input/output budgets,
model selection checks, unavailable-model fallback, and compact stdout:

```sh
node <skill-directory>/scripts/bulk-reader.mjs --root <workspace> --question "Which symbol sets the retry limit?" --path src/client.ts
```

Repeat `--path` for multiple files. Use `--question-file` for a long question.
Follow-ups start a new call with the same paths and a new question.
Do not construct substitute shell pipelines or inline the corpus.

The native `bulk-reader` agent remains available as an instruction-only option.
Ask the current coordinator to spawn it with `question`, `paths`, and `root`;
do not switch the coordinator with `/agent`. Native limits and output behavior
are instructions, not the scripts' enforced contracts or measured accounting.
Return only requested facts, with exact symbols, types, paths, and line numbers.
Never resume a worker or forward its transcript.

The gate defaults to 350 lines (`TOKENREDUCER_LINE_THRESHOLD` overrides it).
For exact edits, keep reasoning in the coordinator and read only the relevant
finite `view_range` window at or below that threshold. Oversized windows and
EOF suffixes with too many remaining lines are denied, including `[2, -1]`.
Debugging, architectural choices, and surgical edits stay in the coordinator.
