import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ROOT, assertDecision, bashQuote, exists, hookPayload, powershellAvailable,
  powershellQuote, runHook, workspace,
} from './helpers.mjs';

const lineText = (count, ending = '\n', final = true) =>
  Array.from({ length: count }, (_, index) => `HOOK_ORIGINAL_ROW_${index + 1}`).join(ending) + (final ? ending : '');

async function hookFiles(t) {
  const work = await workspace(undefined, 'hook');
  t.after(async () => {
    try {
      assert.equal(await exists(path.join(work.root, 'recognizer-marker.txt')), false, 'The recognizer must never execute a payload command.');
    } finally {
      await work.cleanup();
    }
  });
  const files = new Map([
    ['large.txt', lineText(701)],
    ['over-boundary.txt', lineText(351)],
    ['boundary.txt', lineText(350)],
    ['boundary-no-newline.txt', lineText(350, '\n', false)],
    ['large-no-newline.txt', lineText(351, '\n', false)],
    ['boundary-crlf.txt', lineText(350, '\r\n')],
    ['large-crlf.txt', lineText(351, '\r\n')],
    ['blank-lines.txt', '\n'.repeat(351)],
    ['small.txt', lineText(2)],
    ['empty.txt', ''],
    ['one-line.txt', 'Original single line without a final newline.'],
    ['large with spaces.txt', lineText(351)],
    ["large'quote.txt", lineText(351)],
    ["small'quote.txt", 'Original small quoted path.\n'],
    ['large;touch recognizer-marker.txt', lineText(351)],
    ['small;touch recognizer-marker.txt', 'Original small semicolon path.\n'],
    ['large # named.txt', lineText(351)],
    ['-large.txt', lineText(351)],
    ['$LITERAL', 'Original literal dollar path.\n'],
  ]);
  if (process.platform !== 'win32') {
    files.set('large|named.txt', lineText(351));
    files.set('small|named.txt', 'Original small pipe path.\n');
    files.set('*.txt', 'Original literal glob path.\n');
  }
  await Promise.all([...files].map(([file, text]) => writeFile(path.join(work.root, file), text)));
  await writeFile(path.join(work.outside, 'outside.txt'), lineText(351));
  await mkdir(path.join(work.root, 'directory'));
  await symlink(path.join(work.outside, 'outside.txt'), path.join(work.root, 'outside-link.txt'));
  return work;
}

test('host hook configuration is version 1 Copilot schema with real launchers', async (t) => {
  const { root } = await hookFiles(t);
  const config = JSON.parse(await readFile(path.join(ROOT, '.github/hooks/tokenreducer.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config).sort(), ['hooks', 'version']);
  assert.deepEqual(Object.keys(config.hooks), ['preToolUse']);
  assert.ok(Array.isArray(config.hooks.preToolUse));
  assert.equal(config.hooks.preToolUse.length, 1);
  const command = config.hooks.preToolUse[0];
  assert.deepEqual(Object.keys(command).sort(), ['bash', 'cwd', 'matcher', 'powershell', 'timeoutSec', 'type']);
  assert.equal(command.type, 'command');
  assert.equal(command.matcher, 'view|bash|powershell');
  const matcher = new RegExp(`^(?:${command.matcher})$`);
  for (const tool of ['view', 'bash', 'powershell']) assert.equal(matcher.test(tool), true);
  for (const tool of ['edit', 'create', 'task', 'grep', 'glob', 'web_fetch', 'preview', 'bash_extra']) {
    assert.equal(matcher.test(tool), false);
  }
  assert.equal(command.cwd, '.');
  assert.ok(Number.isInteger(command.timeoutSec) && command.timeoutSec > 0);
  assert.match(command.bash, /read-gate\.sh/);
  assert.match(command.powershell, /read-gate\.ps1/);
  assert.equal(Object.hasOwn(config.hooks, 'PreToolUse'), false);
  assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'large.txt' }), { configuredCommand: command.bash }), 'deny');
  if (await powershellAvailable(root)) {
    assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'small.txt' }), {
      launcher: 'powershell', configuredCommand: command.powershell,
    }), 'pass');
  }
});

