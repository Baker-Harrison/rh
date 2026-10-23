const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const MAX_READ_LINES = 400;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_OUTPUT = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a text file in the working folder. Each returned line is prefixed with its line number and a pipe. That prefix is not part of the file. Use offset and limit to read a slice of a large file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the working folder, or an absolute path inside it.',
          },
          offset: {
            type: 'integer',
            description: '1-based line number to start from. Defaults to 1.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to return. Defaults to 400. Maximum is 400.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Create or overwrite a text file in the working folder. Parent directories are created when they do not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the working folder, or an absolute path inside it.',
          },
          contents: {
            type: 'string',
            description: 'The full new contents of the file.',
          },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Replace one exact occurrence of old_string with new_string in a file in the working folder. old_string must match the file exactly, including whitespace, and must appear once. Do not include the line-number prefixes from Read.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the working folder, or an absolute path inside it.',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to replace. It must occur once in the file.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text. An empty string deletes old_string.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Run a shell command with the working folder as its current directory. Writes are confined to that folder and temporary directories. Reads and network access are allowed. Avoid interactive programs and pagers. Use timeout_ms for commands that need longer than 30 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run.',
          },
          timeout_ms: {
            type: 'integer',
            description: 'Timeout in milliseconds. Default is 30000. Maximum is 120000.',
          },
        },
        required: ['command'],
      },
    },
  },
];

class AgentStop extends Error {
  constructor() {
    super('Stopped');
    this.name = 'AgentStop';
  }
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n…[output truncated]`;
}

function resolveSafe(root, userPath) {
  if (typeof userPath !== 'string' || !userPath.trim()) {
    throw new Error('Path is required');
  }
  const rootReal = fs.realpathSync(root);
  const abs = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.resolve(rootReal, userPath);
  const rel = path.relative(rootReal, abs);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error('Path is outside the working folder');
  }

  let existing = abs;
  const pending = [];
  while (!fs.existsSync(existing)) {
    if (fs.lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Path is a broken symlink');
    }
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Invalid path');
    pending.push(path.basename(existing));
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const relExisting = path.relative(rootReal, realExisting);
  if (relExisting !== '' && (relExisting.startsWith('..') || path.isAbsolute(relExisting))) {
    throw new Error('Path is outside the working folder');
  }
  return pending.length ? path.join(realExisting, ...pending.reverse()) : realExisting;
}

function isBinary(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, 8000, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function readLines(file, offset, limit) {
  const start = Math.max(1, Number.isFinite(offset) ? offset : 1);
  const max = Math.min(
    MAX_READ_LINES,
    Math.max(1, Number.isFinite(limit) ? limit : MAX_READ_LINES),
  );
  return new Promise((resolve, reject) => {
    const lines = [];
    let total = 0;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      total += 1;
      if (total >= start && lines.length < max) lines.push(line);
    });
    rl.on('close', () => resolve({ lines, start, total }));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

async function readTool(root, args) {
  const file = resolveSafe(root, args.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error('File not found');
  }
  if (isBinary(file)) throw new Error('Cannot read a binary file');
  const offset = Math.floor(Number(args.offset)) || 1;
  const limit = Math.floor(Number(args.limit)) || MAX_READ_LINES;
  const { lines, start, total } = await readLines(file, offset, limit);
  if (total === 0) return `${args.path} is empty`;
  if (lines.length === 0) return `${args.path} has ${total} lines. offset ${start} is past the end.`;
  const end = start + lines.length - 1;
  const body = lines
    .map((line, i) => `${String(start + i).padStart(6, ' ')}|${line}`)
    .join('\n');
  const more = end < total ? `\n…[${total - end} more lines. Read again with offset ${end + 1}]` : '';
  return clip(`${args.path} (lines ${start}-${end} of ${total})\n${body}${more}`);
}

function writeTool(root, args) {
  if (typeof args.contents !== 'string') throw new Error('contents must be a string');
  const bytes = Buffer.byteLength(args.contents);
  if (bytes > MAX_WRITE_BYTES) throw new Error('File is too large to write');
  const file = resolveSafe(root, args.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, args.contents);
  return `Wrote ${args.path} (${bytes} bytes)`;
}

function editTool(root, args) {
  if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
    throw new Error('old_string must not be empty');
  }
  if (typeof args.new_string !== 'string') throw new Error('new_string must be a string');
  if (args.old_string === args.new_string) throw new Error('old_string and new_string are the same');
  const file = resolveSafe(root, args.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('File not found');
  if (isBinary(file)) throw new Error('Cannot edit a binary file');
  const original = fs.readFileSync(file, 'utf8');
  // Read hides carriage returns, so text the model copies from it uses bare \n.
  const crlf = original.includes('\r\n') && !args.old_string.includes('\r');
  const toFile = (text) => (crlf ? text.replace(/\n/g, '\r\n') : text);
  const oldText = toFile(args.old_string);
  const newText = toFile(args.new_string);
  const count = original.split(oldText).length - 1;
  if (count === 0) throw new Error('old_string was not found');
  if (count > 1) throw new Error(`old_string appears ${count} times. Include more surrounding text so it is unique.`);
  const next = original.replace(oldText, () => newText);
  fs.writeFileSync(file, next);
  return `Edited ${args.path}`;
}

function schemeQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function existingPath(candidate) {
  if (!candidate) return null;
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function writeRoots(rootReal) {
  const roots = new Set([rootReal]);
  for (const candidate of [os.tmpdir(), process.env.TMPDIR, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
    const resolved = existingPath(candidate);
    if (resolved) roots.add(resolved);
  }
  return [...roots];
}

function sandboxProfile(rootReal, protectedPaths = []) {
  const clauses = writeRoots(rootReal).map((item) => `(subpath ${schemeQuote(item)})`).join(' ');
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow mach-register)
(allow ipc-posix-shm)
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-data)
(allow system-socket)
(allow network-outbound)
(allow network-bind)
(allow file-ioctl)
(allow file-read*)
(allow file-write* ${clauses})
${protectedPaths.map(existingPath).filter(Boolean).map((item) => `(deny file-read* file-write* (subpath ${schemeQuote(item)}))`).join('\n')}
(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/zero") (literal "/dev/tty"))
`;
}

