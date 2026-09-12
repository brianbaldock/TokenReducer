# TokenReducer

Copilot CLI skills, hooks, and isolated workers that keep bulk file bytes out of
the parent model's context.

This is a practitioner experiment based on other people's research, especially
[Spotify's shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt).
It is an original Copilot-native implementation, not a source port of shunt,
not Portal or AiKA, and not a new routing algorithm. Cheap workers still read
the corpus. The parent receives a compact answer or a path-written confirmation.

[Visual walkthrough and test battery](https://brianbaldock.github.io/TokenReducer/)
| [Design note](docs/design.md) | [MIT license](LICENSE)

## Install and use with Copilot CLI

Requires Node.js 20 or later and a current
[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
with piped prompt mode, JSONL output, and custom-agent tool restrictions.
Runtime and offline evals use only Node's standard library. No `npm install`.
Bash on macOS/Linux and PowerShell on Windows launch the same gate.

### Project install

Clone this repo, then install into an existing workspace:

```sh
git clone https://github.com/brianbaldock/TokenReducer.git
cd TokenReducer
node scripts/install.mjs --project /path/to/workspace
```

PowerShell uses the same installer:

```powershell
node scripts/install.mjs --project 'C:\Dev\MyProject'
```

The TokenReducer checkout itself already contains the project installation.
The installer copies only these owned entries:

```text
.github/
  skills/bulk-reader/
  skills/code-writer/
  hooks/tokenreducer.json
  agents/bulk-reader.agent.md
  agents/code-writer.agent.md
```

Both skills must be installed together. Identical files are left alone.
Differing files require `--overwrite` after review. Unrelated hooks, skills,
agents, and instruction files are not replaced. The optional
`.github/copilot-instructions.md` in this repo is not installed into other projects.

### Personal install

```sh
node scripts/install.mjs --personal
```

This installs under `~/.copilot/{skills,hooks,agents}`, or `COPILOT_HOME` if set.
On Windows the default is `$env:USERPROFILE\.copilot`.
`--personal --home DIR` selects a different Copilot home.

Personal hooks use safely quoted absolute launcher paths. Reinstall if that
home directory moves. Avoid installing both personal and project hooks unless
you intend to run both. User-level agent profiles can shadow project profiles
with the same name.

### Trust, restart, discover

Trust only a workspace you have reviewed. Project hooks do not run in an
untrusted folder, even when an agent profile is discoverable. Remember the trust
decision if you also use non-interactive sessions there. Blanket tool permissions
are not a substitute for folder trust.

Restart Copilot after installing agents or hooks. `/skills reload` reloads skills,
but does not replace that restart.

```text
/skills list
/skills info bulk-reader
/skills info code-writer
```

Ask the current coordinator to use the skills:

```text
Use /bulk-reader to identify the retry settings in src/client.ts.
Use /code-writer to add analogous tests, using tests/client.test.ts as the reference.
```

### Prefer scripted workers; keep the parent selected

The skills prefer the scripted entry points when enforced budgets, model checks
and fallback, and confirmation-only stdout matter. Each script spawns a fresh
Copilot worker. Your selected parent model stays selected.

Run these from the workspace containing your inputs:

```sh
node .github/skills/bulk-reader/scripts/bulk-reader.mjs \
  --question "Which symbol controls retries? Give its type and line number." \
  --path src/client.ts

node .github/skills/bulk-reader/scripts/bulk-reader.mjs \
  --question "Where do these modules disagree about the timeout?" \
  --path src/client.ts --path src/config.ts

node .github/skills/code-writer/scripts/code-writer.mjs \
  --spec "Add analogous cases for expired sessions." \
  --reference tests/session.test.ts --target tests/expired.test.ts
```

For personal installs, use the script path under your Copilot home and pass
`--root /path/to/workspace`. The continuations above are Bash syntax; put each
command on one line in PowerShell. Use `--question-file` or `--spec-file` for long
requests. Repeat `--path` for up to 64 explicit files. No implicit globbing.

The native `bulk-reader` and `code-writer` custom agents remain available as
**instruction-only alternatives**. Ask the current coordinator to **spawn** a
fresh native worker with named inputs: `question`, `paths`, `root`, or
`spec`, `reference`, `target`, `root`. Selecting one through `/agent` changes the
active role; it is not parent/worker delegation.

Native output limits, path checks, and model behavior do not equal the scripted
adapter's enforced contracts. The benchmark below measures the scripts, not
native subagent behavior. Send paths, never pasted file bodies or a previous
worker transcript. Follow-ups start fresh.

## Demonstrated results

```sh
npm test
npm run eval
npm run benchmark
```

Local run on 2026-09-12: **456 TAP tests passed, 0 failed, 0 skipped**.
`npm test` runs the contract suite. `npm run eval` runs that suite plus the
deterministic stub-worker benchmark. `npm run benchmark` runs only the accounting
experiment. The local macOS run included the PowerShell launcher; environments
without `pwsh` can report a skip.

### Parent-context accounting, not a bill

The following results use **stub workers** and `ceil(characters / 4)` estimates,
not a tokenizer, a live-model accuracy grade, or a billing API. The baseline
ingests the whole corpus into the parent. The scripted path returns only compact
stdout and coarse metadata.

| Case | Parent before | Parent after | Reduction |
|---|---:|---:|---:|
| One large-file question | 30,915 | 858 | 97.23% |
| Multi-file question | 62,455 | 893 | 98.57% |
| Generate to disk | 17,747 | 1,461 | 91.77% |

Both sides include actual skill text, invocation text, and a fixed
1,024-character delegation allowance. Before also includes the corpus and
answer or generated body. After includes the compact reply and metadata.
Generation reserves another 512 parent tokens for bounded review.
Percentages use character totals before rounding token estimates.

Worker input is not eliminated: the three payload estimates are 31,586, 64,460,
and 13,903 tokens. The generation case writes an actual 13,896-byte file.
Its body is excluded from this constructed parent-after accounting; that is not
a measurement of every token in a live host's reasoning, history, or tool trace.
Coarse numeric evidence is saved in [evals/results/benchmark.json](evals/results/benchmark.json).

<details>
<summary>Earlier stub snapshot, before the current skill wording</summary>

| Case | Parent before | Parent after | Reduction |
|---|---:|---:|---:|
| One large-file question | 30,850 | 793 | 97.43% |
| Multi-file question | 62,390 | 828 | 98.67% |
| Generate to disk | 17,700 | 1,414 | 92.01% |

These are historical results, not the current run. Skill text is counted, so
clarifying the scripted and native paths increases delegation overhead.

</details>

**The bounded-read counterfactual matters.** Copilot already supports
`view_range`. For questions about first/last anchors, a few targeted windows
could avoid most of the whole-file baseline too. This benchmark does not measure
that optimized workflow or establish an incremental advantage over it. The large
percentages are versus whole-file ingest, not the only reasonable alternative.

### Optional live run

```sh
npm run eval:live
```

This uses real Copilot and original fixtures, requires authentication and model
access, and fails explicitly when either is missing. It checks exact file anchors
and a generated module's output contract and syntax, not general code quality.

Rerun on 2026-09-12 with Copilot CLI 1.0.84-2: both exact first/last-anchor
requests passed, and a 13,998-byte ES module was written and syntax-checked.
The successful reported models were `claude-haiku-4.5` and `gpt-5.4-mini`.
This confirms the current worker transport and output contract, not live savings.

`evals/results/live.json` is a local, gitignored record, not evidence reproduced
by a clone or by the offline suite. Any older copy is historical unless the live
command is rerun. Parent generated-body tokens are **not measured**.

## How it works

A version 1 `preToolUse` hook uses the documented `view|bash|powershell` matcher
so unrelated tools do not launch it. The same hook ships Bash and PowerShell
launchers. A token-policy denial returns `permissionDecision: "deny"` and a
short routing hint. Pass-through is a neutral `{}`; Copilot still applies its
normal tool, path, and URL permissions.

The default threshold is 350 lines. A finite window at or below that threshold
passes. Oversized ranges, EOF suffixes, and host variants with `offset`/`limit`
are classified by how many lines remain to be read. On a 701-line file,
`[2, -1]` and `[2, 352]` are denied, while `[2, 351]` and the 350-line suffix
`[352, -1]` pass. Missing files and directory listings remain the host's concern.
The counter stops at the threshold, with a 1.5-second deadline and 8 MiB scan
ceiling; an unclassifiable large read is denied.

The shell recognizer checks known full-dump forms such as `cat`, pagers,
unbounded `sed`/`awk`, and PowerShell `Get-Content` without executing the command.
Pipes, stdout redirection, bounded shell forms, and search output are outside this
line-budget enforcement. A pipe can still print everything. This is a routing
guardrail, **not a sandbox or DLP**.

The scripted adapter validates explicit paths, loads the work order, and pipes
JSON to a one-shot CLI process. It deliberately omits `-p`, which would discard
stdin. A temporary `COPILOT_HOME` and `tools: []` worker profile keep parent
history, custom instructions, plugins, and MCP configuration out of that process.
The supported `shell`, `write`, and `url` denial rules complement the tool-free
profile.

The adapter requires a matching model report in JSONL. Missing model evidence,
any mismatched report, a tool attempt, malformed output, or a session error
withholds the answer and generated target. Only explicit model unavailability
can retry the configured cheap fallback.

Inputs must be regular UTF-8 files inside `--root`; input symlinks cannot escape
it. The writer requires a reference. Target directories must already exist and
must not use symlinks. Existing targets require `--overwrite`; concurrent changes
are rejected. Successful writes are atomic, with private permissions for new
files on Unix.

Compact answers and code without a target are capped at 4,096 UTF-8 bytes.
Generated disk output is capped at 1 MiB. Outer code fences are stripped, and
failures return no partial answer. With a target, stdout contains only
`written`, `bytes`, and `model`; stderr contains coarse model/byte metadata,
not the child's transcript.

### Authentication and host behavior

Supply supported CLI authentication through `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
or `GITHUB_TOKEN` using a secret manager or secure shell credential facility.
A login cached only in your normal Copilot home is not copied to the worker.
Never commit credentials or capture source-bearing diagnostics for publication.

Private worker files are removed after success or failure. A crash or forced
termination can leave a `.tokenreducer-*` directory; inspect and remove only that
specific directory. The adapter cannot control GitHub service retention or an
OS administrator's access to memory.

Project trust, hook discovery, and timeouts are host behavior. Command hook
crashes and nonzero exits fail closed, but **Copilot hook timeouts are fail-open**.
The configured timeout is 10 seconds; the shorter scan deadline cannot interrupt
a stalled filesystem. If the gate is silent, check trust and discovery, then
try a known over-threshold file. Silence alone does not prove an installation.

The documented event has no trusted parent/worker discriminator. Native workers
use bounded windows too; there is no environment-variable bypass. Arbitrary
interpreters, custom tools, MCP output, large grep results, pasted attachments,
and filesystem races are not controlled. A line threshold is not a byte limit.

Cloud jobs can discover committed `.github/skills`, `.github/hooks`, and
`.github/agents`, and run the Bash hook. Personal installations are local CLI
configuration. Model selection and native spawning vary by host; a profile's
`model` field does not guarantee cloud routing. Scripted workers need the
official CLI and supported authentication in that job.

## Configuration

| Role | Default | Unavailable-model fallback |
|---|---|---|
| Coordinator | Your selected session model | Never changed by TokenReducer |
| Bulk reader | `claude-haiku-4.5` | `gpt-5-mini` |
| Code writer | `gpt-5.4-mini` | `gpt-5-mini` |

These are Copilot model IDs, not external provider endpoints. Model availability,
plan limits, and prices vary. No classifier model is needed for the gate.
An override is your explicit cost choice; automatic fallback never selects the
coordinator or a frontier model. `auto` is rejected.

| Environment variable | Default | Meaning |
|---|---|---|
| `TOKENREDUCER_LINE_THRESHOLD` | `350` | Maximum lines in a classified read; configurable from 1 to 100,000 |
| `TOKENREDUCER_MAX_PAYLOAD_BYTES` | `1048576` | Combined serialized UTF-8 work order, including rules and file text; maximum 16 MiB |
| `TOKENREDUCER_TIMEOUT_SECONDS` | `120` | Worker deadline shared by fallback attempts; maximum 3,600 seconds |
| `TOKENREDUCER_BULK_READER_MODEL` | `claude-haiku-4.5` | Explicit reader model |
| `TOKENREDUCER_CODE_WRITER_MODEL` | `gpt-5.4-mini` | Explicit writer model |
| `TOKENREDUCER_COPILOT_BIN` | `copilot` on PATH | Absolute native executable or `.js`/`.mjs`/`.cjs` entry point; not a shell shim |

Scripts read overrides on every call. Native profile YAML is static; the
installer renders the current model overrides, so reinstall with `--overwrite`
after changing them. Host preferences can still override a native profile.
Auth errors, timeouts, missing model reports, malformed output, and empty answers
do not trigger model fallback.

## What is not delegated

Debugging, architectural decisions, surgical edits, and a single small-file
question stay on the selected parent model. Review generated code with bounded
`view_range` windows and run the relevant project checks. Do not read the whole
target back just to prove it exists. Ask a new worker for follow-up facts instead
of replaying a transcript. A concise wrong answer is not useful savings.

## Prior art

This experiment stands on other people's work. The closest public implementation
prior art is Spotify's [shunt plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt):
a read gate, named cheap workers, and routing skills, backed by Portal/AiKA.
TokenReducer implements that broad pattern natively for Copilot without porting
shunt's source or including the Spotify runtime.

| Research or tool | Relevant idea, not a claim of reproducing its results |
|---|---|
| [FrugalGPT](https://arxiv.org/abs/2305.05176), TMLR 2024 | Cost/quality tradeoffs and cascades across language models |
| [RouteLLM](https://arxiv.org/abs/2406.18665) | Learning model routing from preference data |
| [AutoMix](https://arxiv.org/abs/2310.12963) | Using verification and model escalation rather than spending equally on every request |
| [LLMLingua](https://arxiv.org/abs/2310.05736) and [LongLLMLingua](https://arxiv.org/abs/2310.06839) | Prompt compression; TokenReducer instead keeps the uncompressed corpus in a worker |
| [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/), TACL 2024 | Long-context performance depends on where relevant evidence appears |
| [SWE-agent](https://arxiv.org/abs/2405.15793) | Agent-computer interfaces, including bounded file viewers |
| [Aider's repository map](https://aider.chat/docs/repomap.html) | Supplying selected structure instead of every source byte |
| [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Simple, composable workflows and orchestrator/worker patterns |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601) | Treating large context as external and using subcalls to examine it |

What is original here is the Copilot wiring and implementation: hooks, skills,
native profiles, and a scripted stdin adapter. It does not implement a learned
router, a paper's compression algorithm, or recursive inference.

Host contracts: [hooks](https://docs.github.com/en/copilot/reference/hooks-reference),
[skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills),
[custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli),
and [programmatic CLI usage](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically).
The permission kinds were checked against `copilot help permissions` in
Copilot CLI 1.0.84-2.

## License

[MIT](LICENSE). Copyright (c) 2026 Brian Baldock.