test('gate pass-through never grants tool permissions', async (t) => {
  const { root, outside } = await hookFiles(t);
  const outsidePath = path.join(outside, 'outside.txt');
  const cases = [
    ['outside-root edit', 'edit', { path: outsidePath }],
    ['outside-root creation', 'create', { path: path.join(outside, 'new.txt') }],
    ['patch tool', 'apply_patch', {}],
    ['bounded outside-root read', 'view', { path: outsidePath, view_range: [1, 1] }],
    ['shell write', 'bash', { command: 'touch recognizer-marker.txt' }],
    ['PowerShell write', 'powershell', { command: 'Set-Content recognizer-marker.txt inert' }],
    ['redirected dump', 'bash', { command: 'cat large.txt > captured.txt' }],
    ['network tool', 'web_fetch', { url: 'https://example.invalid' }],
    ['MCP tool', 'example-mcp/write-record', {}],
  ];
  for (const [name, tool, args] of cases) {
    await t.test(name, async () => {
      assertDecision(await runHook(root, hookPayload(root, tool, args)), 'pass');
    });
  }
});

test('Unix launcher enforces the full-view, range, and line-boundary matrix using real JSON', async (t) => {
  const { root, outside } = await hookFiles(t);
  const cases = [
    ['701-line full view', { path: 'large.txt' }, 'deny'],
    ['351-line full view', { path: 'over-boundary.txt' }, 'deny'],
    ['350-line boundary', { path: 'boundary.txt' }, 'pass'],
    ['350 lines without a final newline', { path: 'boundary-no-newline.txt' }, 'pass'],
    ['351 lines without a final newline', { path: 'large-no-newline.txt' }, 'deny'],
    ['350 CRLF lines', { path: 'boundary-crlf.txt' }, 'pass'],
    ['351 CRLF lines', { path: 'large-crlf.txt' }, 'deny'],
    ['blank lines still count', { path: 'blank-lines.txt' }, 'deny'],
    ['small file', { path: 'small.txt' }, 'pass'],
    ['empty file', { path: 'empty.txt' }, 'pass'],
    ['one unterminated line', { path: 'one-line.txt' }, 'pass'],
    ['missing file', { path: 'does-not-exist.txt' }, 'pass'],
    ['directory listing', { path: 'directory' }, 'pass'],
    ['absolute path inside root', { path: path.join(root, 'large.txt') }, 'deny'],
    ['outside full read', { path: path.join(outside, 'outside.txt') }, 'deny'],
    ['symlink escaping root', { path: 'outside-link.txt' }, 'deny'],
    ['explicit full range', { path: 'large.txt', view_range: [1, -1] }, 'deny'],
    ['force flag does not bypass full read', { path: 'large.txt', forceReadLargeFiles: true }, 'deny'],
    ['finite range', { path: 'large.txt', view_range: [1, 20] }, 'pass'],
    ['single-line range', { path: 'large.txt', view_range: [701, 701] }, 'pass'],
    ['finite 350-line window', { path: 'large.txt', view_range: [2, 351] }, 'pass'],
    ['finite 351-line window', { path: 'large.txt', view_range: [2, 352] }, 'deny'],
    ['oversized finite range', { path: 'large.txt', view_range: [2, 1_000_000] }, 'deny'],
    ['oversized finite range on a small file', { path: 'small.txt', view_range: [1, 1_000_000] }, 'pass'],
    ['finite range with only three remaining lines', { path: 'large.txt', view_range: [699, 1_000_000] }, 'pass'],
    ['unbounded suffix with 700 remaining lines', { path: 'large.txt', view_range: [2, -1] }, 'deny'],
    ['unbounded suffix with 351 remaining lines', { path: 'large.txt', view_range: [351, -1] }, 'deny'],
    ['unbounded suffix with 350 remaining lines', { path: 'large.txt', view_range: [352, -1] }, 'pass'],
    ['unbounded suffix beyond EOF', { path: 'large.txt', view_range: [702, -1] }, 'pass'],
    ['suffix counts the unterminated last line', { path: 'large-no-newline.txt', view_range: [2, -1] }, 'pass'],
    ['suffix counts CRLF lines once', { path: 'large-crlf.txt', view_range: [2, -1] }, 'pass'],
    ['positive offset still exposes 700 lines', { path: 'large.txt', offset: 1 }, 'deny'],
    ['offset leaves 351 lines', { path: 'large.txt', offset: 350 }, 'deny'],
    ['offset leaves 350 lines', { path: 'large.txt', offset: 351 }, 'pass'],
    ['offset beyond EOF', { path: 'large.txt', offset: 701 }, 'pass'],
    ['zero offset is a full read', { path: 'large.txt', offset: 0 }, 'deny'],
    ['positive limit', { path: 'large.txt', limit: 1 }, 'pass'],
    ['350-line limit', { path: 'large.txt', limit: 350 }, 'pass'],
    ['351-line limit', { path: 'large.txt', limit: 351 }, 'deny'],
    ['huge positive limit', { path: 'large.txt', limit: Number.MAX_SAFE_INTEGER }, 'deny'],
    ['huge limit on a small file', { path: 'small.txt', limit: Number.MAX_SAFE_INTEGER }, 'pass'],
    ['oversized offset window', { path: 'large.txt', offset: 1, limit: 351 }, 'deny'],
    ['huge limit with only 350 remaining lines', { path: 'large.txt', offset: 351, limit: Number.MAX_SAFE_INTEGER }, 'pass'],
    ['zero offset plus positive limit', { path: 'large.txt', offset: 0, limit: 20 }, 'pass'],
    ['range starts at zero', { path: 'large.txt', view_range: [0, -1] }, 'deny'],
    ['reversed range', { path: 'large.txt', view_range: [20, 1] }, 'deny'],
    ['range with invalid negative end', { path: 'large.txt', view_range: [1, -2] }, 'deny'],
    ['range missing end', { path: 'large.txt', view_range: [1] }, 'deny'],
    ['range with extra member', { path: 'large.txt', view_range: [1, 2, 3] }, 'deny'],
    ['fractional range', { path: 'large.txt', view_range: [1, 2.5] }, 'deny'],
    ['unsafe range end', { path: 'large.txt', view_range: [1, Number.MAX_SAFE_INTEGER + 1] }, 'deny'],
    ['unsafe range start', { path: 'large.txt', view_range: [Number.MAX_SAFE_INTEGER + 1, -1] }, 'deny'],
    ['string range', { path: 'large.txt', view_range: '[1,20]' }, 'deny'],
    ['string range member', { path: 'large.txt', view_range: [1, '20'] }, 'deny'],
    ['negative offset', { path: 'large.txt', offset: -1 }, 'deny'],
    ['fractional offset', { path: 'large.txt', offset: 0.5 }, 'deny'],
    ['unsafe offset', { path: 'large.txt', offset: Number.MAX_SAFE_INTEGER + 1 }, 'deny'],
    ['string offset', { path: 'large.txt', offset: '1' }, 'deny'],
    ['zero limit', { path: 'large.txt', limit: 0 }, 'deny'],
    ['negative limit', { path: 'large.txt', limit: -1 }, 'deny'],
    ['fractional limit', { path: 'large.txt', limit: 1.5 }, 'deny'],
    ['unsafe limit', { path: 'large.txt', limit: Number.MAX_SAFE_INTEGER + 1 }, 'deny'],
    ['string limit', { path: 'large.txt', limit: '1' }, 'deny'],
    ['missing path', {}, 'deny'],
    ['empty path', { path: '' }, 'deny'],
    ['control character in path', { path: 'bad\npath' }, 'deny'],
  ];
  for (const [name, args, decision] of cases) {
    await t.test(name, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'view', args)), decision);
    });
  }
  for (const [name, args, decision] of cases.slice(0, 4)) {
    await t.test(`JSON-string toolArgs: ${name}`, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'view', JSON.stringify(args))), decision);
    });
  }
});

