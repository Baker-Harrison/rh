const { TOOL_DEFINITIONS, AgentStop, toolLabel } = require('./tools');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ROUNDS = 24;

function systemPrompt(folder) {
  return [
    `You are a coding harness. The working folder is ${folder}.`,
    'Use Read, Write, Edit, and Bash to inspect and change files there.',
    'Paths for Read, Write, and Edit are relative to the working folder unless they are absolute paths inside it.',
    'Bash runs with the working folder as its current directory. It can read files and use the network. It can write only inside the working folder and temporary directories.',
    'Do the work you are asked for. When you are finished, say briefly what you did.',
  ].join('\n');
}

function visible(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '');
}

function parseArgs(raw) {
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function mergeReasoningDetails(existing, incoming) {
  if (!Array.isArray(incoming)) return existing;
  for (const part of incoming) {
    if (!part || typeof part !== 'object') continue;
    const index = Number.isInteger(part.index) ? part.index : existing.length;
    const prev = existing[index];
    if (!prev) {
      existing[index] = { ...part };
      continue;
    }
    if (typeof part.text === 'string' && typeof prev.text === 'string' && part.type === prev.type) {
      prev.text += part.text;
    } else if (typeof part.summary === 'string' && typeof prev.summary === 'string') {
      prev.summary += part.summary;
    } else {
      existing[index] = { ...prev, ...part };
    }
  }
  return existing;
}

async function readError(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return body.error?.message || text.slice(0, 500);
  } catch {
    return text.slice(0, 500) || `Request failed (${response.status})`;
  }
}

async function streamCompletion({ apiKey, model, messages, signal, onText }) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Harness',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: true,
      temperature: 0.2,
      max_tokens: 32768,
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const acc = {
    content: '',
    reasoning: '',
    reasoningDetails: [],
    toolCalls: new Map(),
  };

  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) {
      throw new Error(json.error.message || 'Request failed');
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      acc.content += delta.content;
      onText(visible(acc.content));
    }
    if (typeof delta.reasoning === 'string') acc.reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content;
    if (delta.reasoning_details) mergeReasoningDetails(acc.reasoningDetails, delta.reasoning_details);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        if (!acc.toolCalls.has(index)) {
          acc.toolCalls.set(index, { id: '', name: '', arguments: '' });
        }
        const current = acc.toolCalls.get(index);
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  if (buffer.trim()) consume(buffer);

  const toolCalls = [...acc.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], index) => ({
      id: call.id || `call_${index}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments || '{}',
      },
    }));

  const message = {
    role: 'assistant',
    content: acc.content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  if (acc.reasoning) message.reasoning = acc.reasoning;
  if (acc.reasoningDetails.length) message.reasoning_details = acc.reasoningDetails.filter(Boolean);
  return message;
}

function createAgent({ apiKey, model, getRoot, toolbox, emit }) {
  const history = [];
  let controller = null;
  let running = false;

  function requestMessages() {
    return [{ role: 'system', content: systemPrompt(getRoot()) }, ...history];
  }

  async function send(text) {
    if (running) throw new Error('The harness is still working');
    const root = getRoot();
    if (!root) throw new Error('Choose a folder');
    running = true;
    toolbox.resetStop();
    controller = new AbortController();
    const turnId = `${Date.now()}`;
    history.push({ role: 'user', content: text });
    emit({ type: 'turn-start', id: turnId });

    const aborting = () => controller.signal.aborted;

    try {
      let round = 0;
      while (round < MAX_ROUNDS) {
        round += 1;
        if (aborting()) return;
        const roundCheckpoint = history.length;
        let message;
        try {
          message = await streamCompletion({
            apiKey,
            model,
            messages: requestMessages(),
            signal: controller.signal,
            onText: (value) => emit({ type: 'text', id: turnId, text: value }),
          });
        } catch (error) {
          if (aborting() || error.name === 'AbortError') return;
          history.splice(roundCheckpoint);
          throw error;
        }

        const calls = message.tool_calls || [];
        if (!calls.length) {
          history.push(message);
          return;
        }

        history.push(message);
        try {
          for (const call of calls) {
            if (aborting()) {
              history.splice(roundCheckpoint);
              return;
            }
            let args = {};
            let label = call.function.name || 'tool';
            try {
              args = parseArgs(call.function.arguments);
              label = toolLabel(call.function.name, args);
            } catch {
              args = null;
            }
            emit({ type: 'tool', id: turnId, toolId: call.id, label, state: 'running' });
            let result;
            try {
              if (!args) throw new Error('Could not parse tool arguments');
              result = await toolbox.run(call.function.name, args);
              emit({ type: 'tool', id: turnId, toolId: call.id, label, state: 'done' });
            } catch (error) {
              if (error instanceof AgentStop || aborting()) {
                history.splice(roundCheckpoint);
                return;
              }
              result = `Error: ${error.message}`;
              emit({ type: 'tool', id: turnId, toolId: call.id, label, state: 'error' });
            }
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: String(result),
            });
          }
        } catch (error) {
          history.splice(roundCheckpoint);
          throw error;
        }
      }
      emit({ type: 'error', id: turnId, message: 'Stopped after too many steps.' });
    } catch (error) {
      if (error instanceof AgentStop || aborting() || error.name === 'AbortError') return;
      emit({ type: 'error', id: turnId, message: error.message || 'Request failed' });
    } finally {
      running = false;
      controller = null;
      emit({ type: 'turn-end', id: turnId });
    }
  }

  function stop() {
    if (!running) return;
    toolbox.stop();
    controller?.abort();
  }

  function replay() {
    const events = [];
    let turn = 0;
    let open = false;
    const close = () => {
      if (!open) return;
      events.push({ type: 'turn-end', id: `replay-${turn}` });
      open = false;
    };
    const id = () => {
      if (!open) {
        turn += 1;
        events.push({ type: 'turn-start', id: `replay-${turn}` });
        open = true;
      }
      return `replay-${turn}`;
    };
    for (const message of history) {
      if (message.role === 'user') {
        close();
        events.push({ type: 'user', text: typeof message.content === 'string' ? message.content : '' });
        continue;
      }
      if (message.role !== 'assistant') continue;
      const turnId = id();
      const text = visible(message.content || '');
      if (text.trim()) events.push({ type: 'text', id: turnId, text });
      for (const call of message.tool_calls || []) {
        let label = call.function?.name || 'tool';
        try {
          label = toolLabel(call.function.name, JSON.parse(call.function.arguments || '{}'));
        } catch {
          /* keep the tool name when arguments are incomplete */
        }
        events.push({ type: 'tool', id: turnId, toolId: call.id, label, state: 'done' });
      }
    }
    close();
    return events;
  }

  return { send, stop, replay };
}

module.exports = { createAgent };