function killGroup(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 400);
}

function bashTool(root, args, track, shouldStop, protectedPaths) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) throw new Error('command is required');
  const requested = Number(args.timeout_ms);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS),
  );
  const rootReal = fs.realpathSync(root);
  const profilePath = path.join(os.tmpdir(), `harness-sandbox-${process.pid}-${Date.now()}.sb`);
  fs.writeFileSync(profilePath, sandboxProfile(rootReal, protectedPaths));

  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/zsh', '-lc', command], {
      cwd: rootReal,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'OPENROUTER_API_KEY')),
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        MANPAGER: 'cat',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    track(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (bucket, chunk) => {
      if (bucket.length >= MAX_OUTPUT) return bucket;
      return (bucket + chunk.toString()).slice(0, MAX_OUTPUT + 1);
    };
    
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = take(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    const cleanupProfile = () => {
      fs.rm(profilePath, { force: true }, () => {});
    };

    child.on('error', (error) => {
      clearTimeout(timer);
      track(null);
      cleanupProfile();
      reject(error);
    });

    let settled = false;
    let exitTimer = null;
    child.on('exit', () => {
      // Background jobs can hold the pipes open; give trailing output a moment, then finish.
      exitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode);
      }, 300);
    });
    child.on('close', (code) => finish(code));

    function finish(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      track(null);
      cleanupProfile();
      if (shouldStop()) {
        reject(new AgentStop());
        return;
      }
      const parts = [`exit code: ${timedOut ? 'timeout' : code}`];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(stderr.trimEnd());
      if (timedOut) parts.push(`Error: command timed out after ${timeoutMs}ms`);
      resolve(clip(parts.join('\n')));
    }
  });
}

function createToolbox(getRoot, { protectedPaths = [] } = {}) {
  let active = null;
  let stopRequested = false;

  return {
    stop() {
      stopRequested = true;
      killGroup(active);
    },
    resetStop() {
      stopRequested = false;
    },
    async run(name, args) {
      if (stopRequested) throw new AgentStop();
      const root = getRoot();
      if (!root || !fs.existsSync(root)) throw new Error('No working folder is selected');
      switch (name) {
        case 'Read':
          return readTool(root, args);
        case 'Write':
          return writeTool(root, args);
        case 'Edit':
          return editTool(root, args);
        case 'Bash':
          return bashTool(root, args, (child) => { active = child; }, () => stopRequested, protectedPaths);
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    },
  };
}

function toolLabel(name, args) {
  const raw = name === 'Bash'
    ? String(args.command || '').replace(/\s+/g, ' ').trim()
    : String(args.path || '').trim();
  const detail = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
  return detail ? `${name}  ${detail}` : name;
}

module.exports = {
  TOOL_DEFINITIONS,
  AgentStop,
  createToolbox,
  toolLabel,
  resolveSafe,
};