test('Unix hook fails closed on malformed JSON and configuration without using Claude schemas', async (t) => {
  const { root } = await hookFiles(t);
  const malformed = [
    ['empty input', ''],
    ['truncated JSON', '{"toolName":'],
    ['null input', 'null'],
    ['array input', '[]'],
    ['scalar input', '"view"'],
    ['missing tool name', { cwd: root, toolArgs: {} }],
    ['nonstring tool name', { cwd: root, toolName: 3, toolArgs: {} }],
    ['Claude snake_case input', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'large.txt' }, cwd: root }],
    ['malformed serialized arguments', hookPayload(root, 'view', '{bad')],
    ['serialized null arguments', hookPayload(root, 'view', 'null')],
    ['serialized scalar arguments', hookPayload(root, 'view', '"large.txt"')],
    ['array arguments', hookPayload(root, 'view', [])],
    ['null arguments', hookPayload(root, 'view', null)],
    ['missing arguments', { cwd: root, toolName: 'view' }],
    ['missing cwd', { toolName: 'view', toolArgs: { path: 'large.txt' } }],
    ['oversized host envelope', JSON.stringify(hookPayload(root, 'view', { path: 'small.txt' }, { padding: 'x'.repeat(1_048_576) }))],
  ];
  for (const [name, payload] of malformed) {
    await t.test(name, async () => assertDecision(await runHook(root, payload), 'deny'));
  }
  for (const setting of ['0', '-1', '1.5', '', 'NaN', '100001', ' 350']) {
    await t.test(`invalid threshold ${JSON.stringify(setting)}`, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'small.txt' }), {
        env: { TOKENREDUCER_LINE_THRESHOLD: setting },
      }), 'deny');
    });
  }
  await t.test('explicit threshold changes the boundary', async () => {
    assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'over-boundary.txt' }), {
      env: { TOKENREDUCER_LINE_THRESHOLD: '351' },
    }), 'pass');
  });
  for (const [name, args, decision] of [
    ['finite window at threshold', { path: 'large.txt', view_range: [2, 21] }, 'pass'],
    ['finite window above threshold', { path: 'large.txt', view_range: [2, 22] }, 'deny'],
    ['suffix at threshold', { path: 'large.txt', view_range: [682, -1] }, 'pass'],
    ['suffix above threshold', { path: 'large.txt', view_range: [681, -1] }, 'deny'],
    ['limit above threshold', { path: 'large.txt', limit: 21 }, 'deny'],
  ]) {
    await t.test(`configured threshold: ${name}`, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'view', args), {
        env: { TOKENREDUCER_LINE_THRESHOLD: '20' },
      }), decision);
    });
  }
  await t.test('native subagent labels are not bypass markers', async () => {
    assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'large.txt' }, {
      agentName: 'bulk-reader', agentType: 'task', isSubagent: true, parentSessionId: 'parent-eval',
    }), { env: { TOKENREDUCER_WORKER: '1', TOKENREDUCER_BYPASS: '1' } }), 'deny');
  });
  for (const tool of ['rg', 'glob', 'task']) {
    await t.test(`unrelated tool ${tool}`, async () => {
      assertDecision(await runHook(root, hookPayload(root, tool, {})), 'pass');
    });
  }
});

