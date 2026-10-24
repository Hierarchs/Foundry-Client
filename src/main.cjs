'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, protocol, net, session, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const fs = require('node:fs');
const { Store, PROFILES, normalizeJoinUrl, isAllowedNavigation, partitionFor } = require('./core.cjs');
const { readScript, settingsScript } = require('./foundry.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
// Hardware acceleration and Chromium's GPU safety checks remain enabled.
if (!app.isPackaged && process.env.FOUNDRY_CLIENT_TEST_USER_DATA) app.setPath('userData', process.env.FOUNDRY_CLIENT_TEST_USER_DATA);
const testing = !app.isPackaged && process.env.FOUNDRY_CLIENT_TEST === '1';
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const startupStore = new Store(app.getPath('userData'));
if (startupStore.data.preferences.preferDedicatedGpu && !app.commandLine.hasSwitch('force_low_power_gpu')) app.commandLine.appendSwitch('force_high_performance_gpu');
const trace = message => { if (testing) fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `${message}\n`); };
trace(`starting packaged=${app.isPackaged}`);
const gotLock = app.requestSingleInstanceLock();
trace(`single instance lock=${gotLock}`);
if (!gotLock) app.quit();

let win, store, gameView = null, active = null, overlay = false, focusMode = false, awakeId = null;
let status = { phase: 'idle', message: 'Ready when you are.' };
const popouts = new Set();
const configuredSessions = new WeakSet();
const extraOrigins = new Set();
let pendingRedirect = false, busy = false;

const securePreferences = {
  nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
  webviewTag: false, navigateOnDragDrop: false, safeDialogs: true
};

function snapshot() {
  return {
    sessions: store.data.sessions, preferences: store.data.preferences, profiles: PROFILES,
    active: active && { id: active.id, name: active.name, url: active.url, profile: active.profile },
    status, overlay, focusMode, warning: store.warning,
    runtime: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, ramGB: Math.round(os.totalmem() / 1024 ** 3) }
  };
}
function publish() { if (win && !win.isDestroyed()) win.webContents.send('client:state', snapshot()); }
function setStatus(phase, message) { status = { phase, message }; publish(); }
function layout() {
  if (!gameView || !win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const top = focusMode ? 0 : 52;
  gameView.setBounds({ x: 0, y: top, width, height: Math.max(1, height - top) });
  gameView.setVisible(!overlay);
}
function updateAwake() {
  const enabled = !!active && store.data.preferences.keepAwake && !win?.isMinimized() && !!win?.isVisible();
  if (enabled && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
  if (!enabled && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
}
function setOverlay(value) {
  overlay = !!value;
  if (overlay) focusMode = false;
  layout(); publish();
  if (!overlay) gameView?.webContents.focus();
}
function toggleFocus() {
  if (!gameView) return;
  overlay = false; focusMode = !focusMode;
  layout(); publish(); gameView.webContents.focus();
}
function external(url) {
  // Only browser protocols can reach the OS shell. Never allow file or custom schemes.
  let parsed;
  try { parsed = new URL(normalizeJoinUrl(url)); } catch { return; }
  dialog.showMessageBox(win, { type: 'question', title: 'Open a link', message: 'Open this link in your default browser?', detail: `${parsed.origin}${parsed.pathname}`, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 }).then(result => {
    if (result.response === 1) shell.openExternal(parsed.href).catch(() => setStatus('error', 'Windows could not open the browser.'));
  });
}
function trusted(url) { return !!active && isAllowedNavigation(url, active.url, extraOrigins); }
function configureSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (!wc || !trusted(wc.getURL()) || !trusted(origin)) return false;
    if (permission === 'media') return store.data.preferences.allowMedia;
    return ['fullscreen', 'sanitized-clipboard-write'].includes(permission);
  });
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (!wc || !trusted(wc.getURL()) || !trusted(details.requestingUrl || wc.getURL())) { callback(false); return; }
    if (permission === 'fullscreen' || permission === 'sanitized-clipboard-write') { callback(true); return; }
    if (permission !== 'media' || !store.data.preferences.allowMedia) { callback(false); return; }
    try {
      const result = await dialog.showMessageBox(win, { type: 'question', title: 'Camera and microphone', message: 'Allow this game to use your camera or microphone?', detail: new URL(wc.getURL()).origin, buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 });
      callback(result.response === 1 && !wc.isDestroyed() && trusted(wc.getURL()));
    } catch { callback(false); }
  });
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save game download', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
}

