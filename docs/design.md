# Three layers, one boundary

TokenReducer separates expensive judgment from predictable input/output work.
The boundary is the coordinator's model context, not the filesystem: source
files remain on disk and are processed in another model's isolated context.

## Read gate: host-dependent enforcement

A Copilot version 1 `preToolUse` command hook matches `view|bash|powershell`.
It checks large file reads and recognizable full-dump shell commands before
their output can reach the model.
It counts only as far as necessary, returning `permissionDecision: "deny"` with
a reason naming the `bulk-reader` skill's scripted entry point. Missing files pass through so
the host can return its normal error. Windows at or below the configured line
threshold and small files pass. Larger ranges and EOF suffixes require counting
the remaining lines; a positive offset or large limit is not a blanket exemption.
Pass-through returns a neutral `{}`, not `permissionDecision: "allow"`:
clearing the token policy must not bypass the host's normal authorization.
Project hooks require folder trust. Command failures deny, but the host's hook
timeouts are fail-open; the gate cannot promise enforcement when it is not run.

The shell recognizer never executes command text. It distinguishes quoting from
actual pipes/redirection and treats uncertain known-dump operands conservatively.
This is intentionally not a complete shell parser or arbitrary-program analyzer.
Pipelines remain exempt by product policy, so this cannot be a data-loss control.

Copilot's documented pre-tool event lacks a trusted parent/worker discriminator.
A global or environment-variable bypass would exempt the wrong process or make
the gate trivial to spoof. Instead, native worker profiles use bounded windows.
The scripted path preloads an explicitly scoped work order into a fresh CLI
process, with no model tool access.

## Named: isolated workers

The scripts are the preferred entry points for enforced budgets, model fallback,
and confirmation-only generation stdout. They are deterministic adapters around
Copilot prompt mode. They validate input, construct a size-limited work order, pipe it to stdin,
select a cheap model, capture the CLI's JSONL stream, extract only
the final assistant answer, and discard the rest. A response must report the
requested model; missing or mismatched model evidence withholds the answer.
A temporary custom-agent profile has no tools. The adapter deliberately omits
`-p`, which would discard stdin in
Copilot's programmatic mode. Unavailable models can retry
on GPT-5 mini within the same deadline. Other failures are errors, not successful
fallback answers. No worker ever defaults to the coordinator's model.

Source, request, and transcript bytes remain in ordinary process memory or a
short-lived owner-only directory, never in a tool response to the coordinator.
Generation is published to a validated target only after a nonempty successful
response. Fences are stripped, conflicts are refused, and the result returned
to the parent is a short path-written confirmation.

The two native profiles remain instruction-only alternatives with static default
models. Environment-aware model selection, retry logic, output ceilings, and path checks belong in scripts, not
invented agent-frontmatter properties. The installer can render model overrides
into native profiles. Host-side settings and cloud support still matter.

## Soft: routing skills

Descriptions make the skills discoverable without loading their full text.
The reader trigger is a large file, a question spanning several files, or a
large saved diff. The writer trigger is predictable reference-based generation:
tests, stubs, config, docstrings, and similar work.

Generation has no hard gate. The coordinator must notice the routing instruction
before writing a large body itself. Debugging, architecture, and precise edits
stay in the coordinator. The generated result is reviewed with bounded reads;
reading the entire result back would erase much of the savings.

Follow-up questions resend paths to a fresh worker. Follow-up generation uses
the new file as the next reference. There is no worker conversation to preserve
or replay, and no reason to bring the corpus into the parent to simulate memory.

## What the evidence means

The local benchmark compares a whole-file parent-visible corpus/body baseline
against actual compact responses and disk-write confirmations produced by the adapters
with deterministic worker stubs. It includes routing overhead and estimates
tokens using characters divided by four. Worker payload tokens are reported
separately, not misrepresented as eliminated.
Finite `view_range` already exists. The benchmark does not establish an advantage
over a parent using ideal targeted windows, and does not measure native workers.

That demonstrates the data path and its parent-token savings without pretending
to measure an LLM's accuracy, an invoice, or all system-prompt overhead. An
optional live run exercises real Copilot models on the same original fixtures.
Its generated-body parent-token metric is not measured, not assumed to be zero.
Cloud model choice and host hook discovery still need the host to support the
documented contracts. No packaging choice can make an absent capability real.
