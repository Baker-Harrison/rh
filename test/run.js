const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateMessages, splitForSummary } = require('../src/context');
const { openStore } = require('../src/store');
const { createAgent } = require('../src/agent');
const { createToolbox } = require('../src/tools');

let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log('ok', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL', name, error);
  }
}

function sse(text) {
  const payload = JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  });
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

(async () => {
  await check('summarizes only near the context limit', async () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(80) },
      { role: 'assistant', content: 'y'.repeat(80), tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'user', content: 'recent request' },
    ];
    const small = splitForSummary(messages, { triggerTokens: 10_000, keepRecentTokens: 80_000, chunkTokens: 1000 });
    assert.equal(small, null);
    const split = splitForSummary(messages, { triggerTokens: 30, keepRecentTokens: 20, chunkTokens: 1000 });
    assert.ok(split);
    assert.ok(split.recent.some((message) => message.content === 'recent request'));
    assert.ok(split.old.some((message) => message.role === 'tool'));
    const toolIndex = split.old.findIndex((message) => message.role === 'assistant' && message.tool_calls);
    if (toolIndex !== -1) {
      assert.equal(split.old[toolIndex + 1].role, 'tool');
    }
  });

  await check('a single long turn splits on a round boundary', async () => {
    const body = 'x'.repeat(4000);
    const call = (id) => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' } });
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [call('a')] },
      { role: 'tool', tool_call_id: 'a', content: body },
      { role: 'assistant', content: null, tool_calls: [call('b')] },
      { role: 'tool', tool_call_id: 'b', content: body },
    ];
    const split = splitForSummary(messages, { triggerTokens: 100, keepRecentTokens: 50, chunkTokens: 1000 });
    assert.ok(split);
    assert.equal(split.recent[0].role, 'assistant');
  });

  await check('edit inserts new_string literally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-edit-'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'price: X\n');
    await createToolbox(() => root).run('Edit', { path: 'f.txt', old_string: 'X', new_string: '$$5 and $&' });
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'price: $$5 and $&\n');
  });

  await check('write refuses a dangling symlink', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-link-')));
    const outside = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-out-'))), 'escaped.txt');
    fs.symlinkSync(outside, path.join(root, 'link.txt'));
    await assert.rejects(createToolbox(() => root).run('Write', { path: 'link.txt', contents: 'x' }));
    assert.equal(fs.existsSync(outside), false);
  });

  await check('bash keeps multibyte characters split across chunks', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-utf8-')));
    const command = 'printf "\\303"; sleep 0.3; printf "\\251"';
    const result = await createToolbox(() => root).run('Bash', { command });
    assert.match(result, /é/);
  });

  await check('an update check after the download keeps the downloaded state', async () => {
    const { EventEmitter } = require('events');
    const fake = Object.assign(new EventEmitter(), { checks: 0, checkForUpdates() { this.checks += 1; return Promise.resolve(); } });
    const resolved = require.resolve('electron-updater');
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { autoUpdater: fake } };
    delete require.cache[require.resolve('../src/updates')];
    const timers = [];
    const realSetInterval = global.setInterval;
    global.setInterval = (fn) => { timers.push(fn); return 0; };
    const events = [];
    const { setupUpdates } = require('../src/updates');
    setupUpdates({ app: { isPackaged: true }, emit: (event) => events.push(event) });
    global.setInterval = realSetInterval;
    fake.emit('update-available', { version: '2.0.0' });
    fake.emit('update-downloaded', { version: '2.0.0' });
    const checksBefore = fake.checks;
    timers[0]();
    fake.emit('update-available', { version: '2.0.0' });
    assert.equal(fake.checks, checksBefore);
    assert.equal(events.at(-1).state, 'downloaded');
    delete require.cache[resolved];
  });

  await check('consecutive user messages are merged in the request only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-merge-'));
    let sent = null;
    global.fetch = async (_url, options) => {
      sent = JSON.parse(options.body).messages;
      return sse('ok');
    };
    const history = [{ role: 'user', content: 'first' }];
    const agent = createAgent({
      apiKey: 'test-key',
      model: 'm',
      getRoot: () => root,
      toolbox: createToolbox(() => root),
      emit() {},
      history,
    });
    await agent.send('second');
    assert.deepEqual(sent.map((message) => message.role), ['system', 'user']);
    assert.equal(sent[1].content, 'first\n\nsecond');
    assert.equal(history.filter((message) => message.role === 'user').length, 2);
  });

  await check('a failing save does not leave the agent stuck running', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-savefail-'));
    global.fetch = async () => sse('ok');
    let failing = false;
    const events = [];
    const agent = createAgent({
      apiKey: 'test-key',
      model: 'm',
      getRoot: () => root,
      toolbox: createToolbox(() => root),
      emit: (event) => events.push(event),
      history: [],
      persist: () => { if (failing) throw new Error('disk full'); },
    });
    failing = true;
    await agent.send('one').catch(() => {});
    failing = false;
    await agent.send('two');
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 2);
  });

  await check('read honours a fractional limit as whole lines', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-read-')));
    fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\nc\nd\n');
    const result = await createToolbox(() => root).run('Read', { path: 'f.txt', offset: 1, limit: 2.5 });
    assert.match(result, /lines 1-2 of 4/);
  });

  await check('bash does not inherit the API key', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-env-')));
    process.env.OPENROUTER_API_KEY = 'secret-key-value';
    const result = await createToolbox(() => root).run('Bash', { command: 'env' });
    delete process.env.OPENROUTER_API_KEY;
    assert.ok(!result.includes('secret-key-value'));
  });

  await check('bash cannot read protected app data', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prot-')));
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.harness-test-')));
    try {
      fs.writeFileSync(path.join(secretDir, 'harness.db'), 'TOPSECRET');
      const open = await createToolbox(() => root).run('Bash', { command: `cat ${secretDir}/harness.db` });
      assert.match(open, /TOPSECRET/);
      const guarded = await createToolbox(() => root, { protectedPaths: [secretDir] }).run('Bash', { command: `cat ${secretDir}/harness.db` });
      assert.ok(!guarded.includes('TOPSECRET'));
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  await check('tool calls streamed without an index stay separate', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-noindex-')));
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B');
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n > 1) return sse('done');
      const chunk = (calls) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`;
      return new Response(
        chunk([{ id: 'c1', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }])
        + chunk([{ id: 'c2', function: { name: 'Read', arguments: '{"path":"b.txt"}' } }])
        + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const history = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit() {}, history });
    await agent.send('read both');
    const assistant = history.find((message) => message.tool_calls);
    assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['c1', 'c2']);
    assert.equal(history.filter((message) => message.role === 'tool').length, 2);
  });

  await check('a non-streamed JSON reply is still read', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-json-')));
    global.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain answer' } }] }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    const events = [];
    const history = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit: (e) => events.push(e), history });
    await agent.send('hi');
    assert.equal(history.at(-1).content, 'plain answer');
    assert.ok(!events.some((event) => event.type === 'error'));
  });

  await check('stopping mid-tool keeps completed calls and answers the rest', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stopkeep-')));
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n > 1) return sse('ok');
      const call = (index, id, name, args) => ({ index, id, function: { name, arguments: args } });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
          call(0, 'w1', 'Write', '{"path":"made.txt","contents":"x"}'),
          call(1, 'b1', 'Bash', '{"command":"sleep 20"}'),
          call(2, 'r1', 'Read', '{"path":"made.txt"}'),
        ] } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const history = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit() {}, history });
    const turn = agent.send('go');
    setTimeout(() => agent.stop(), 700);
    await turn;
    assert.ok(fs.existsSync(path.join(root, 'made.txt')));
    const toolIds = history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
    assert.deepEqual(toolIds, ['w1', 'b1', 'r1']);
  });

  await check('an oversized turn after a summary is compacted, not the summary again', async () => {
    const body = 'x'.repeat(4000);
    const call = (id) => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' } });
    const messages = [
      { role: 'summary', content: 'earlier work' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [call('a')] },
      { role: 'tool', tool_call_id: 'a', content: body },
      { role: 'assistant', content: null, tool_calls: [call('b')] },
      { role: 'tool', tool_call_id: 'b', content: body },
    ];
    const split = splitForSummary(messages, { triggerTokens: 100, keepRecentTokens: 50, chunkTokens: 1000 });
    assert.ok(split);
    assert.ok(split.old.some((message) => message.role === 'user'));
    assert.equal(split.recent[0].role, 'assistant');
  });

  await check('bash returns when the command exits even if a background job holds the pipe', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bg-')));
    const started = Date.now();
    const result = await createToolbox(() => root).run('Bash', { command: 'sleep 8 & echo started', timeout_ms: 20000 });
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
    assert.match(result, /exit code: 0/);
    assert.match(result, /started/);
  });

  await check('edit matches multi-line text in a CRLF file and keeps its line endings', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-crlf-')));
    const file = path.join(root, 'w.txt');
    fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n');
    await createToolbox(() => root).run('Edit', { path: 'w.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'uno\r\ndos\r\nthree\r\n');
  });

  await check('a transient provider error is retried once', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-retry-')));
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
      return sse('recovered');
    };
    const events = [];
    const history = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit: (e) => events.push(e), history, retryDelayMs: 10 });
    await agent.send('hi');
    assert.equal(history.at(-1).content, 'recovered');
    assert.ok(!events.some((event) => event.type === 'error'));
    assert.equal(n, 2);
  });

  await check('a provider that never answers times out instead of hanging', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hang-')));
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const events = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit: (e) => events.push(e), history: [], headerTimeoutMs: 100 });
    await agent.send('hi');
    assert.ok(events.some((event) => event.type === 'error' && /not responding|timed out/i.test(event.message)));
    assert.equal(events.at(-1).type, 'turn-end');
  });

  await check('an already-aborted turn does not start another request', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-preabort-')));
    let calls = 0;
    let agent;
    global.fetch = async (_url, options) => {
      if (options.signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      calls += 1;
      if (calls === 1) agent.stop();
      return new Response(JSON.stringify({ choices: [{ message: { content: 'chunk summary' } }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    agent = createAgent({
      apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit() {},
      history: [{ role: 'user', content: 'x'.repeat(400) }, { role: 'assistant', content: 'y'.repeat(400) }, { role: 'user', content: 'z'.repeat(400) }, { role: 'assistant', content: 'w'.repeat(400) }],
      limits: { triggerTokens: 50, keepRecentTokens: 30, chunkTokens: 100 },
    });
    await agent.send('go');
    assert.equal(calls, 1);
  });

  await check('parallel tool calls that reuse index 0 with distinct ids stay separate', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sameindex-')));
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B');
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n > 1) return sse('done');
      const chunk = (calls) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`;
      return new Response(
        chunk([{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }])
        + chunk([{ index: 0, id: 'c2', function: { name: 'Read', arguments: '{"path":"b.txt"}' } }])
        + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const history = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit() {}, history });
    await agent.send('read both');
    const assistant = history.find((message) => message.tool_calls);
    assert.deepEqual(assistant.tool_calls.map((call) => call.function.name), ['Read', 'Read']);
    assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['c1', 'c2']);
  });

  await check('an interrupted tool does not stay in the running state', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chip-')));
    let n = 0;
    global.fetch = async () => {
      n += 1;
      if (n > 1) return sse('ok');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', function: { name: 'Bash', arguments: '{"command":"sleep 20"}' } }] } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const events = [];
    const agent = createAgent({ apiKey: 'k', model: 'm', getRoot: () => root, toolbox: createToolbox(() => root), emit: (e) => events.push(e), history: [] });
    const turn = agent.send('go');
    setTimeout(() => agent.stop(), 600);
    await turn;
    const states = events.filter((event) => event.type === 'tool' && event.toolId === 'b1').map((event) => event.state);
    assert.notEqual(states.at(-1), 'running');
    const labels = events.filter((event) => event.type === 'tool' && event.toolId === 'b1').map((event) => event.label);
    assert.ok(labels.every((label) => label === labels[0]) && labels[0].includes('sleep 20'));
  });

  await check('sqlite stores the key and the thread', async () => {
    const file = path.join(os.tmpdir(), `harness-store-${Date.now()}.db`);
    const store = openStore(file);
    assert.equal(store.getApiKey(), '');
    store.setApiKey('test-key');
    assert.equal(store.getApiKey(), 'test-key');
    store.saveMessages([
      { role: 'summary', content: 'earlier work' },
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_9', content: '/tmp' },
    ]);
    store.close();
    const again = openStore(file);
    assert.equal(again.getApiKey(), 'test-key');
    const loaded = again.loadMessages();
    assert.equal(loaded.length, 4);
    assert.equal(loaded[0].role, 'summary');
    assert.equal(loaded[2].tool_calls[0].id, 'call_9');
    assert.equal(loaded[3].tool_call_id, 'call_9');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    again.close();
    fs.rmSync(file, { force: true });
  });

  await check('agent summarizes, then continues, and persists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-'));
    const calls = [];
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(Boolean(body.tools));
      if (!body.tools) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Kept the file goal and the recent request.' } }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return sse('Finished the task.');
    };
    const saved = [];
    const events = [];
    const history = [
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'y'.repeat(400) },
    ];
    const agent = createAgent({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      getRoot: () => root,
      toolbox: createToolbox(() => root),
      emit: (event) => events.push(event),
      history,
      persist: (messages) => saved.push(messages.map((message) => message.role)),
      limits: { triggerTokens: 50, keepRecentTokens: 30, chunkTokens: 100 },
    });
    await agent.send('please continue');
    assert.equal(history[0].role, 'summary');
    assert.match(history[0].content, /recent request|file goal|Kept/);
    assert.ok(history.some((message) => message.role === 'assistant' && message.content === 'Finished the task.'));
    assert.ok(events.some((event) => event.type === 'summary' && event.state === 'done'));
    assert.equal(calls.at(-1), true);
    assert.ok(calls.slice(0, -1).every((usedTools) => usedTools === false));
    assert.ok(calls.length >= 2);
    assert.ok(saved.at(-1).includes('summary'));
    assert.ok(estimateMessages(history) > 0);
  });

  await check('a failed summary clears the running state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sumfail-'));
    const events = [];
    global.fetch = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    const agent = createAgent({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      getRoot: () => root,
      toolbox: createToolbox(() => root),
      emit: (event) => events.push(event),
      history: [{ role: 'user', content: 'x'.repeat(400) }, { role: 'assistant', content: 'y'.repeat(400) }],
      limits: { triggerTokens: 50, keepRecentTokens: 30, chunkTokens: 100 },
    });
    await agent.send('go');
    const states = events.filter((event) => event.type === 'summary').map((event) => event.state);
    assert.deepEqual(states, ['running', 'failed']);
  });

  await check('a reasoning-only reply ends the turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-empty-'));
    const events = [];
    const history = [];
    global.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"reasoning":"Looking at the files."}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const agent = createAgent({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      getRoot: () => root,
      toolbox: createToolbox(() => root),
      emit: (event) => events.push(event),
      history,
    });
    await agent.send('find the bug');
    assert.equal(history.at(-1).role, 'assistant');
    assert.equal(history.at(-1).content, null);
    assert.ok(events.some((event) => event.type === 'status' && event.text === 'Thinking'));
    assert.ok(events.some((event) => event.type === 'error' && event.message === 'The model stopped without a reply.'));
    assert.ok(events.at(-1).type === 'turn-end');
    const replay = agent.replay();
    assert.ok(replay.some((event) => event.type === 'error' && event.message === 'The model stopped without a reply.'));
  });

  if (failed) process.exit(1);
})();
