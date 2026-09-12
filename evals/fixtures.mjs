import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.join(EVAL_ROOT, 'fixtures');
export const FIXTURES = Object.freeze([
  Object.freeze({
    id: 'harbor', file: 'harbor-ledger.txt', lines: 840,
    first: 'TR_HARBOR_FIRST_000001', last: 'TR_HARBOR_LAST_000840',
  }),
  Object.freeze({
    id: 'cedar', file: 'cedar-protocol.txt', lines: 920,
    first: 'TR_CEDAR_FIRST_000001', last: 'TR_CEDAR_LAST_000920',
  }),
  Object.freeze({
    id: 'reference', file: 'reference-validator.mjs', lines: 760,
    first: 'TR_REFERENCE_FIRST_000001', last: 'TR_REFERENCE_LAST_000760',
  }),
]);

function ledger(fixture) {
  const lines = [`${fixture.first} | Original synthetic harbor ingestion ledger.`];
  const docks = ['slate', 'maple', 'granite', 'birch', 'quartz'];
  for (let line = 2; line < fixture.lines; line++) {
    const dock = docks[line % docks.length];
    lines.push(`${String(line).padStart(4, '0')} | dock=${dock} | batch=harbor_${line} | accepted=${line % 47 + 3} | rejected=${line % 5} | route=queue_${line % 11} | policy=retain receipt; acknowledge only after durable write.`);
  }
  lines.push(`${fixture.last} | End of the original harbor ledger; no later records.`);
  return `${lines.join('\n')}\n`;
}

function protocol(fixture) {
  const lines = [`${fixture.first} | Original synthetic cedar relay protocol observations.`];
  const phases = ['queued', 'validated', 'committed', 'acknowledged'];
  for (let line = 2; line < fixture.lines; line++) {
    lines.push(`${String(line).padStart(4, '0')} | relay=cedar_${line % 17} | phase=${phases[line % phases.length]} | sequence=${line * 13} | window=${line % 23 + 1} | note=Keep the prior receipt until the next checkpoint is confirmed.`);
  }
  lines.push(`${fixture.last} | End of the original cedar observations; checkpoint complete.`);
  return `${lines.join('\n')}\n`;
}

function reference(fixture) {
  const prefix = [
    `// ${fixture.first}`,
    '// Original evaluation reference. This file has no external source or dependencies.',
    'export const allowedSignals = Object.freeze([',
  ];
  const suffix = [
    ']);',
    '',
    'export function validateSignal(input) {',
    "  if (input === null || typeof input !== 'object' || Array.isArray(input)) {",
    "    throw new TypeError('Expected a signal object.');",
    '  }',
    "  if (typeof input.name !== 'string' || !Number.isSafeInteger(input.count)) {",
    "    throw new TypeError('Expected a named signal with an integer count.');",
    '  }',
    '  const definition = allowedSignals.find((entry) => entry.name === input.name);',
    '  if (!definition || input.count < 0 || input.count > definition.ceiling) {',
    "    throw new RangeError('Signal count is outside the allowed range.');",
    '  }',
    '  return Object.freeze({ name: input.name, count: input.count, unit: definition.unit });',
    '}',
    `// ${fixture.last}`,
  ];
  const entries = Array.from({ length: fixture.lines - prefix.length - suffix.length }, (_, index) =>
    `  Object.freeze({ name: 'signal_${String(index + 1).padStart(4, '0')}', ceiling: ${index % 91 + 10}, unit: 'events' }),`);
  return `${[...prefix, ...entries, ...suffix].join('\n')}\n`;
}

export function fixtureContents() {
  return new Map(FIXTURES.map((fixture) => [
    fixture.file,
    fixture.id === 'harbor' ? ledger(fixture) : fixture.id === 'cedar' ? protocol(fixture) : reference(fixture),
  ]));
}

export async function generateFixtures(directory = FIXTURE_ROOT) {
  const relative = path.relative(EVAL_ROOT, path.resolve(directory));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Evaluation fixtures must stay under evals/.');
  }
  await mkdir(directory, { recursive: true });
  for (const [file, content] of fixtureContents()) {
    const target = path.join(directory, file);
    let existing;
    try {
      existing = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing !== content) await writeFile(target, content, { mode: 0o600 });
  }
  return FIXTURES;
}

export function anchorQuestion(fixtures = FIXTURES.slice(0, 2)) {
  return `For each listed file (${fixtures.map((fixture) => fixture.file).join(', ')}), find the unique TR_ anchor on its first line and its last line. Return only JSON {"files":[{"path":"filename","first":"exact first anchor","last":"exact last anchor"}]}. Preserve the listed order. Do not return other file contents.`;
}

export function expectedAnchors(fixtures = FIXTURES.slice(0, 2)) {
  return fixtures.map(({ file, first, last }) => ({ path: file, first, last }));
}

export const GENERATION_MARKER = 'TR_GENERATED_GAUGE_ORIGINAL_2026';
export const GENERATION_SPEC = `Using the original reference's validation, naming, indentation, and frozen-return style, write a self-contained ES module. Export marker = '${GENERATION_MARKER}' and function validateGauge(input). Accept only a non-null, non-array object with name exactly 'harbor' and count a safe integer from 0 through 90. Throw TypeError for wrong types and RangeError for unsupported names or counts outside the range. Return Object.freeze({ name: input.name, count: input.count, unit: 'events' }). Also export generatedReadings as a frozen array of 192 frozen records, named harbor_0001 through harbor_0192, with count equal to the zero-based record index modulo 91 and unit 'events'. No imports, tools, markdown, or explanations.`;

export function generatedStubCode(entries = 192) {
  if (!Number.isSafeInteger(entries) || entries < 1 || entries > 4096) {
    throw new Error('Invalid deterministic stub entry count.');
  }
  const lines = [
    '// STUB: deterministic evaluation output, not live model generation.',
    `export const marker = '${GENERATION_MARKER}';`,
    'export const generatedReadings = Object.freeze([',
    ...Array.from({ length: entries }, (_, index) =>
      `  Object.freeze({ name: 'harbor_${String(index + 1).padStart(4, '0')}', count: ${index % 91}, unit: 'events' }),`),
    ']);',
    '',
    'export function validateGauge(input) {',
    "  if (input === null || typeof input !== 'object' || Array.isArray(input)",
    "      || typeof input.name !== 'string' || !Number.isSafeInteger(input.count)) {",
    "    throw new TypeError('Expected a named gauge with an integer count.');",
    '  }',
    "  if (input.name !== 'harbor' || input.count < 0 || input.count > 90) {",
    "    throw new RangeError('Gauge is outside the allowed range.');",
    '  }',
    "  return Object.freeze({ name: input.name, count: input.count, unit: 'events' });",
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateFixtures();
  console.log(`Generated ${FIXTURES.length} original fixtures (${FIXTURES.map((fixture) => fixture.lines).join(', ')} lines).`);
}