function wireGameContents(wc, allowBlank = false) {
  wc.on('will-attach-webview', event => event.preventDefault());
  const guard = (event, url) => {
    if (allowBlank && url === 'about:blank') return;
    if (trusted(url)) return;
    event.preventDefault();
    let normalized;
    try { normalized = normalizeJoinUrl(url); } catch { return; }
    if (pendingRedirect) return;
    pendingRedirect = true;
    const currentActive = active;
    dialog.showMessageBox(win, { type: 'question', title: 'Game sign-in redirect', message: 'Allow this game to navigate to another website?', detail: `Destination: ${new URL(normalized).origin}\nAllow only if this is part of your host’s sign-in flow.`, buttons: ['Cancel', 'Allow navigation'], defaultId: 0, cancelId: 0 }).then(result => {
      if (result.response === 1 && active === currentActive && !wc.isDestroyed()) {
        extraOrigins.add(new URL(normalized).origin);
        wc.loadURL(normalized).catch(() => setStatus('error', 'The redirected page could not load.'));
      }
    }).finally(() => { pendingRedirect = false; });
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || trusted(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 760, backgroundColor: '#10151e', autoHideMenuBar: true, webPreferences: { ...securePreferences, session: wc.session, backgroundThrottling: store.data.preferences.backgroundThrottle } } };
    }
    external(url); return { action: 'deny' };
  });
  wc.on('did-create-window', child => {
    popouts.add(child);
    wireGameContents(child.webContents, true);
    child.on('closed', () => popouts.delete(child));
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const modifier = input.control || input.meta;
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (modifier && input.shift && input.key.toLowerCase() === 'f') { event.preventDefault(); toggleFocus(); }
    else if (modifier && input.shift && input.key.toLowerCase() === 'l') { event.preventDefault(); setOverlay(true); }
  });
  // Foundry prompts on unload. Forward that decision to a native confirmation.
  wc.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, { type: 'question', message: 'Leave this game page?', detail: 'The game has asked you to confirm before leaving. Save any work first.', buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0 });
    if (response === 1) event.preventDefault();
  });
}

function disposeGame() {
  for (const child of popouts) if (!child.isDestroyed()) child.destroy();
  popouts.clear();
  if (gameView) {
    const view = gameView; gameView = null;
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }
  active = null; overlay = false; focusMode = false; extraOrigins.clear();
  updateAwake();
}
async function confirmLeave() {
  if (!active) return true;
  if (testing) return true;
  const result = await dialog.showMessageBox(win, { type: 'question', title: 'Leave session', message: 'Disconnect from the current session?', detail: 'Save any open work in Foundry before leaving.', buttons: ['Stay', 'Disconnect'], defaultId: 0, cancelId: 0 });
  return result.response === 1;
}
async function connect(input) {
  const saved = store.data.sessions.find(s => s.id === input?.id);
  const item = saved ? { ...saved } : { ...require('./core.cjs').cleanSession(input), id: null };
  if (!await confirmLeave()) return snapshot();
  disposeGame();
  active = item;
  const ses = session.fromPartition(partitionFor(item.url), { cache: true });
  configureSession(ses);
  gameView = new WebContentsView({ webPreferences: { ...securePreferences, session: ses, backgroundThrottling: store.data.preferences.backgroundThrottle, spellcheck: false, v8CacheOptions: 'code' } });
  gameView.setBackgroundColor('#10151e');
  win.contentView.addChildView(gameView);
  const wc = gameView.webContents;
  let navigationFailed = false;
  wireGameContents(wc);
  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && !url.startsWith('chrome-error:')) navigationFailed = false;
  });
  wc.on('did-start-loading', () => { if (gameView?.webContents === wc && !navigationFailed) setStatus('loading', 'Connecting to your table…'); });
  wc.on('did-finish-load', () => { if (gameView?.webContents === wc && !navigationFailed) setStatus('connected', 'Game page loaded'); });
  wc.on('did-fail-load', (_e, code, description, _url, mainFrame) => {
    if (!mainFrame || code === -3 || gameView?.webContents !== wc) return;
    navigationFailed = true;
    setStatus('error', `Connection failed (${code}). Check that your host is running, then retry. ${description.slice(0, 100)}`);
    setOverlay(true);
  });
  wc.on('render-process-gone', (_e, details) => {
    if (gameView?.webContents !== wc) return;
    setStatus('error', `The game renderer stopped (${details.reason}). Reload the game to reconnect.`); setOverlay(true);
  });
  wc.on('unresponsive', () => { if (gameView?.webContents === wc) { setStatus('error', 'The game is taking too long to respond. Wait, or reload from the session library.'); setOverlay(true); } });
  wc.on('responsive', () => { if (gameView?.webContents === wc) setStatus('connected', 'Game is responding again'); });
  if (saved) { saved.lastJoined = new Date().toISOString(); store.write(); }
  layout(); updateAwake(); setStatus('loading', 'Connecting to your table…');
  wc.loadURL(item.url).catch(() => { /* did-fail-load provides the recoverable error state. */ });
  wc.focus();
  return snapshot();
}

