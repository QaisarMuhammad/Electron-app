const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipcRenderer', {
    send: (channel, data) => {
        // Validate channels
        let validChannels = ['save-printer-config', 'submit-password', 'submit-reset-password', 'send-receipt-data'];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    }
});

// Additional context bridge for receipt-specific functionality
contextBridge.exposeInMainWorld('electron', {
    sendReceiptData: (receiptData) => {
        ipcRenderer.send('send-receipt-data', receiptData);
    },
});