test('Unix hook recognizes dumps without executing shell syntax', async (t) => {
  const { root } = await hookFiles(t);
  const largeQuoted = bashQuote("large'quote.txt");
  const smallQuoted = bashQuote("small'quote.txt");
  const cases = [
    ...['cat', 'tac', 'nl', 'less', 'more', 'bat', 'batcat'].flatMap((command) => [
      [`${command} full large file`, `${command} large.txt`, 'deny'],
      [`${command} small file`, `${command} small.txt`, 'pass'],
    ]),
    ['Get-Content in a shell payload', 'Get-Content large.txt', 'deny'],
    ['absolute dumper executable', '/bin/cat large.txt', 'deny'],
    ['quoted dumper name', '"cat" large.txt', 'deny'],
    ['cat numbering flag', 'cat -n large.txt', 'deny'],
    ['nl option argument', 'nl -b a large.txt', 'deny'],
    ['bat option argument', 'bat --paging never large.txt', 'deny'],
    ['option terminator and hyphenated filename', 'cat -- -large.txt', 'deny'],
    ['all named operands are inspected', 'cat small.txt large.txt', 'deny'],
    ['missing operand path is allowed', 'cat absent.txt', 'pass'],
    ['stdout pipeline', 'cat large.txt | head -n 2', 'pass'],
    ['stderr and stdout pipeline', 'cat large.txt |& head -n 2', 'pass'],
    ['pipe plus unknown variable path', 'cat "$FILE" | head -n 2', 'pass'],
    ['stdout redirect', 'cat large.txt > captured.txt', 'pass'],
    ['stdout append', 'cat large.txt >> captured.txt', 'pass'],
    ['explicit stdout redirect', 'cat large.txt 1> captured.txt', 'pass'],
    ['explicit stdout append', 'cat large.txt 1>> captured.txt', 'pass'],
    ['combined output redirect', 'cat large.txt &> captured.txt', 'pass'],
    ['combined output append', 'cat large.txt &>> captured.txt', 'pass'],
    ['stderr-only redirect is not a stdout bound', 'cat large.txt 2> errors.txt', 'deny'],
    ['stderr duplication is not a stdout bound', 'cat large.txt 2>&1', 'deny'],
    ['stdin redirection still dumps', 'cat < large.txt', 'deny'],
    ['stdin with a real output pipe', 'cat < large.txt | head -n 1', 'pass'],
    ['quoted pipe token is data', 'cat large.txt "|"', 'deny'],
    ['single-quoted pipe token is data', "cat large.txt '|'", 'deny'],
    ['escaped pipe token is data', 'cat large.txt \\|', 'deny'],
    ['quoted stdout redirect token is data', "cat large.txt '>'", 'deny'],
    ['commented pipeline is not real', 'cat large.txt # | head -n 1', 'deny'],
    ['logical OR is not a pipeline', 'cat large.txt || true', 'deny'],
    ['unbounded first chained statement', 'cat large.txt; cat small.txt | head -n 1', 'deny'],
    ['unbounded last chained statement', 'cat small.txt | head -n 1; cat large.txt', 'deny'],
    ['unbounded AND statement', 'cat large.txt && cat small.txt | head -n 1', 'deny'],
    ['unbounded OR statement', 'cat large.txt || cat small.txt | head -n 1', 'deny'],
    ['unbounded background statement', 'cat large.txt & printf ok | head -n 1', 'deny'],
    ['mixed safe statements', 'cat small.txt && cat large.txt | head -n 1', 'pass'],
    ['newline-separated dump', 'printf ok | head -n 1\ncat large.txt', 'deny'],
    ['dump after a comment newline', 'echo safe # ignored\ncat large.txt', 'deny'],
    ['variable operand', 'cat $FILE', 'deny'],
    ['double-quoted variable operand', 'cat "$FILE"', 'deny'],
    ['glob operand', 'cat *.txt', 'deny'],
    ['question-mark glob', 'cat large?.txt', 'deny'],
    ['variable with assignment prefix', 'FILE=large.txt cat "$FILE"', 'deny'],
    ['literal dollar in single quotes', "cat '$LITERAL'", 'pass'],
    ['ambiguous dumper option', 'cat --unknown-option large.txt', 'deny'],
    ['unmatched quote around a dump', 'cat "large.txt', 'deny'],
    ['space filename', "cat 'large with spaces.txt'", 'deny'],
    ['single quote filename', `cat ${largeQuoted}`, 'deny'],
    ['small single quote filename', `cat ${smallQuoted}`, 'pass'],
    ['semicolon filename is data', `cat ${bashQuote('large;touch recognizer-marker.txt')}`, 'deny'],
    ['small semicolon filename is data', `cat ${bashQuote('small;touch recognizer-marker.txt')}`, 'pass'],
    ['hash inside filename is data', "cat 'large # named.txt'", 'deny'],
    ['command wrapper', 'command cat large.txt', 'deny'],
    ['env wrapper', 'env MODE=test cat large.txt', 'deny'],
    ['sudo wrapper', 'sudo -- cat large.txt', 'deny'],
    ['nested Bash command', "bash -lc 'cat large.txt'", 'deny'],
    ['nested POSIX shell', "sh -c 'cat large.txt'", 'deny'],
    ['bounded head', 'head -n 20 large.txt', 'pass'],
    ['bounded tail', 'tail -n 20 large.txt', 'pass'],
    ['tail from first line is a full dump', 'tail -n +1 large.txt', 'deny'],
    ['head negative count is not a bounded prefix', 'head -n -1 large.txt', 'deny'],
    ['bounded sed', "sed -n '1,20p' large.txt", 'pass'],
    ['full sed', "sed -n '1,$p' large.txt", 'deny'],
    ['unbounded sed substitution with quoted pipe', "sed 's/|/x/' large.txt", 'deny'],
    ['bounded awk', "awk 'NR <= 20 { print }' large.txt", 'pass'],
    ['full awk', "awk '{print}' large.txt", 'deny'],
    ['bounded bat', 'bat --line-range 1:20 large.txt', 'pass'],
    ['unrelated search', 'rg --line-number cedar large.txt', 'pass'],
    ['unrelated build', 'node --version', 'pass'],
    ['command lookup is not a dump', 'command -v cat', 'pass'],
    ['dumper help is not a dump', 'cat --help', 'pass'],
    ['quoted mention is not a command', "echo 'cat large.txt'", 'pass'],
    ['unrelated redirection is never executed', 'printf inert > recognizer-marker.txt', 'pass'],
    ['command substitution is never executed', 'cat "$(touch recognizer-marker.txt)" large.txt', 'deny'],
    ['backtick substitution is never executed', 'cat `touch recognizer-marker.txt` large.txt', 'deny'],
    ['unbounded substitution inside an output command', 'printf "%s\\n" "$(cat large.txt)"', 'deny'],
  ];
  if (process.platform !== 'win32') {
    cases.push(
      ['quoted pipe inside filename', "cat 'large|named.txt'", 'deny'],
      ['escaped pipe inside filename', 'cat large\\|named.txt', 'deny'],
      ['small quoted pipe filename', "cat 'small|named.txt'", 'pass'],
      ['literal quoted glob filename', "cat '*.txt'", 'pass'],
    );
  }
  for (const [name, command, decision] of cases) {
    await t.test(name, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'bash', { command })), decision);
    });
  }
});

