const koffi = (() => {
  if (process.platform !== 'win32') return null;
  try {
    return require('koffi');
  } catch (err) {
    console.warn('[win32-desktop] koffi unavailable:', err.message);
    return null;
  }
})();

let api = null;

if (koffi) {
  try {
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    api = {
      FindWindowA: user32.func('__stdcall', 'FindWindowA', 'intptr_t', ['str', 'str']),
      FindWindowExA: user32.func('__stdcall', 'FindWindowExA', 'intptr_t', [
        'intptr_t',
        'intptr_t',
        'str',
        'str',
      ]),
      GetWindowLongPtrW: user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [
        'intptr_t',
        'int',
      ]),
      SetWindowLongPtrW: user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [
        'intptr_t',
        'int',
        'intptr_t',
      ]),
      SetWindowPos: user32.func('__stdcall', 'SetWindowPos', 'bool', [
        'intptr_t',
        'intptr_t',
        'int',
        'int',
        'int',
        'int',
        'uint32',
      ]),
      GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'intptr_t', []),
      GetWindowRect: user32.func('__stdcall', 'GetWindowRect', 'bool', [
        'intptr_t',
        koffi.out(koffi.pointer(RECT)),
      ]),
      GetClassNameW: user32.func('__stdcall', 'GetClassNameW', 'int', [
        'intptr_t',
        koffi.out('uint16_t*'),
        'int',
      ]),
      IsWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']),
      IsIconic: user32.func('__stdcall', 'IsIconic', 'bool', ['intptr_t']),
    };
  } catch (err) {
    console.warn('[win32-desktop] user32 bindings failed:', err.message);
    api = null;
  }
}

const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_EX_TOOLWINDOW = 0x00000080n;
const HWND_BOTTOM = 1n;
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
const OCCLUSION_TOLERANCE_PX = 12;
const IGNORED_OCCLUDER_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  '#32769',
]);
const _classNameBuf = new Uint16Array(128);

function getHwnd(win) {
  if (!win || win.isDestroyed()) return 0n;
  const buf = win.getNativeWindowHandle();
  if (!buf || buf.length < 4) return 0n;
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
}

function findDesktopOwner() {
  if (!api) return 0n;
  try {
    const progman = BigInt(api.FindWindowA('Progman', null) || 0);
    if (progman !== 0n) {
      const defView = BigInt(
        api.FindWindowExA(progman, 0n, 'SHELLDLL_DefView', null) || 0
      );
      if (defView !== 0n) {
        return progman;
      }
    }

    let workerW = 0n;
    for (let i = 0; i < 64; i += 1) {
      workerW = BigInt(api.FindWindowExA(0n, workerW, 'WorkerW', null) || 0);
      if (workerW === 0n) break;
      const defView = BigInt(
        api.FindWindowExA(workerW, 0n, 'SHELLDLL_DefView', null) || 0
      );
      if (defView !== 0n) {
        return workerW;
      }
    }

    return progman;
  } catch (err) {
    console.warn('[win32-desktop] findDesktopOwner failed:', err.message);
    return 0n;
  }
}

function applyToolWindowStyle(win) {
  if (!api) return false;
  try {
    const hwnd = getHwnd(win);
    if (hwnd === 0n) return false;
    const current = BigInt(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) || 0);
    if ((current & WS_EX_TOOLWINDOW) === 0n) {
      api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | WS_EX_TOOLWINDOW);
    }
    return true;
  } catch (err) {
    console.warn('[win32-desktop] applyToolWindowStyle failed:', err.message);
    return false;
  }
}

function sendToBottom(win) {
  if (!api) return false;
  try {
    const hwnd = getHwnd(win);
    if (hwnd === 0n) return false;
    return Boolean(api.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_FLAGS));
  } catch (err) {
    console.warn('[win32-desktop] sendToBottom failed:', err.message);
    return false;
  }
}

function attachDesktopMode(win) {
  if (!api) return false;
  try {
    const hwnd = getHwnd(win);
    if (hwnd === 0n) return false;
    const owner = findDesktopOwner();
    if (owner !== 0n) {
      api.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner);
    }
    api.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_FLAGS);
    return true;
  } catch (err) {
    console.warn('[win32-desktop] attachDesktopMode failed:', err.message);
    return false;
  }
}

function setTopmostMode(win, enabled) {
  if (!api) return false;
  try {
    const hwnd = getHwnd(win);
    if (hwnd === 0n) return false;
    if (enabled) {
      api.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0n);
      api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_FLAGS);
    } else {
      api.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS);
      attachDesktopMode(win);
    }
    return true;
  } catch (err) {
    console.warn('[win32-desktop] setTopmostMode failed:', err.message);
    return false;
  }
}

function getWindowClassName(hwnd) {
  if (!api || hwnd === 0n) return '';
  const len = api.GetClassNameW(hwnd, _classNameBuf, _classNameBuf.length);
  if (len <= 0) return '';
  return String.fromCharCode(..._classNameBuf.subarray(0, len));
}

function isDesktopOccluded(win) {
  if (!api || !win || win.isDestroyed()) return false;
  try {
    const ownHwnd = getHwnd(win);
    if (ownHwnd === 0n) return false;

    const fgHwnd = BigInt(api.GetForegroundWindow() || 0);
    if (fgHwnd === 0n || fgHwnd === ownHwnd) return false;
    if (!api.IsWindowVisible(fgHwnd) || api.IsIconic(fgHwnd)) return false;

    const cls = getWindowClassName(fgHwnd);
    if (IGNORED_OCCLUDER_CLASSES.has(cls)) return false;

    const ownRect = {};
    const fgRect = {};
    if (!api.GetWindowRect(ownHwnd, ownRect) || !api.GetWindowRect(fgHwnd, fgRect)) {
      return false;
    }

    const ownW = ownRect.right - ownRect.left;
    const ownH = ownRect.bottom - ownRect.top;
    if (ownW <= 0 || ownH <= 0) return false;

    return (
      fgRect.left <= ownRect.left + OCCLUSION_TOLERANCE_PX &&
      fgRect.top <= ownRect.top + OCCLUSION_TOLERANCE_PX &&
      fgRect.right >= ownRect.right - OCCLUSION_TOLERANCE_PX &&
      fgRect.bottom >= ownRect.bottom - OCCLUSION_TOLERANCE_PX
    );
  } catch (err) {
    console.warn('[win32-desktop] isDesktopOccluded failed:', err.message);
    return false;
  }
}

module.exports = {
  isAvailable: Boolean(api),
  applyToolWindowStyle,
  attachDesktopMode,
  isDesktopOccluded,
  sendToBottom,
  setTopmostMode,
};