async function diagnostics() {
  let foundry = null;
  if (gameView && !gameView.webContents.isDestroyed() && trusted(gameView.webContents.getURL())) {
    try { foundry = await Promise.race([gameView.webContents.executeJavaScript(readScript()), new Promise(resolve => setTimeout(() => resolve(null), 1800))]); } catch { /* Login pages do not expose a canvas. */ }
  }
  const metrics = app.getAppMetrics();
  return {
    gpu: app.getGPUFeatureStatus(),
    memoryMB: Math.round(metrics.reduce((sum, p) => sum + (p.memory?.workingSetSize || 0), 0) / 1024),
    cpuPercent: Math.round(metrics.reduce((sum, p) => sum + (p.cpu?.percentCPUUsage || 0), 0) * 10) / 10,
    processCount: metrics.length, foundry
  };
}

async function profileChange(profile, restore = false) {
  if (!active || !gameView || !trusted(gameView.webContents.getURL())) throw new Error('Connect to a game first.');
  if (!restore && !Object.hasOwn(PROFILES, profile)) throw new Error('Choose a valid rendering profile.');
  const wc = gameView.webContents;
  const info = await wc.executeJavaScript(readScript());
  if (!info?.ready) throw new Error('Join a Foundry world before applying a rendering profile.');
  if (!/^14(?:\.|$)/.test(info.version)) throw new Error('Rendering presets currently target Foundry V14. Use Configure Settings for this version.');
  const key = partitionFor(wc.getURL());
  const backup = store.data.backups[key];
  if (restore && !backup) throw new Error('There are no original rendering settings to restore for this server.');
  if (!restore) {
    store.data.backups[key] = { ...(backup || {}), ...Object.fromEntries(Object.entries(info.settings).filter(([name]) => !backup || !Object.hasOwn(backup, name))) };
    store.write(); // Persist the original settings BEFORE modifying the game.
  }
  const result = await wc.executeJavaScript(settingsScript(restore ? backup : PROFILES[profile].settings, restore));
  if (restore) {
    for (const name of result.applied) delete store.data.backups[key][name];
    if (!Object.keys(store.data.backups[key]).length) delete store.data.backups[key];
    store.write();
  }
  return result;
}

