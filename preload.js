const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded');

contextBridge.exposeInMainWorld('electron', {
    print: (content) => {
        console.log('Print request received:', content);
        ipcRenderer.send('print-request', content);
    }
});