test('PowerShell command recognition treats quoted data and real pipelines separately', async (t) => {
  const { root } = await hookFiles(t);
  const cases = [
    ['Get-Content full dump', 'Get-Content large.txt', 'deny'],
    ['case-insensitive command', 'gEt-CoNtEnT large.txt', 'deny'],
    ['gc alias', 'gc large.txt', 'deny'],
    ['raw dump', 'Get-Content -Raw large.txt', 'deny'],
    ['literal path', 'Get-Content -LiteralPath large.txt', 'deny'],
    ['encoding option', 'Get-Content -Encoding utf8 -Path large.txt', 'deny'],
    ['bounded total count', 'Get-Content large.txt -TotalCount 10', 'pass'],
    ['bounded tail', 'Get-Content large.txt -Tail 10', 'pass'],
    ['real pipeline', 'Get-Content large.txt | Select-Object -First 10', 'pass'],
    ['stdout redirection', 'Get-Content large.txt > captured.txt', 'pass'],
    ['all-stream redirection', 'Get-Content large.txt *> captured.txt', 'pass'],
    ['all-stream append', 'Get-Content large.txt *>> captured.txt', 'pass'],
    ['stderr-only redirection', 'Get-Content large.txt 2> errors.txt', 'deny'],
    ['quoted pipe is data', "Get-Content large.txt '|'", 'deny'],
    ['backtick-escaped pipe is data', 'Get-Content large.txt `|', 'deny'],
    ['chained unbounded statement', 'Get-Content large.txt; Get-Content small.txt | Select-Object -First 1', 'deny'],
    ['variable path', 'Get-Content $file', 'deny'],
    ['glob path', 'Get-Content *.txt', 'deny'],
    ['array expression path', "Get-Content @('large.txt')", 'deny'],
    ['space path', "Get-Content 'large with spaces.txt'", 'deny'],
    ['escaped single quote path', `Get-Content ${powershellQuote("large'quote.txt")}`, 'deny'],
    ['small escaped single quote path', `Get-Content ${powershellQuote("small'quote.txt")}`, 'pass'],
    ['semicolon path is data', `Get-Content ${powershellQuote('large;touch recognizer-marker.txt')}`, 'deny'],
    ['small semicolon path is data', `Get-Content ${powershellQuote('small;touch recognizer-marker.txt')}`, 'pass'],
    ['unrelated command', 'Get-Date', 'pass'],
    ['subexpression is never executed', 'Get-Content $(Set-Content recognizer-marker.txt inert)', 'deny'],
  ];
  for (const [name, command, decision] of cases) {
    await t.test(name, async () => {
      assertDecision(await runHook(root, hookPayload(root, 'powershell', { command })), decision);
    });
  }
});

