const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pdfCrossProbeDesktop', {
  isDesktop: true,
  openNewWindow: () => ipcRenderer.invoke('desktop:new-window'),
  getUpdateStatus: () => ipcRenderer.invoke('desktop:update-status'),
  checkForUpdates: manual => ipcRenderer.invoke('desktop:update-check', manual === true),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  cancelUpdate: () => ipcRenderer.invoke('desktop:update-cancel'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  openUpdatePage: () => ipcRenderer.invoke('desktop:update-page'),
  onUpdateStatus: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('desktop:update-state', listener)
    return () => ipcRenderer.removeListener('desktop:update-state', listener)
  },
  consumeLaunchQueue: () => ipcRenderer.invoke('desktop:consume-launch-queue'),
  onLaunchFiles: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:launch-files', listener)
    return () => ipcRenderer.removeListener('desktop:launch-files', listener)
  },
  reportWorkspaceState: slots => ipcRenderer.invoke('desktop:report-workspace', slots),
  getExternalOpenRequest: () => ipcRenderer.invoke('desktop:get-external-open'),
  resolveExternalOpen: decision => ipcRenderer.invoke('desktop:resolve-external-open', decision),
  onExternalOpenRequest: callback => {
    const listener = (_event, request) => callback(request)
    ipcRenderer.on('desktop:external-open-request', listener)
    return () => ipcRenderer.removeListener('desktop:external-open-request', listener)
  },
  getShellStatus: () => ipcRenderer.invoke('desktop:get-shell-status'),
  setShellIntegration: enabled => ipcRenderer.invoke('desktop:set-shell-integration', Boolean(enabled)),
})
