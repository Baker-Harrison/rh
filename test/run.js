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

  if (failed) process.exit(1);
})();