test('the actual PowerShell launcher preserves stdin JSON and decisions', async (t) => {
  const { root } = await hookFiles(t);
  if (!await powershellAvailable(root)) {
    t.skip('pwsh is not installed; Unix coverage still runs.');
    return;
  }
  const cases = [
    ['full view deny', hookPayload(root, 'view', { path: 'large.txt' }), 'deny'],
    ['350-line allow', hookPayload(root, 'view', { path: 'boundary.txt' }), 'pass'],
    ['no final newline deny', hookPayload(root, 'view', { path: 'large-no-newline.txt' }), 'deny'],
    ['bounded view allow', hookPayload(root, 'view', { path: 'large.txt', view_range: [1, 5] }), 'pass'],
    ['unbounded suffix deny', hookPayload(root, 'view', { path: 'large.txt', view_range: [2, -1] }), 'deny'],
    ['350-line suffix allow', hookPayload(root, 'view', { path: 'large.txt', view_range: [352, -1] }), 'pass'],
    ['oversized window deny', hookPayload(root, 'view', { path: 'large.txt', view_range: [2, 352] }), 'deny'],
    ['huge limit deny', hookPayload(root, 'view', { path: 'large.txt', limit: 1_000_000 }), 'deny'],
    ['serialized arguments', hookPayload(root, 'view', JSON.stringify({ path: 'large.txt' })), 'deny'],
    ['small view allow', hookPayload(root, 'view', { path: 'small.txt' }), 'pass'],
    ['missing file allow', hookPayload(root, 'view', { path: 'absent.txt' }), 'pass'],
    ['directory listing allow', hookPayload(root, 'view', { path: 'directory' }), 'pass'],
    ['Get-Content deny', hookPayload(root, 'powershell', { command: 'Get-Content large.txt' }), 'deny'],
    ['Get-Content pipe allow', hookPayload(root, 'powershell', { command: 'Get-Content large.txt | Select-Object -First 1' }), 'pass'],
    ['quoted pipe deny', hookPayload(root, 'powershell', { command: "Get-Content large.txt '|'" }), 'deny'],
    ['malformed input deny', '{bad', 'deny'],
    ['legacy schema deny', { tool_name: 'Read', tool_input: { file_path: 'large.txt' } }, 'deny'],
  ];
  for (const [name, payload, decision] of cases) {
    await t.test(name, async () => {
      assertDecision(await runHook(root, payload, { launcher: 'powershell' }), decision);
    });
  }
  await t.test('malformed threshold deny', async () => {
    assertDecision(await runHook(root, hookPayload(root, 'view', { path: 'small.txt' }), {
      launcher: 'powershell', env: { TOKENREDUCER_LINE_THRESHOLD: 'invalid' },
    }), 'deny');
  });
});
