const CONTEXT_LIMIT = 1_048_576;
const MAX_OUTPUT_TOKENS = 32_768;
const TRIGGER_TOKENS = Math.floor((CONTEXT_LIMIT - MAX_OUTPUT_TOKENS) * 0.85);
const KEEP_RECENT_TOKENS = 80_000;
const SUMMARY_CHUNK_TOKENS = 180_000;

const DEFAULT_LIMITS = {
  triggerTokens: TRIGGER_TOKENS,
  keepRecentTokens: KEEP_RECENT_TOKENS,
  chunkTokens: SUMMARY_CHUNK_TOKENS,
};

function estimateText(value) {
  if (value == null || value === '') return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

function estimateMessage(message) {
  return 4
    + estimateText(message.content)
    + estimateText(message.tool_calls)
    + estimateText(message.reasoning)
    + estimateText(message.reasoning_details)
    + estimateText(message.tool_call_id);
}

function estimateMessages(messages) {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

function groupMessages(messages) {
  const groups = [];
  let current = null;
  for (const message of messages) {
    if (!current || message.role === 'summary' || message.role === 'user') {
      current = [message];
      groups.push(current);
      continue;
    }
    current.push(message);
  }
  return groups;
}

function splitForSummary(messages, limits = DEFAULT_LIMITS) {
  if (estimateMessages(messages) < limits.triggerTokens) return null;
  const groups = groupMessages(messages);
  let recentTokens = 0;
  let splitAt = groups.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const tokens = estimateMessages(groups[index]);
    if (splitAt !== groups.length && recentTokens + tokens > limits.keepRecentTokens) break;
    recentTokens += tokens;
    splitAt = index;
    if (recentTokens >= limits.keepRecentTokens) break;
  }
  let old = groups.slice(0, splitAt).flat();
  let recent = groups.slice(splitAt).flat();
  if (!old.length && messages.length > 1) {
    old = messages.slice(0, -1);
    recent = messages.slice(-1);
  }
  if (!old.length) return null;
  return { old, recent };
}

function chunkMessages(messages, limit) {
  const chunks = [];
  let current = [];
  let tokens = 0;
  for (const message of messages) {
    const size = Math.max(1, estimateMessage(message));
    if (current.length && tokens + size > limit) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(message);
    tokens += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

module.exports = {
  CONTEXT_LIMIT,
  DEFAULT_LIMITS,
  estimateMessages,
  splitForSummary,
  chunkMessages,
};
