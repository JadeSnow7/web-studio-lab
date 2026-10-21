// Session frame preloads precede the window preload (Electron 44.5.1).
// Sandboxed preloads share require('electron'), so the real preload uses this same ipcRenderer.
export const addressNavigationObserver = `
const { ipcRenderer } = require('electron');
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = (channel, ...args) => {
  const promise = invoke(channel, ...args);
  const command = args[0];
  if (channel === 'workbench:command' && command?.type === 'browserAction' && command.action === 'navigate') {
    const commandId = command.commandId;
    const settled = (status) => {
      const marker = document.createElement('meta');
      marker.dataset.wslAddressCommandId = commandId;
      marker.dataset.wslAddressSettled = status;
      document.head.append(marker);
    };
    // Observe the original promise; never replace it or transform its result/rejection.
    promise.then(() => settled('fulfilled'), () => settled('rejected'));
  }
  return promise;
};
`;
