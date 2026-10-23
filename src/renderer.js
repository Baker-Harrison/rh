const thread = document.getElementById('thread');
const composer = document.getElementById('composer');
const folderBtn = document.getElementById('folder');
const folderName = document.getElementById('folder-name');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

const turns = new Map();
let running = false;
let folderSelected = false;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function inlineFormat(value) {
  return value
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function splitCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let current = '';
  let code = false;
  for (const char of trimmed) {
    if (char === '`') code = !code;
    if (char === '|' && !code) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isSeparator(line) {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function columnAlign(cell) {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function renderTable(headerLine, alignLine, bodyLines) {
  const align = splitCells(alignLine).map(columnAlign);
  const headers = splitCells(headerLine);
  const width = Math.max(headers.length, align.length);
  const cell = (text, index, tag) => {
    const alignment = align[index] || 'left';
    return `<${tag} class="align-${alignment}">${inlineFormat(text || '')}</${tag}>`;
  };
  const head = Array.from({ length: width }, (_, index) => cell(headers[index], index, 'th')).join('');
  const body = bodyLines.map((line) => {
    const cells = splitCells(line);
    const row = Array.from({ length: width }, (_, index) => cell(cells[index], index, 'td')).join('');
    return `<tr>${row}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(source) {
  const fences = [];
  let text = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const index = fences.length;
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n@@FENCE${index}@@\n`;
  });
  text = text.replace(/```([^\n`]*)\n?([\s\S]*)$/g, (_match, _lang, code) => {
    const index = fences.length;
    fences.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\n@@FENCE${index}@@\n`;
  });
  text = escapeHtml(text);

  const lines = text.split('\n');
  let html = '';
  let list = '';
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    html += `<p>${para.map(inlineFormat).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    html += `<ul>${list}</ul>`;
    list = '';
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^@@FENCE(\d+)@@$/);
    if (fence) {
      flushPara();
      flushList();
      html += fences[Number(fence[1])];
      continue;
    }
    const next = lines[index + 1];
    if (next && line.includes('|') && isSeparator(next)) {
      flushPara();
      flushList();
      const body = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|') && !isSeparator(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html += renderTable(line, next, body);
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.+)/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html += `<h${level}>${inlineFormat(heading[2])}</h${level}>`;
      continue;
    }
    const item = line.match(/^[-*] (.+)/);
    if (item) {
      flushPara();
      list += `<li>${inlineFormat(item[1])}</li>`;
      continue;
    }
    if (list && line.trim() === '') {
      flushList();
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return html;
}

function nearBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
}

function scrollDown(force) {
  if (force || nearBottom()) thread.scrollTop = thread.scrollHeight;
}

function setFolder(state) {
  const selected = Boolean(state && state.selected);
  const name = selected && state.name ? state.name : '';
  folderSelected = selected;
  folderBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  folderBtn.setAttribute('aria-label', name ? `Folder ${name}` : 'Choose folder');
  folderName.textContent = name;
  folderName.title = selected && state.path ? state.path : '';
  folderName.hidden = !name;
}

function setRunning(next) {
  running = next;
  composer.classList.toggle('running', next);
  sendBtn.setAttribute('aria-label', next ? 'Stop' : 'Send');
  syncSend();
}

function syncSend() {
  const ready = running || input.value.trim().length > 0;
  sendBtn.disabled = !ready;
  sendBtn.classList.toggle('ready', ready);
}

function resizeInput() {
  input.style.height = 'auto';
  const next = Math.min(input.scrollHeight, 160);
  input.style.height = `${next}px`;
  composer.classList.toggle('multiline', next > 44);
}

function turnEl(id) {
  let turn = turns.get(id);
  if (turn) return turn;
  const article = document.createElement('article');
  article.className = 'turn assistant';
  article.dataset.id = id;
  const blocks = document.createElement('div');
  blocks.className = 'blocks';
  article.appendChild(blocks);
  thread.appendChild(article);
  turn = { article, blocks, textEl: null, tools: new Map() };
  turns.set(id, turn);
  return turn;
}

function addUser(text) {
  const article = document.createElement('article');
  article.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  article.appendChild(bubble);
  thread.appendChild(article);
  scrollDown(true);
}

function setText(turn, text) {
  if (!text) return;
  if (!turn.textEl) {
    turn.textEl = document.createElement('div');
    turn.textEl.className = 'text';
    turn.blocks.appendChild(turn.textEl);
  }
  turn.textEl.innerHTML = renderMarkdown(text);
}

function setTool(turn, toolId, label, state) {
  let chip = turn.tools.get(toolId);
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'tool';
    turn.blocks.appendChild(chip);
    turn.tools.set(toolId, chip);
    turn.textEl = null;
  }
  chip.textContent = label;
  chip.classList.toggle('running', state === 'running');
  chip.classList.toggle('error', state === 'error');
}

function showError(id, message) {
  const turn = id ? turnEl(id) : turnEl(`err-${Date.now()}`);
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = message;
  turn.blocks.appendChild(note);
  scrollDown(false);
}

window.harness.onEvent((event) => {
  if (event.type === 'folder') {
    setFolder(event);
    return;
  }
  if (event.type === 'update') {
    setUpdate(event.state);
    return;
  }
  if (event.type === 'summary') {
    showSummary(event.state);
    scrollDown(true);
    return;
  }
  if (event.type === 'user') {
    addUser(event.text);
    return;
  }
  const stick = nearBottom();
  if (event.type === 'turn-start') {
    turnEl(event.id);
  } else if (event.type === 'text') {
    setText(turnEl(event.id), event.text);
  } else if (event.type === 'tool') {
    setTool(turnEl(event.id), event.toolId, event.label, event.state);
  } else if (event.type === 'error') {
    showError(event.id, event.message);
  } else if (event.type === 'turn-end') {
    const turn = turns.get(event.id);
    if (turn && turn.blocks.childElementCount === 0) turn.article.remove();
    setRunning(false);
  }
  if (event.type !== 'folder') scrollDown(stick);
});

thread.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  window.harness.openExternal(link.href);
});