function installIPC() {
  const commands = {
    state: () => snapshot(),
    save: input => { const item = store.save(input); publish(); return { ...snapshot(), savedId: item.id }; },
    remove: id => { if (typeof id !== 'string') throw new Error('Invalid session.'); store.remove(id); publish(); return snapshot(); },
    connect,
    disconnect: async () => { if (await confirmLeave()) { disposeGame(); setStatus('idle', 'Ready when you are.'); } return snapshot(); },
    overlay: value => { setOverlay(value); return snapshot(); },
    preferences: input => {
      store.preferences(input);
      gameView?.webContents.setBackgroundThrottling(store.data.preferences.backgroundThrottle);
      for (const child of popouts) child.webContents.setBackgroundThrottling(store.data.preferences.backgroundThrottle);
      updateAwake(); publish(); return snapshot();
    },
    diagnostics,
    profile: input => profileChange(input),
    restore: () => profileChange(null, true),
    reload: () => { if (!gameView) throw new Error('Connect to a game first.'); gameView.webContents.reload(); setOverlay(false); return snapshot(); },
    fullscreen: () => { win.setFullScreen(!win.isFullScreen()); return snapshot(); },
    focus: () => { toggleFocus(); return snapshot(); },
    zoom: step => {
      if (!gameView) throw new Error('Connect to a game first.');
      if (![0, -1, 1].includes(step)) throw new Error('Invalid zoom.');
      const wc = gameView.webContents;
      wc.setZoomFactor(step === 0 ? 1 : Math.max(0.5, Math.min(2, wc.getZoomFactor() + step * 0.1)));
      return Math.round(wc.getZoomFactor() * 100);
    },
    cache: async id => {
      const item = store.data.sessions.find(s => s.id === id);
      if (!item) throw new Error('Select a saved session first.');
      if (active && partitionFor(active.url) === partitionFor(item.url)) throw new Error('Disconnect from this server before clearing its asset cache.');
      await session.fromPartition(partitionFor(item.url)).clearCache();
      return true;
    },
    sqyre: () => shell.openExternal('https://www.sqyre.app/'),
    minimize: () => win.minimize(),
    maximize: () => win.isMaximized() ? win.unmaximize() : win.maximize(),
    close: () => win.close()
  };
  ipcMain.handle('client:invoke', async (event, action, payload) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== 'app://client/index.html') throw new Error('Untrusted IPC sender.');
    if (!Object.hasOwn(commands, action)) throw new Error('Unknown client action.');
    const exclusive = ['connect', 'disconnect', 'profile', 'restore', 'cache'].includes(action);
    if (exclusive && busy) throw new Error('Please wait for the current operation to finish.');
    if (exclusive) busy = true;
    try { return await commands[action](payload); } finally { if (exclusive) busy = false; }
  });
}

function createWindow() {
  trace('creating window');
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 680, backgroundColor: '#0c1018', title: 'Foundry Client', frame: false, show: false, icon: path.join(__dirname, 'ui/icon.ico'), webPreferences: { ...securePreferences, preload: path.join(__dirname, 'preload.cjs'), partition: 'client-ui' } });
  trace('window created');
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.on('resize', layout);
  win.on('minimize', updateAwake);
  win.on('restore', updateAwake);
  win.on('hide', updateAwake);
  win.on('show', updateAwake);
  win.on('close', event => {
    if (active && !testing) {
      const answer = dialog.showMessageBoxSync(win, { type: 'question', title: 'Close Foundry Client', message: 'Close the client and disconnect?', detail: 'Save any open work in Foundry first.', buttons: ['Keep playing', 'Close client'], defaultId: 0, cancelId: 0 });
      if (answer !== 1) { event.preventDefault(); return; }
    }
    disposeGame();
  });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://client/index.html').then(() => trace('launcher loaded')).catch(error => trace(`launcher failed ${error.message}`));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('certificate-error', (event, _wc, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
if (gotLock) app.whenReady().then(() => {
  trace('app ready');
  store = startupStore;
  const allowedFiles = new Set(['index.html', 'styles.css', 'app.js', 'mark.svg', 'icon.ico']);
  session.fromPartition('client-ui').protocol.handle('app', request => {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if (url.hostname !== 'client' || !allowedFiles.has(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, 'ui', file)).href);
  });
  Menu.setApplicationMenu(null);
  installIPC(); createWindow();
}).catch(error => {
  trace(`startup error ${error.stack}`);
  console.error('Foundry Client startup failed:', error);
  if (!testing) dialog.showErrorBox('Foundry Client could not start', error.message);
  app.exit(1);
});
