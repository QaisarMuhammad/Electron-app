const { contextBridge, ipcRenderer } = require('electron');



contextBridge.exposeInMainWorld('dymoAPI', {
    getPrinters: () => window.dymo.label.framework.getPrinters(),
    openLabelXml: (xml) => window.dymo.label.framework.openLabelXml(xml)
});

window.addEventListener('DOMContentLoaded', () => {
    if (!window.dymo) {
        console.error('DYMO framework not loaded');
        return;
    }

    // Expose methods to main process
    const { contextBridge, ipcRenderer } = require('electron');

    contextBridge.exposeInMainWorld('dymoAPI', {
        printLabel: (labelXml, printerName, labelData) => {
            try {
                const label = dymo.label.framework.openLabelXml(labelXml);

                // Set fields
                Object.keys(labelData).forEach(field => {
                    label.setObjectText(field, labelData[field]);
                });

                const printers = dymo.label.framework.getPrinters();
                if (!printers || printers.length === 0) {
                    throw new Error('No DYMO printers detected');
                }

                label.print(printerName || printers[0].name);
                return { success: true };
            } catch (err) {
                console.error('Error printing DYMO label:', err);
                return { success: false, error: err.message };
            }
        }
    });
});