folderBtn.addEventListener('click', async () => {
  const result = await window.harness.selectFolder();
  setFolder(result);
});

input.addEventListener('input', () => {
  resizeInput();
  syncSend();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (running) return;
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) {
    window.harness.stop();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  if (!folderSelected) {
    const result = await window.harness.selectFolder();
    setFolder(result);
    if (!result.selected) return;
  }
  input.value = '';
  resizeInput();
  syncSend();
  addUser(text);
  setRunning(true);
  try {
    await window.harness.send(text);
  } catch (error) {
    showError(null, error.message || 'Request failed');
  } finally {
    setRunning(false);
  }
});

function showSummary(state) {
  let note = document.getElementById('summary-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'summary-note';
    note.className = 'tool summary';
    thread.appendChild(note);
  }
  note.textContent = state === 'running' ? 'Summarizing earlier context' : 'Summarized earlier context';
  note.classList.toggle('running', state === 'running');
}

function dragWindow(event, surface) {
  if (event.button !== 0) return;
  surface.setPointerCapture(event.pointerId);
  let x = event.screenX;
  let y = event.screenY;
  const onMove = (ev) => {
    const dx = Math.round(ev.screenX - x);
    const dy = Math.round(ev.screenY - y);
    x = ev.screenX;
    y = ev.screenY;
    if (dx || dy) window.harness.dragBy(dx, dy);
  };
  const onUp = () => {
    surface.removeEventListener('pointermove', onMove);
    surface.removeEventListener('pointerup', onUp);
    surface.removeEventListener('pointercancel', onUp);
  };
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);
}

const updateBtn = document.getElementById('update');
let updateState = 'hidden';

function setUpdate(state) {
  updateState = state;
  const visible = state === 'available' || state === 'downloading' || state === 'downloaded';
  updateBtn.hidden = !visible;
  updateBtn.classList.toggle('downloading', state === 'downloading');
  updateBtn.disabled = state === 'downloading';
  const label = state === 'downloaded'
    ? 'Restart to update'
    : state === 'downloading'
      ? 'Downloading update'
      : 'Update';
  updateBtn.setAttribute('aria-label', label);
  updateBtn.title = label;
}

updateBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
updateBtn.addEventListener('dblclick', (event) => event.stopPropagation());
updateBtn.addEventListener('click', () => {
  if (updateState === 'downloading') return;
  window.harness.installUpdate();
});

const drag = document.getElementById('drag');
drag.addEventListener('pointerdown', (event) => {
  if (event.target.closest('#update')) return;
  dragWindow(event, drag);
});
drag.addEventListener('dblclick', () => window.harness.zoom());

thread.addEventListener('pointerdown', (event) => {
  if (event.target !== thread) return;
  dragWindow(event, thread);
});

resizeInput();
syncSend();
input.focus();
