const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const win32 = require('./win32-desktop');

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=96');
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('disable-component-update');

const projectRoot = path.resolve(__dirname, '..', '..');
const backendPython = path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
const backendScript = path.join(projectRoot, 'backend', 'server.py');
const launcherVbs = path.join(projectRoot, 'Start Music Overlay.vbs');
const startupDir = path.join(
  process.env.APPDATA || app.getPath('appData'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const startupShortcutPath = path.join(startupDir, 'Music Overlay.lnk');

function parseSmokeExitMs() {
  const arg = process.argv.find((item) => item.startsWith('--smoke-exit-ms='));
  if (!arg) return null;
  const val = Number.parseInt(arg.split('=')[1], 10);
  return Number.isFinite(val) && val > 0 ? val : null;
}

const smokeExitMs = parseSmokeExitMs();
let smokeUserDataDir = null;
if (smokeExitMs !== null) {
  smokeUserDataDir = path.join(os.tmpdir(), `music-overlay-smoke-${process.pid}`);
  app.setPath('userData', smokeUserDataDir);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let isAlwaysOnTop = false;
let isVisible = true;
let isOccluded = false;
let isQuitting = false;
let managedBackendProc = null;
let occlusionTimer = null;

const OCCLUSION_POLL_INTERVAL_MS = 1500;

function setOccludedState(next) {
  const occluded = Boolean(next);
  if (occluded === isOccluded) return;
  isOccluded = occluded;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:occluded', isOccluded);
  }
}

function checkDesktopOcclusion() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isAlwaysOnTop || !isVisible) {
    setOccludedState(false);
    return;
  }
  setOccludedState(win32.isDesktopOccluded(mainWindow));
}

function startOcclusionPolling() {
  if (occlusionTimer !== null || smokeExitMs !== null) return;
  occlusionTimer = setInterval(checkDesktopOcclusion, OCCLUSION_POLL_INTERVAL_MS);
}

function stopOcclusionPolling() {
  if (occlusionTimer !== null) {
    clearInterval(occlusionTimer);
    occlusionTimer = null;
  }
}

function isPortOpen(host = '127.0.0.1', port = 8765, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function ensureBackendRunning() {
  if (await isPortOpen('127.0.0.1', 8765)) {
    return false;
  }
  if (!fs.existsSync(backendPython) || !fs.existsSync(backendScript)) {
    console.warn('[backend] Python venv or server.py not found:', backendPython);
    return false;
  }

  const proc = spawn(backendPython, [backendScript], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  managedBackendProc = proc;

  proc.stderr?.on('data', (chunk) => {
    if (smokeExitMs !== null) {
      process.stderr.write(`[BACKEND] ${chunk}`);
    }
  });

  proc.once('exit', () => {
    if (managedBackendProc === proc) {
      managedBackendProc = null;
    }
  });

  return true;
}

function stopManagedBackend() {
  if (!managedBackendProc) return;
  const proc = managedBackendProc;
  const pid = proc.pid;
  managedBackendProc = null;

  try {
    proc.kill('SIGTERM');
  } catch {
    // Ignore if already exited
  }

  if (process.platform === 'win32' && pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // Ignore if process already closed
    }
  }
}

function getWscriptPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
}

function writeStartupShortcut(targetShortcutPath) {
  fs.mkdirSync(path.dirname(targetShortcutPath), { recursive: true });
  return shell.writeShortcutLink(targetShortcutPath, 'create', {
    target: getWscriptPath(),
    args: `"${launcherVbs}"`,
    cwd: projectRoot,
    description: 'Launch Music Overlay at Windows startup',
  });
}

function isStartupEnabled() {
  if (process.platform !== 'win32') return false;
  return fs.existsSync(startupShortcutPath);
}

