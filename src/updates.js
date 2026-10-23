const { autoUpdater } = require('electron-updater');

function setupUpdates({ app, emit }) {
  let available = false;
  let downloaded = false;

  if (!app.isPackaged) {
    return { install() {} };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    available = true;
    downloaded = false;
    emit({ type: 'update', state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    available = false;
    downloaded = false;
    emit({ type: 'update', state: 'hidden' });
  });

  autoUpdater.on('download-progress', (progress) => {
    emit({
      type: 'update',
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    emit({ type: 'update', state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', () => {
    emit({ type: 'update', state: available && !downloaded ? 'available' : 'hidden' });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {});
  };
  check();
  setInterval(check, 60 * 60 * 1000);

  return {
    install() {
      if (downloaded) {
        setImmediate(() => autoUpdater.quitAndInstall(false, true));
        return;
      }
      if (!available) return;
      autoUpdater.downloadUpdate().catch(() => {});
    },
  };
}

module.exports = { setupUpdates };
