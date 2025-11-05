const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipcRenderer', {
    send: (channel, data) => {
        // Validate channels
        let validChannels = ['save-printer-config', 'save-a4-printer-config' , 'save-label-printer-config' , 'submit-password', 'submit-reset-password', 'send-receipt-data', 'send-barcode-data'];
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
    sendBarcodeData: (barcodeData) => {
        ipcRenderer.send('send-barcode-data', barcodeData);
    },
});


contextBridge.exposeInMainWorld('dymo', {
    printLabel: (labelXml, printerName) => {
        const label = dymo.label.framework.openLabelXml(labelXml);
        label.print(printerName);
    },
});