function setStartupEnabled(enable) {
  if (process.platform !== 'win32') return false;
  try {
    if (enable) {
      return writeStartupShortcut(startupShortcutPath);
    }
    if (fs.existsSync(startupShortcutPath)) {
      fs.unlinkSync(startupShortcutPath);
    }
    return true;
  } catch (err) {
    console.warn('[startup] Failed updating startup shortcut:', err.message);
    return false;
  }
}

function createTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      let alpha = 0;
      const ringDist = Math.abs(dist - 10.5);
      if (ringDist < 2.3) {
        alpha = Math.max(alpha, Math.min(1, 1 - (ringDist - 1.2) / 1.1));
      }
      if (dist < 3.6) {
        alpha = Math.max(alpha, Math.min(1, 1 - (dist - 2.6)));
      }

      if (alpha > 0) {
        const idx = (y * size + x) * 4;
        const a = Math.round(alpha * 255);
        // BGRA byte order expected by Electron nativeImage.createFromBitmap on Windows
        buf[idx] = 232;
        buf[idx + 1] = 236;
        buf[idx + 2] = 242;
        buf[idx + 3] = a;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function syncWorkAreaBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  mainWindow.setBounds({ x, y, width, height });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: isAlwaysOnTop,
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        isAlwaysOnTop = !isAlwaysOnTop;
        if (isAlwaysOnTop) {
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
          win32.setTopmostMode(mainWindow, true);
          setOccludedState(false);
        } else {
          mainWindow.setAlwaysOnTop(false);
          win32.setTopmostMode(mainWindow, false);
          checkDesktopOcclusion();
        }
        rebuildTrayMenu();
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: isStartupEnabled(),
      click: () => {
        setStartupEnabled(!isStartupEnabled());
        rebuildTrayMenu();
      },
    },
    {
      label: isVisible ? 'Hide Overlay' : 'Show Overlay',
      click: () => toggleOverlayVisibility(),
    },
    {
      label: 'Reload UI',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function toggleOverlayVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isVisible = !isVisible;
  if (isVisible) {
    syncWorkAreaBounds();
    mainWindow.showInactive();
    if (isAlwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      win32.setTopmostMode(mainWindow, true);
      setOccludedState(false);
    } else {
      win32.attachDesktopMode(mainWindow);
      checkDesktopOcclusion();
    }
  } else {
    mainWindow.hide();
    setOccludedState(false);
  }
  mainWindow.webContents.send('overlay:visibility', isVisible);
  rebuildTrayMenu();
}

function createOverlayWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.showInactive();
    win32.applyToolWindowStyle(mainWindow);
    win32.attachDesktopMode(mainWindow);
  });

  mainWindow.on('focus', () => {
    if (!isAlwaysOnTop && mainWindow && !mainWindow.isDestroyed()) {
      win32.sendToBottom(mainWindow);
    }
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    if (!isAlwaysOnTop && isVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.restore();
      win32.sendToBottom(mainWindow);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (isVisible) toggleOverlayVisibility();
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return mainWindow;
}

ipcMain.on('overlay:set-ignore-mouse', (_event, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (ignore) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('overlay:hide', () => {
  if (isVisible) {
    toggleOverlayVisibility();
  }
});

app.whenReady().then(async () => {
  const startedManagedBackend = await ensureBackendRunning();
  const win = createOverlayWindow();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Music Overlay');
  tray.on('double-click', () => toggleOverlayVisibility());
  rebuildTrayMenu();

  screen.on('display-metrics-changed', syncWorkAreaBounds);
  screen.on('display-added', syncWorkAreaBounds);
  screen.on('display-removed', syncWorkAreaBounds);
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) {
      if (!isVisible) win.webContents.send('overlay:visibility', false);
      if (isOccluded) win.webContents.send('overlay:occluded', true);
    }
  });
  startOcclusionPolling();

  if (smokeExitMs !== null) {
    win.webContents.on('console-message', (event) => {
      console.log(`[RENDERER:${event.level}] ${event.message}`);
    });
    win.webContents.once('did-finish-load', async () => {
      const trayIcon = createTrayIcon();
      console.log(
        `[SMOKE] loaded win32=${win32.isAvailable} tray=${Boolean(tray)} iconEmpty=${trayIcon.isEmpty()} bounds=${JSON.stringify(
          win.getBounds()
        )}`
      );
      console.log(`[SMOKE_BACKEND] startedManaged=${startedManagedBackend}`);

      try {
        const tempShortcut = path.join(smokeUserDataDir, 'Music Overlay.lnk');
        const created = writeStartupShortcut(tempShortcut);
        const readBack = created ? shell.readShortcutLink(tempShortcut) : null;
        if (fs.existsSync(tempShortcut)) fs.unlinkSync(tempShortcut);
        console.log(
          '[SMOKE_SHORTCUT]',
          JSON.stringify({
            created,
            targetIsWscript: Boolean(readBack?.target?.toLowerCase().endsWith('wscript.exe')),
            argsHasVbs: Boolean(readBack?.args?.includes('Start Music Overlay.vbs')),
          })
        );
      } catch (err) {
        console.error('[SMOKE_SHORTCUT_ERR]', err);
      }

      try {
        const uiCheck = await win.webContents.executeJavaScript(`(() => {
          const trigger = document.getElementById('vinyl-trigger');
          const drawer = document.getElementById('dock-drawer');
          const lockBtn = document.getElementById('btn-layout-lock');
          const themeBtn = document.getElementById('btn-theme-mode');
          const clockBtn = document.getElementById('btn-toggle-clock');
          const clockRegion = document.getElementById('clock-region');
          const clockEditorialBtn = document.getElementById('btn-clock-editorial');
          const clockStackedBtn = document.getElementById('btn-clock-stacked');
          const clockMinimalBtn = document.getElementById('btn-clock-minimal');
          const edgeOffBtn = document.getElementById('btn-edge-off');
          const edgeMinimalBtn = document.getElementById('btn-edge-minimalist');
          const edgeDynamicBtn = document.getElementById('btn-edge-dynamic');
          const brightnessSlider = document.getElementById('slider-night-brightness');
          const sleepBtn = document.getElementById('btn-sleep-timer');
          const sleepCountdown = document.getElementById('sleep-timer-countdown');
          const edgeEl = document.getElementById('screen-edge-glow');
          const bloomFrameEl = document.getElementById('edge-bloom-frame');
          const rimEl = document.getElementById('edge-inset-rim');
          const sideEls = Array.from(document.querySelectorAll('#edge-bloom-frame .edge-side'));
          const rotorEls = Array.from(document.querySelectorAll('#edge-bloom-frame .edge-conic-rotor'));
          const topSide = sideEls[0];
          const rimShadowIdle = rimEl ? getComputedStyle(rimEl).boxShadow : '';
          const idleSpreadPx = topSide ? Math.round(parseFloat(getComputedStyle(topSide).height) * 10) / 10 : 0;
          edgeEl.style.setProperty('--beat-pulse', '1');
          const kickSpreadPx = topSide ? Math.round(parseFloat(getComputedStyle(topSide).height) * 10) / 10 : 0;
          const rimShadowKick = rimEl ? getComputedStyle(rimEl).boxShadow : '';
          edgeEl.style.removeProperty('--beat-pulse');
          const singleLayerMasks = sideEls.every(
            (el) => getComputedStyle(el).maskImage.split('linear-gradient').length === 2
          );
          const edgeLayers = Boolean(
            bloomFrameEl &&
            rimEl &&
            sideEls.length === 4 &&
            rotorEls.length === 4 &&
            idleSpreadPx > 0 &&
            kickSpreadPx > idleSpreadPx * 3 &&
            rimShadowIdle &&
            rimShadowIdle !== 'none' &&
            rimShadowKick !== rimShadowIdle &&
            singleLayerMasks
          );
          const resetBtn = document.getElementById('btn-reset-layout');
          const tabPinned = document.getElementById('tab-pinned');
          const tabRecent = document.getElementById('tab-recent');
          const viz = document.getElementById('visualizer-region');

          const drawerClosedBefore = getComputedStyle(drawer).display === 'none';
          const drawerNoBlurWhenClosed = getComputedStyle(drawer).backdropFilter === 'none';
          const rotorNoBlur = rotorEls.every((el) => getComputedStyle(el).filter === 'none');
          const canvas = document.getElementById('visualizer-canvas');
          const vizWrap = document.querySelector('.visualizer-wrap');
          const dynScaleRatio = canvas && canvas.clientWidth ? canvas.width / canvas.clientWidth : 0;

          trigger.click();
          const drawerOpened = !drawer.hidden && drawer.classList.contains('is-open') && getComputedStyle(drawer).display === 'flex';
          lockBtn.click();
          const editUnlocked = document.body.classList.contains('is-layout-editing') && viz.classList.contains('interactive');
          viz.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));
          themeBtn.click();
          const themeAfter = document.getElementById('theme-mode-badge').textContent;
          clockBtn.click();
          const clockHidden = clockRegion.classList.contains('is-user-hidden');
          clockBtn.click();

          clockStackedBtn.click();
          const clockStacked = clockRegion.dataset.clockStyle === 'stacked';
          clockMinimalBtn.click();
          const clockMinimal = clockRegion.dataset.clockStyle === 'minimal';
          clockEditorialBtn.click();

          edgeOffBtn.click();
          const edgeDisabled = edgeEl.classList.contains('is-disabled');
          const offScaleRatio = canvas && canvas.clientWidth ? canvas.width / canvas.clientWidth : 0;
          edgeMinimalBtn.click();
          const edgeMinimalist = !edgeEl.classList.contains('is-disabled') && edgeEl.style.getPropertyValue('--beat-pulse') === '0.22';
          const minScaleRatio = canvas && canvas.clientWidth ? canvas.width / canvas.clientWidth : 0;
          edgeDynamicBtn.click();
          const edgeReenabled = !edgeEl.classList.contains('is-disabled');

          brightnessSlider.value = '45';
          brightnessSlider.dispatchEvent(new Event('input', { bubbles: true }));
          const dimVal = document.documentElement.style.getPropertyValue('--overlay-brightness');
          brightnessSlider.value = '100';
          brightnessSlider.dispatchEvent(new Event('input', { bubbles: true }));

          sleepBtn.click();
          const sleep30Text = sleepCountdown.textContent;
          sleepBtn.click();
          sleepBtn.click();
          sleepBtn.click();
          const sleepOffText = sleepCountdown.textContent;

          tabPinned.click();
          const pinnedActive = tabPinned.classList.contains('is-active');
          tabRecent.click();
          resetBtn.click();
          lockBtn.click();
          const cfg = JSON.parse(localStorage.getItem('music-overlay-config-v1') || '{}');
          trigger.click();
          return {
            drawerClosedBefore,
            drawerNoBlurWhenClosed,
            rotorNoBlur,
            dynScaleRatio: Math.round(dynScaleRatio * 100) / 100,
            offScaleRatio: Math.round(offScaleRatio * 100) / 100,
            minScaleRatio: Math.round(minScaleRatio * 100) / 100,
            drawerOpened,
            editUnlocked,
            themeAfter,
            clockHidden,
            clockStacked,
            clockMinimal,
            clockStyleSaved: cfg.clockStyle,
            edgeLayers,
            idleSpreadPx,
            kickSpreadPx,
            edgeDisabled,
            edgeMinimalist,
            edgeReenabled,
            edgeSaved: cfg.edgeGlow,
            brightnessDimmed: dimVal,
            brightnessSaved: cfg.nightBrightness,
            sleep30Text,
            sleepOffText,
            pinnedActive,
            lyricsX: cfg.lyrics?.x,
            drawerClosedAfter: drawer.hidden,
          };
        })()`);
        console.log('[SMOKE_UI]', JSON.stringify(uiCheck));

        const paletteCheck = await win.webContents.executeJavaScript(`new Promise((resolve) => {
          const runTest = () => {
            const c = document.createElement('canvas');
            c.width = 48; c.height = 48;
            const g = c.getContext('2d');
            // Dual-tone dark Crimson + Gold (zero green/blue pixels)
            g.fillStyle = '#4a141c';
            g.fillRect(0, 0, 32, 48);
            g.fillStyle = '#6b5012';
            g.fillRect(32, 0, 16, 48);
            const dataUrl = c.toDataURL();
            const img = document.getElementById('cover-image');
            const done = () => {
              setTimeout(() => {
                const s = document.getElementById('screen-edge-glow').style;
                const toHsl = (r, gr, b) => {
                  r /= 255; gr /= 255; b /= 255;
                  const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
                  const l = (max + min) / 2;
                  const d = max - min;
                  const sat = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min));
                  let hue = 0;
                  if (d > 0) {
                    if (max === r) hue = (gr - b) / d + (gr < b ? 6 : 0);
                    else if (max === gr) hue = (b - r) / d + 2;
                    else hue = (r - gr) / d + 4;
                    hue = (hue / 6) * 360;
                  }
                  return { hue: Math.round(hue), sat: Math.round(sat * 100), light: Math.round(l * 100) };
                };
                const readStop = (slot) => [
                  Number(s.getPropertyValue('--' + slot + '-r')),
                  Number(s.getPropertyValue('--' + slot + '-g')),
                  Number(s.getPropertyValue('--' + slot + '-b')),
                ];
                const c1 = readStop('c1');
                const c2 = readStop('c2');
                const c3 = readStop('c3');
                const c1Hsl = toHsl(...c1);
                const c2Hsl = toHsl(...c2);
                const c3Hsl = toHsl(...c3);
                const noInventedRainbow = [c1Hsl, c2Hsl, c3Hsl].every((h) => h.hue < 80 || h.hue > 290);
                const highSat = [c1Hsl, c2Hsl, c3Hsl].every((h) => h.sat >= 55);
                const canvas = document.getElementById('visualizer-canvas');
                const ctx2d = canvas ? canvas.getContext('2d') : null;
                const px = ctx2d && canvas.width > 2 && canvas.height > 2
                  ? Array.from(ctx2d.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
                  : [0, 0, 0, 0];
                const bgPx = ctx2d && canvas.width > 20 && canvas.height > 20
                  ? Array.from(ctx2d.getImageData(8, 8, 1, 1).data)
                  : [0, 0, 0, 255];
                resolve({
                  trackTitle: document.getElementById('track-title')?.textContent || '',
                  srcPreserved: img.src === dataUrl,
                  canvasCoverPainted: px[3] > 200 && px[0] > px[2],
                  canvasOuterPureTransparent: bgPx[3] === 0,
                  c1,
                  c2,
                  c3,
                  c1Hsl,
                  c2Hsl,
                  c3Hsl,
                  noInventedRainbow,
                  highSat,
                });
              }, 850);
            };
            img.addEventListener('load', done, { once: true });
            img.src = dataUrl;
          };
          const waitStart = performance.now();
          const waitWs = () => {
            const title = document.getElementById('track-title')?.textContent || '';
            if (title !== 'Backend offline' || performance.now() - waitStart > 1600) {
              setTimeout(runTest, 120);
            } else {
              setTimeout(waitWs, 100);
            }
          };
          waitWs();
        })`);
        console.log('[SMOKE_PALETTE]', JSON.stringify(paletteCheck));
      } catch (err) {
        console.error('[SMOKE_UI_ERR]', err);
      }
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, smokeExitMs);
    });
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopOcclusionPolling();
  stopManagedBackend();
  if (smokeUserDataDir) {
    try {
      fs.rmSync(smokeUserDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup lock
    }
  }
});

app.on('will-quit', () => {
  stopManagedBackend();
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});
