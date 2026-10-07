const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const updateConfig = require('./update-config.json');

const PORT = 4174;
const HOST = '127.0.0.1';
const APP_URL = `http://${HOST}:${PORT}/`;
const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  let localServer;
  let mainWindow;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function assertPortAvailable() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(PORT, HOST, resolve);
    });
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }

  async function waitForLocalApp() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(APP_URL, { signal: AbortSignal.timeout(800) });
        const html = await response.text();
        if (response.ok && html.includes('<title>Event Futures')) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Le serveur local n’a pas répondu à temps.');
  }

  function createWindow() {
    Menu.setApplicationMenu(null);
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 900,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      title: 'Event Futures · BTC/USDT',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const appOrigin = new URL(APP_URL).origin;
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
      try {
        if (new URL(targetUrl).origin !== appOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(APP_URL);
  }

  function compareVersions(left, right) {
    const a = String(left).replace(/^v/i, '').split('.').map(Number);
    const b = String(right).replace(/^v/i, '').split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const delta = (a[index] || 0) - (b[index] || 0);
      if (delta) return Math.sign(delta);
    }
    return 0;
  }

  function downloadFile(url, destination, redirects = 0) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || redirects > 5) return reject(new Error('Adresse de téléchargement invalide.'));
      const request = https.get(parsed, { headers: { 'User-Agent': 'Event-Futures' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          return downloadFile(new URL(response.headers.location, parsed).href, destination, redirects + 1).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error('Le téléchargement a échoué.'));
        }
        const total = Number(response.headers['content-length']) || 0;
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (total) app.setProgressBar(Math.min(1, received / total));
        });
        pipeline(response, fs.createWriteStream(destination)).then(resolve, reject);
      });
      request.setTimeout(30_000, () => request.destroy(new Error('Le téléchargement a expiré.')));
      request.once('error', reject);
    });
  }

  async function checkForUpdates() {
    const { owner, repo } = updateConfig;
    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return;
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Event-Futures' },
        signal: AbortSignal.timeout(7_000)
      });
      if (!response.ok) return;
      const release = await response.json();
      const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
      if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) return;

      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const assetName = process.platform === 'win32'
        ? `Event-Futures-Setup-${latestVersion}-${arch}.exe`
        : process.platform === 'darwin' ? `Event-Futures-${latestVersion}-${arch}.dmg` : null;
      const asset = release.assets?.find(item => item.name === assetName);
      if (!asset) return;

      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Mise à jour disponible',
        message: `La version ${latestVersion} est disponible.`,
        detail: `Version actuelle : ${app.getVersion()}. Voulez-vous télécharger la mise à jour ?`,
        buttons: ['Télécharger la mise à jour', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (choice.response !== 0) return;

      const safeName = path.basename(asset.name).replace(/[^A-Za-z0-9._-]/g, '_');
      const destination = path.join(app.getPath('downloads'), safeName);
      try {
        await downloadFile(asset.browser_download_url, destination);
        app.setProgressBar(-1);
        const openError = await shell.openPath(destination);
        if (openError) throw new Error(openError);
        if (process.platform === 'darwin') {
          await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Téléchargement terminé',
            message: 'L’image disque est ouverte.',
            detail: 'Glissez Event Futures dans Applications pour remplacer la version installée, puis ouvrez la nouvelle version.'
          });
        }
        app.quit();
      } catch (error) {
        app.setProgressBar(-1);
        await fs.promises.rm(destination, { force: true }).catch(() => {});
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Mise à jour impossible',
          message: 'La mise à jour n’a pas pu être téléchargée ou ouverte.',
          detail: 'Vérifiez votre connexion, puis réessayez au prochain démarrage.'
        });
      }
    } catch {
      // A network or release lookup failure should not block the local app.
    }
  }

  app.whenReady().then(async () => {
    try {
      await assertPortAvailable();
      process.env.PORT = String(PORT);
      process.env.HOST = HOST;
      const serverPath = pathToFileURL(path.resolve(__dirname, '..', 'server.mjs')).href;
      const serverModule = await import(serverPath);
      localServer = serverModule.server;
      await new Promise((resolve, reject) => {
        if (localServer.listening) return resolve();
        localServer.once('listening', resolve);
        localServer.once('error', reject);
      });
      await waitForLocalApp();
      createWindow();
      setTimeout(checkForUpdates, 1_200);
    } catch (error) {
      dialog.showErrorBox('Event Futures ne peut pas démarrer', 'Le serveur local n’a pas pu démarrer. Fermez les autres instances et réessayez.');
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && localServer?.listening) createWindow();
  });

  app.on('before-quit', () => {
    if (localServer?.listening) localServer.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
