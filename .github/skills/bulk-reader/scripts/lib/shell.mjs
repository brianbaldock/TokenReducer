const DUMPERS = new Set(['cat', 'tac', 'nl', 'less', 'more', 'bat', 'batcat', 'type', 'get-content', 'gc', 'sed', 'awk', 'head', 'tail']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
const hasDumper = (text) => /(?:^|[\s;|&('"/\\])(?:cat|tac|nl|less|more|bat|batcat|type|get-content|gc|sed|awk|head|tail)(?=$|[\s;|&)'"])/i.test(text);

// This is a recognizer, not a shell interpreter. Nothing here is executed.
export function tokenize(command, powershell = false) {
  const tokens = [];
  let word = '';
  let started = false;
  let dynamic = false;
  let quote = null;
  const flush = () => {
    if (started) tokens.push({ text: word, dynamic, type: 'word' });
    word = '';
    started = false;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        if (powershell && quote === "'" && command[i + 1] === "'") {
          word += "'";
          i++;
        } else {
          quote = null;
        }
      } else if (quote === '"' && ch === (powershell ? '`' : '\\')) {
        if (i + 1 >= command.length) return null;
        word += command[++i];
      } else {
        if (quote === '"' && (ch === '$' || (!powershell && ch === '`'))) dynamic = true;
        word += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === (powershell ? '`' : '\\')) {
      if (i + 1 >= command.length) return null;
      const next = command[++i];
      if (next !== '\n') {
        word += next;
        started = true;
      }
    } else if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (ch === '\n' || /[;|&<>()[\]]/.test(ch) || (!started && /[\d*]/.test(ch) && /^(?:\d+|\*)[<>]/.test(command.slice(i)))) {
      const remaining = command.slice(i);
      const redirect = remaining.match(/^(?:(?:\d+|\*)?(?:>>?|<<?)|&>>?)(?:&\d+)?/);
      if (redirect) {
        flush();
        tokens.push({ text: redirect[0], type: 'redirect' });
        i += redirect[0].length - 1;
      } else {
        flush();
        const operator = remaining.match(/^(?:&&|\|\||\|&|.)/s)[0];
        tokens.push({ text: operator, type: 'operator' });
        i += operator.length - 1;
      }
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      if (/[$*?{}~`]/.test(ch)) dynamic = true;
      word += ch;
      started = true;
    }
  }
  if (quote) return null;
  flush();
  return tokens;
}

function commandName(value) {
  return value.replaceAll('\\', '/').split('/').at(-1).replace(/\.(exe|com)$/i, '').toLowerCase();
}

function lineWindow(start, end) {
  if (!Number.isSafeInteger(start) || start < 1
      || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return null;
  return { offset: start - 1, limit: end === undefined ? undefined : end - start + 1 };
}

function dumpOperands(name, words) {
  let window = name === 'head' || name === 'tail' ? { limit: 10 } : {};
  let hasRange = false;
  let script;
  let quiet = false;
  let endOptions = false;
  const paths = [];
  const takesValue = {
    nl: ['-w', '-s', '-i', '-v', '-n', '-d', '-b', '-f', '-h'],
    bat: ['--language', '-l', '--style', '--theme', '--paging', '--color', '--decorations'],
    batcat: ['--language', '-l', '--style', '--theme', '--paging', '--color', '--decorations'],
    awk: ['-F', '-v'],
    'get-content': ['-encoding', '-delimiter', '-readcount', '-filter', '-include', '-exclude'],
    gc: ['-encoding', '-delimiter', '-readcount', '-filter', '-include', '-exclude'],
  };
  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    const text = token.text;
    const lower = text.toLowerCase();
    if (!endOptions && text === '--') {
      endOptions = true;
      continue;
    }
    if (!endOptions && text.startsWith('-')) {
      if (name === 'get-content' || name === 'gc') {
        if (['-totalcount', '-head', '-first', '-tail', '-last'].includes(lower)) {
          const value = words[++i];
          if (!value || value.dynamic || !/^\d+$/.test(value.text) || !Number.isSafeInteger(Number(value.text))) return null;
          window = { limit: Number(value.text) };
          continue;
        }
        if (['-path', '-literalpath'].includes(lower)) continue;
        if (['-raw', '-force'].includes(lower)) continue;
      }
      if (name === 'bat' || name === 'batcat') {
        const range = text.match(/^(?:--line-range=|-r)(\d+):(\d+)$/);
        if (range || text === '--line-range' || text === '-r') {
          const value = range ? { text: `${range[1]}:${range[2]}` } : words[++i];
          if (hasRange || !value || value.dynamic || !/^\d+:\d+$/.test(value.text)) return null;
          window = lineWindow(...value.text.split(':').map(Number));
          if (!window) return null;
          hasRange = true;
          continue;
        }
      }
      if (name === 'head' || name === 'tail') {
        const count = text.match(/^(?:--(?:lines|bytes)=|-[nc])([+-]?\d+)$/);
        if (count || ['-n', '-c', '--lines', '--bytes'].includes(text)) {
          const value = count ? { text: count[1] } : words[++i];
          if (!value || value.dynamic || !/^[+-]?\d+$/.test(value.text) || !Number.isSafeInteger(Number(value.text))) return null;
          const bytes = text.startsWith('-c') || text.startsWith('--bytes');
          if (name === 'head' && value.text.startsWith('-')) {
            window = {};
          } else if (name === 'tail' && value.text.startsWith('+')) {
            window = { offset: Math.max(Number(value.text) - 1, 0), bytes };
          } else {
            window = { limit: Math.abs(Number(value.text)), bytes, fromEnd: bytes && name === 'tail' };
          }
          continue;
        }
        if (/^-\d+$/.test(text)) {
          const limit = Number(text.slice(1));
          if (!Number.isSafeInteger(limit)) return null;
          window = { limit };
          continue;
        }
        if (/^-[qvfF]+$/.test(text) || ['--quiet', '--verbose'].includes(text)) continue;
      }
      if (name === 'sed') {
        if (text === '-n' || text === '--quiet' || text === '--silent') {
          quiet = true;
          continue;
        }
        if (text === '-e' || text === '--expression') {
          if (script !== undefined || !words[i + 1]) return null;
          script = words[++i].text;
          continue;
        }
        if (text === '-E' || text === '-r') continue;
      }
      if (takesValue[name]?.includes(lower) || takesValue[name]?.includes(text)) {
        if (!words[++i] || words[i].dynamic) return null;
        continue;
      }
      if (['cat', 'tac', 'nl', 'less', 'more', 'bat', 'batcat'].includes(name)
          && (/^-[AabBceEfnNqrsStuUvVx]+$/.test(text) || ['--number', '--number-nonblank', '--squeeze-blank', '--show-all'].includes(text))) continue;
      return null;
    }
    if (['sed', 'awk'].includes(name) && script === undefined) {
      script = text;
    } else {
      if (token.dynamic) return null;
      if (text !== '-') paths.push(text);
    }
  }
  if (name === 'sed' && quiet) {
    const range = (script ?? '').match(/^(\d+)(?:,(\d+|\$))?p$/);
    if (range) {
      window = lineWindow(Number(range[1]), range[2] === '$' ? undefined : Number(range[2] ?? range[1]));
      if (!window) return null;
    }
  }
  if (name === 'awk') {
    const range = (script ?? '').match(/^NR\s*(?:(<=|==)\s*(\d+)|>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+))(?:\s*\{\s*print(?:\s+\$0)?\s*\})?$/);
    if (range) {
      const start = range[1] === '==' ? Number(range[2]) : Math.max(Number(range[3] ?? 1), 1);
      const end = Number(range[2] ?? range[4]);
      if (![start, end].every(Number.isSafeInteger)) return null;
      window = end < start || end === 0 ? { limit: 0 } : lineWindow(start, end);
      if (!window) return null;
    }
  }
  return { window, paths };
}

function inspectCommand(tokens, powershell, depth) {
  if (tokens.some((token) => token.type === 'operator' && ['|', '|&'].includes(token.text))) return { paths: [] };
  const words = [];
  const inputPaths = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'redirect') {
      if (/^(?:1|\*)?>/.test(token.text) || token.text.startsWith('&>')) return { paths: [] };
      if (token.text === '<') {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return { ambiguous: true };
        inputPaths.push(tokens[i + 1].text);
      }
      if (!token.text.includes('&')) i++;
    } else if (token.type === 'word') {
      words.push(token);
    } else if (hasDumper(tokens.map((item) => item.text).join(' '))) {
      return { ambiguous: true };
    }
  }
  if (words.some((word) => word.dynamic && hasDumper(word.text))) return { ambiguous: true };
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0].text)) words.shift();
  if (!words.length) return { paths: [] };
  if (powershell && (/^\$(?:env:)?[A-Za-z_]\w*=(?!=)/i.test(words[0].text)
      || (/^\$(?:env:)?[A-Za-z_]\w*$/i.test(words[0].text) && words[1]?.text === '='))) {
    return { paths: [] };
  }
  while (['command', 'builtin', 'exec', 'env', 'sudo'].includes(commandName(words[0].text))) {
    if (commandName(words[0].text) === 'command' && ['-v', '-V'].includes(words[1]?.text)) return { paths: [] };
    words.shift();
    while (words[0] && (/^[A-Za-z_]\w*=/.test(words[0].text) || ['--', '-i', '--ignore-environment'].includes(words[0].text))) words.shift();
    if (!words.length) return { paths: [] };
    if (words[0].text.startsWith('-')) return { ambiguous: hasDumper(words.map((word) => word.text).join(' ')), paths: [] };
  }
  const head = words.shift();
  if (head.dynamic) return { ambiguous: true };
  const name = commandName(head.text);
  if (SHELLS.has(name)) {
    const index = words.findIndex((word) => /^(?:-[a-z]*c|-command|\/c)$/i.test(word.text));
    if (index >= 0) {
      const nested = words.slice(index + 1);
      if (!nested.length || depth >= 3) return { ambiguous: true };
      const text = nested.map((word) => word.text).join(' ');
      if (name === 'cmd' && /[%!^]/.test(text) && hasDumper(text)) return { ambiguous: true };
      return inspectShell(text, ['pwsh', 'powershell', 'cmd'].includes(name), depth + 1);
    }
    if (words.some((word) => /^-(?:e|enc|encodedcommand)$/i.test(word.text))) return { ambiguous: true };
    return { paths: [] };
  }
  if (!DUMPERS.has(name)) return { paths: [] };
  if (words[0] && ['--help', '--version'].includes(words[0].text) && !words[0].dynamic) return { paths: [] };
  const result = dumpOperands(name, words);
  if (!result) return { ambiguous: true };
  const paths = [...result.paths, ...inputPaths];
  // sed and awk share line numbers across operands, unlike per-file head/tail windows.
  const window = ['sed', 'awk'].includes(name) && paths.length > 1
    ? { ...result.window, offset: 0 } : result.window;
  return { paths: paths.map((file) => ({ path: file, ...window })) };
}

export function inspectShell(command, powershell = false, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || command.length > 65_536 || command.includes('\0')) return { ambiguous: true };
  const tokens = tokenize(command, powershell);
  if (!tokens) return { ambiguous: hasDumper(command), paths: [] };
  const groups = [[]];
  for (const token of tokens) {
    if (token.type === 'operator' && [';', '&&', '||', '&', '\n'].includes(token.text)) groups.push([]);
    else groups.at(-1).push(token);
  }
  const paths = [];
  for (const group of groups) {
    const result = inspectCommand(group, powershell, depth);
    if (result.ambiguous) return result;
    paths.push(...result.paths);
  }
  return { paths };
}
