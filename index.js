const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const dns = require('dns');
require('dotenv').config(); 

let isOnline = true;
const defaultURL = `${process.env.APP_URL}/vendor/dashboard`;

function createWindow(url = defaultURL) {
    const newWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    loadAppropriatePage(newWindow, url);

    newWindow.webContents.setWindowOpenHandler(({ url }) => {
        createWindow(url);
        return { action: 'deny' };
    });

    newWindow.url = url;
    newWindow.zoomLevel = 1;

    return newWindow;
}

function checkInternetConnection(callback) {
    dns.lookup('google.com', (err) => {
        callback(!err || err.code !== 'ENOTFOUND');
    });
}

function loadAppropriatePage(window, url) {
    if (isOnline) {
        window.loadURL(url);
    } else {
        window.loadFile(path.join(__dirname, 'offline.html'));
    }
}

function printContent(content) {
    const printWindow = new BrowserWindow({ show: false });
    console.log("Loading URL for printing:", content);
    printWindow.loadURL(content);

    printWindow.webContents.on('did-finish-load', () => {
        console.log("Page did-finish-load:", content);
        setTimeout(() => {
            printWindow.webContents.print({ silent: true, printBackground: true }, (success, failureReason) => {
                if (!success) {
                    console.log("Print failed:", failureReason);
                } else {
                    console.log("Print succeeded");
                }
                printWindow.close();
            });
        }, 2000); // Delay to ensure complete rendering (adjust if necessary)
    });

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.log("Failed to load URL:", content, errorCode, errorDescription);
        printWindow.close();
    });
}

setInterval(() => {
    checkInternetConnection((isConnected) => {
        if (isConnected !== isOnline) {
            isOnline = isConnected;
            BrowserWindow.getAllWindows().forEach((win) => {
                const currentURL = win.url;
                if (isOnline) {
                    loadAppropriatePage(win, currentURL.includes('offline.html') ? defaultURL : currentURL);
                } else {
                    loadAppropriatePage(win, path.join(__dirname, 'offline.html'));
                }
            });
        }
    });
}, 5000);

app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.on('reload-main-window', () => {
    if (BrowserWindow.getAllWindows().length) {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        loadAppropriatePage(mainWindow, defaultURL);
    }
});

ipcMain.on('print-request', (event, content) => {
    console.log("Received print request with URL:", content);
    printContent(content);
});
