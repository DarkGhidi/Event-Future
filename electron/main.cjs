const { app, BrowserWindow, dialog, Menu, shell, safeStorage, ipcMain, powerSaveBlocker } = require('electron');
let botPowerBlockerId = null;
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const updateConfig = require('./update-config.json');
const smokeTest = process.argv.includes('--smoke-test') || process.env.EVENT_FUTURES_SMOKE_TEST === '1';
if (smokeTest) app.disableHardwareAcceleration();

const PORT = 4174;
const HOST = '127.0.0.1';
const APP_URL = `http://${HOST}:${PORT}/`;
if (smokeTest) setTimeout(() => {
  console.error('SMOKE_TEST_TIMEOUT: packaged local market service did not pass within 45 seconds.');
  app.exit(1);
}, 45_000);
const credentialsPath = () => path.join(app.getPath('userData'), 'mexc-credentials.secure');
const botCredentialsPath = () => path.join(app.getPath('userData'), 'mexc-trading-credentials.secure');
const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  let localServer;
  let mainWindow;
  let credentialsSaved = false;
  let botCredentialsSaved = false;

  function allowedIpcSender(event) {
    try { return new URL(event.senderFrame.url).origin === new URL(APP_URL).origin; } catch { return false; }
  }
  function registerCredentialIpc() {
    ipcMain.handle('bot-runtime:keep-awake', event => {
      if (!allowedIpcSender(event)) return { active:false };
      try {
        if (botPowerBlockerId === null) botPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        return { active:powerSaveBlocker.isStarted(botPowerBlockerId) };
      } catch { return { active:false }; }
    });
    ipcMain.handle('bot-runtime:allow-sleep', event => {
      if (!allowedIpcSender(event)) return { active:false };
      if (botPowerBlockerId !== null) {
        try { powerSaveBlocker.stop(botPowerBlockerId); } catch {}
        botPowerBlockerId = null;
      }
      return { active:false };
    });
    ipcMain.handle('mexc-credentials:status', async event => {
      if (!allowedIpcSender(event)) return { available:false, saved:false };
      return { available:['win32','darwin'].includes(process.platform) && await safeStorage.isAsyncEncryptionAvailable(), saved:credentialsSaved };
    });
    ipcMain.handle('mexc-credentials:save', async (event, payload) => {
      if (!allowedIpcSender(event)) return { saved:false };
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
      const apiSecret = typeof payload?.apiSecret === 'string' ? payload.apiSecret : '';
      if (!apiKey || !apiSecret || apiKey.length > 256 || apiSecret.length > 256 || !['win32','darwin'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) return { saved:false };
      try {
        const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ key:apiKey, secret:apiSecret }));
        const target = credentialsPath(), temporary = target + '.tmp';
        await fs.promises.mkdir(path.dirname(target), { recursive:true });
        await fs.promises.writeFile(temporary, encrypted, { mode:0o600 });
        await fs.promises.rename(temporary, target);
        credentialsSaved = true;
        return { saved:true };
      } catch { return { saved:false }; }
    });
    ipcMain.handle('mexc-credentials:clear', async event => {
      if (!allowedIpcSender(event)) return { cleared:false };
      try { await fs.promises.rm(credentialsPath(), { force:true }); credentialsSaved = false; return { cleared:true }; }
      catch { return { cleared:false }; }
    });
    ipcMain.handle('mexc-bot-credentials:status', async event => {
      if (!allowedIpcSender(event)) return { available:false, saved:false };
      return { available:['win32','darwin'].includes(process.platform) && await safeStorage.isAsyncEncryptionAvailable(), saved:botCredentialsSaved };
    });
    ipcMain.handle('mexc-bot-credentials:save', async (event, payload) => {
      if (!allowedIpcSender(event)) return { saved:false };
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
      const apiSecret = typeof payload?.apiSecret === 'string' ? payload.apiSecret : '';
      if (!apiKey || !apiSecret || apiKey.length > 256 || apiSecret.length > 256 || !['win32','darwin'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) return { saved:false };
      try {
        const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ key:apiKey, secret:apiSecret }));
        const target = botCredentialsPath(), temporary = target + '.tmp';
        await fs.promises.mkdir(path.dirname(target), { recursive:true });
        await fs.promises.writeFile(temporary, encrypted, { mode:0o600 });
        await fs.promises.rename(temporary, target);
        botCredentialsSaved = true;
        return { saved:true };
      } catch { return { saved:false }; }
    });
    ipcMain.handle('mexc-bot-credentials:clear', async event => {
      if (!allowedIpcSender(event)) return { cleared:false };
      try { await fs.promises.rm(botCredentialsPath(), { force:true }); botCredentialsSaved = false; return { cleared:true }; }
      catch { return { cleared:false }; }
    });
  }
  async function restoreCredentialFile(serverModule) {
    const target = credentialsPath();
    try {
      const encrypted = await fs.promises.readFile(target);
      if (!['win32','darwin'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) return;
      let decrypted = await safeStorage.decryptStringAsync(encrypted);
      if (decrypted.shouldReEncrypt) {
        decrypted = await safeStorage.decryptStringAsync(encrypted);
        const reEncrypted = await safeStorage.encryptStringAsync(decrypted.result);
        await fs.promises.writeFile(target, reEncrypted, { mode:0o600 });
      }
      const credentials = JSON.parse(decrypted.result);
      if (await serverModule.restoreMexcCredentials(credentials)) credentialsSaved = true;
    } catch { /* Keep the encrypted file; a later manual reconnect can replace it. */ }
  }
  async function restoreBotCredentialFile(serverModule) {
    const target = botCredentialsPath();
    try {
      const encrypted = await fs.promises.readFile(target);
      if (!['win32','darwin'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) return;
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const credentials = JSON.parse(decrypted.result);
      if (await serverModule.restoreBotCredentials(credentials)) botCredentialsSaved = true;
    } catch { /* Keep the encrypted file; a later manual reconnect can replace it. */ }
  }

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

  async function verifyPackagedMarketData() {
    for (const symbol of ['BTC_USDT', 'ETH_USDT']) {
      const timeResponse = await fetch(`${APP_URL}api/market/time?symbol=${symbol}`, { signal:AbortSignal.timeout(10_000), cache:'no-store' });
      if (!timeResponse.ok) throw new Error(`${symbol} : horloge MEXC indisponible (HTTP ${timeResponse.status}).`);
      const timeData = await timeResponse.json();
      if (!Number.isFinite(Number(timeData.serverTime)) || Math.abs(Date.now() - Number(timeData.serverTime)) > 30_000) throw new Error(`${symbol} : horloge MEXC invalide.`);
      const candleResponse = await fetch(`${APP_URL}api/market/candles?source=index&symbol=${symbol}&tf=1m`, { signal:AbortSignal.timeout(15_000), cache:'no-store' });
      if (!candleResponse.ok) throw new Error(`${symbol} : chandelles d’index indisponibles (HTTP ${candleResponse.status}).`);
      const candleBody = await candleResponse.json(), times = candleBody?.data?.time;
      if (candleBody?.success !== true || !Array.isArray(times) || times.length < 20) throw new Error(`${symbol} : chandelles d’index incomplètes.`);
      const ageSeconds = Date.now() / 1000 - Number(times.at(-1));
      if (!Number.isFinite(ageSeconds) || ageSeconds < -30 || ageSeconds > 120) throw new Error(`${symbol} : dernière chandelle trop ancienne (${Math.round(ageSeconds)} s).`);
      console.log(`SMOKE_MARKET_OK ${symbol} time=${timeData.source} candles=${times.length} age_s=${Math.round(ageSeconds)}`);
    }
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
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smokeTest
      }
    });

    const appOrigin = new URL(APP_URL).origin;
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    if (smokeTest) {
      mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        console.log(`SMOKE_RENDERER level=${level} ${sourceId}:${line} ${message}`);
      });
      mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
        console.error(`SMOKE_LOAD_FAILED ${code} ${description} ${validatedURL}`);
      });
    }
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
      try {
        if (new URL(targetUrl).origin !== appOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    mainWindow.once('ready-to-show', () => { if (!smokeTest) mainWindow.show(); });
    mainWindow.on('closed', () => { mainWindow = null; });
    if (smokeTest) mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript('window.__eventFuturesSmoke()');
        if (!result?.ok) throw new Error('Le test de démarrage local a échoué.');
        console.log('SMOKE_TEST_OK ' + JSON.stringify(result));
        app.exit(0);
      } catch (error) {
        console.error('SMOKE_TEST_FAILED ' + String(error?.message || error));
        app.exit(1);
      }
    });
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
      if (parsed.protocol !== 'https:' || !['github.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].includes(parsed.hostname) || redirects > 5) return reject(new Error('Adresse de téléchargement invalide.'));
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
          if (total && mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(Math.min(1, received / total));
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

      const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'arm64' : 'x64';
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
        const expectedDigest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
        const actualDigest = crypto.createHash('sha256').update(await fs.promises.readFile(destination)).digest('hex');
        if (!expectedDigest || actualDigest !== expectedDigest || (asset.size && (await fs.promises.stat(destination)).size !== asset.size)) throw new Error('La vérification d’intégrité a échoué.');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
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
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
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
      process.env.EVENT_FUTURES_DESKTOP = '1';
      process.env.EVENT_FUTURES_DATA_DIR = app.getPath('userData');
      const serverPath = pathToFileURL(path.resolve(__dirname, '..', 'server.mjs')).href;
      const serverModule = await import(serverPath);
      localServer = serverModule.server;
      registerCredentialIpc();
      await new Promise((resolve, reject) => {
        if (localServer.listening) return resolve();
        localServer.once('listening', resolve);
        localServer.once('error', reject);
      });
      await restoreCredentialFile(serverModule);
      await restoreBotCredentialFile(serverModule);
      await waitForLocalApp();
      if (smokeTest) {
        await verifyPackagedMarketData();
        console.log('SMOKE_TEST_OK packaged local service and live MEXC index data');
        app.exit(0);
        return;
      }
      createWindow();
      if (!smokeTest) setTimeout(checkForUpdates, 1_200);
    } catch (error) {
      if (smokeTest) {
        console.error('SMOKE_TEST_STARTUP_FAILED ' + String(error?.stack || error));
        app.exit(1);
        return;
      }
      dialog.showErrorBox('Event Futures ne peut pas démarrer', 'Le serveur local n’a pas pu démarrer. Fermez les autres instances et réessayez.');
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && localServer?.listening) createWindow();
  });

  app.on('before-quit', () => {
    if (botPowerBlockerId !== null) { try { powerSaveBlocker.stop(botPowerBlockerId); } catch {} botPowerBlockerId = null; }
    if (localServer?.listening) localServer.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

