// Test bootstrap only: hold the first actual preview load before Chromium sees it.
// Releasing forwards the original call and its promise; loading/events/state remain genuine.
export const addressInitialLoadGate = `
const addressGateApp = require('electron').app;
const addressLoadGate = globalThis.__wslAddressInitialLoad = { held: null, release: null, events: [] };
addressGateApp.on('web-contents-created', (_event, contents) => {
  const load = contents.loadURL.bind(contents);
  contents.loadURL = (...args) => {
    if (addressLoadGate.held || args[0] !== 'wsl-demo://taskflow/index.html') return load(...args);
    addressLoadGate.held = { url: args[0], webContentsId: contents.id };
    addressLoadGate.events.push({ at: Date.now(), event: 'initial-load-held', ...addressLoadGate.held });
    return new Promise((resolve, reject) => {
      addressLoadGate.release = () => {
        addressLoadGate.release = null;
        addressLoadGate.events.push({ at: Date.now(), event: 'initial-load-released', ...addressLoadGate.held });
        load(...args).then(resolve, reject);
      };
    });
  };
});
`;
