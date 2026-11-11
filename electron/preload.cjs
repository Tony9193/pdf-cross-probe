const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pdfCrossProbeDesktop', {
  isDesktop: true,
  consumeLaunchQueue: () => ipcRenderer.invoke('desktop:consume-launch-queue'),
  onLaunchFiles: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:launch-files', listener)
    return () => ipcRenderer.removeListener('desktop:launch-files', listener)
  },
  getShellStatus: () => ipcRenderer.invoke('desktop:get-shell-status'),
  setShellIntegration: enabled => ipcRenderer.invoke('desktop:set-shell-integration', Boolean(enabled)),
})
