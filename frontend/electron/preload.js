const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('overlay:set-ignore-mouse', Boolean(ignore));
  },
  hideOverlay() {
    ipcRenderer.send('overlay:hide');
  },
  onVisibilityChange(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, visible) => {
      callback(Boolean(visible));
    };
    ipcRenderer.on('overlay:visibility', listener);
    return () => {
      ipcRenderer.removeListener('overlay:visibility', listener);
    };
  },
  onOcclusionChange(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, occluded) => {
      callback(Boolean(occluded));
    };
    ipcRenderer.on('overlay:occluded', listener);
    return () => {
      ipcRenderer.removeListener('overlay:occluded', listener);
    };
  },
});
