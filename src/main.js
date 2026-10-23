const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createAgent } = require('./agent');
const { createToolbox } = require('./tools');
const { setupUpdates } = require('./updates');
const { openStore } = require('./store');

app.setName('Harness');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

let win = null;
let folder = null;

function configPath() {
  return path.join(__dirname, '..', 'config.json');
}

function loadConfig() {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    file = {};
  }
  return {
    apiKey: fromEnv || '',
    model: file.model || 'deepseek/deepseek-v4.1-flash-1017',
  };
}

function folderInfo() {
  if (!folder) return { type: 'folder', selected: false, name: '', path: '' };
  return { type: 'folder', selected: true, name: path.basename(folder), path: folder };
}

function stateFile() {
  return path.join(app.getPath('userData'), 'state.json');
}

function loadFolder() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).folder;
    if (saved && fs.existsSync(saved) && fs.statSync(saved).isDirectory()) return saved;
  } catch {
    /* no saved folder yet */
  }
  return null;
}

function saveFolder(next) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ folder: next }));
  } catch {
    /* remembering the folder is optional */
  }
}

let pendingUpdate = null;

function emit(event) {
  if (event.type === 'update') pendingUpdate = event.state === 'hidden' ? null : event;
  if (win && !win.isDestroyed()) win.webContents.send('agent-event', event);
}

const config = loadConfig();
const toolbox = createToolbox(() => folder, { protectedPaths: [app.getPath('userData')] });
let store = null;
let agent = {
  async send() {
    throw new Error('The harness is still starting');
  },
  stop() {},
  replay() {
    return [];
  },
};

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: '',
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    emit(folderInfo());
    emit(keyInfo());
    for (const event of agent.replay()) emit(event);
    if (agent.isRunning?.()) emit({ type: 'running' });
    if (pendingUpdate) emit(pendingUpdate);
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function applicationMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on('drag-by', (event, dx, dy) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = target.getPosition();
  target.setPosition(x + dx, y + dy);
});

ipcMain.on('zoom-window', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return;
  if (target.isMaximized()) target.unmaximize();
  else target.maximize();
});

ipcMain.handle('select-folder', async () => {
  if (agent.isRunning?.()) {
    emit({ type: 'error', id: 'folder', message: 'Stop the current turn before changing folders.' });
    return folderInfo();
  }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    folder = result.filePaths[0];
    saveFolder(folder);
  }
  const info = folderInfo();
  emit(info);
  return info;
});

function keyInfo() {
  return { type: 'key', present: Boolean(store && store.getApiKey()) };
}

ipcMain.handle('set-api-key', (_event, value) => {
  if (!store || typeof value !== 'string' || !value.trim()) return { ok: false };
  store.setApiKey(value.trim());
  emit(keyInfo());
  return { ok: true };
});

ipcMain.handle('send-message', async (_event, text) => {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  if (!store || !store.getApiKey()) {
    emit(keyInfo());
    return { ok: false };
  }
  if (!folder || !fs.existsSync(folder)) {
    folder = null;
    emit(folderInfo());
    emit({ type: 'error', id: 'folder', message: 'Choose a folder.' });
    return { ok: false };
  }
  await agent.send(text.trim());
  return { ok: true };
});

ipcMain.handle('stop', () => {
  agent.stop();
});

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

let updates = { install() {} };

ipcMain.handle('install-update', () => {
  updates.install();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  store = openStore(path.join(app.getPath('userData'), 'harness.db'));
  if (process.env.OPENROUTER_API_KEY) store.setApiKey(process.env.OPENROUTER_API_KEY);
  folder = loadFolder();
  agent = createAgent({
    getApiKey: () => store.getApiKey(),
    model: config.model,
    getRoot: () => folder,
    toolbox,
    emit,
    history: store.loadMessages(),
    persist: (messages) => store.saveMessages(messages),
  });
  applicationMenu();
  createWindow();
  updates = setupUpdates({ app, emit });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  agent.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
