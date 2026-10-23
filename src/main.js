const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createAgent } = require('./agent');
const { createToolbox } = require('./tools');

app.setName('Harness');

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

function emit(event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent-event', event);
}

const config = loadConfig();
const toolbox = createToolbox(() => folder);
const agent = createAgent({
  apiKey: config.apiKey,
  model: config.model,
  getRoot: () => folder,
  toolbox,
  emit,
});

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
    for (const event of agent.replay()) emit(event);
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

ipcMain.handle('send-message', async (_event, text) => {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  if (!config.apiKey) {
    emit({ type: 'error', id: 'config', message: 'Set OPENROUTER_API_KEY.' });
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

app.whenReady().then(() => {
  folder = loadFolder();
  applicationMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
