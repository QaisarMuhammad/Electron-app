const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');

let configWindow; // Declare a global variable to store the reference to the configuration window
let passwordWindow;
let resetPasswordWindow;
// Initialize default URL for app window
const defaultURL = 'http://localhost:3000/vendor/point-of-sale?active=buy';
let store; // Electron store for persisting configuration
const receiptFilePath = path.join(__dirname, 'receipt_new.txt');

// ESC/POS commands as byte sequences for receipt and barcode
// const escPosCommands = [
//     // Initialize printer (ESC @)
//     Buffer.from([0x1B, 0x40]),  // ESC @: Initialize printer
//     Buffer.from('Item         Qty   1\n'),
//     // Barcode Command for Code39
//     // Buffer.from([0x1D, 0x6B, 0x45, 0x06]),  // GS k (Code39), Length 6
//     // Buffer.from('123456'),  // Barcode Data
//     // Buffer.from([0x0A]),  // Line feed (Print the barcode)

// //     Buffer.from('Item         Qty   2\n'),
// //     // Barcode Command for UPC-A
// //     Buffer.from([0x1D, 0x6B, 0x41, 0x0A]),  // GS k (UPC-A), Length 10
// //     Buffer.from('123456789012'),  // Barcode Data (12 digits)
// //     Buffer.from([0x0A]),  // Line feed (Print the barcode)
// //     Buffer.from('Item         Qty   3\n'),

// //     // Barcode Command for UPC-E
// //     Buffer.from([0x1D, 0x6B, 0x42, 0x06]),  // GS k (UPC-E), Length 6
// //     Buffer.from('123456'),  // Barcode Data (6 digits)
// //     Buffer.from([0x0A]),  // Line feed (Print the barcode)

// //     Buffer.from('Item         Qty   4\n'),
// //     // Barcode Command for EAN-13
// // Buffer.from([0x1D, 0x6B, 0x43, 0x0D]),  // GS k (EAN-13), Length 13
// // Buffer.from('1234567890123'),  // Barcode Data (13 digits)
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)

// // Buffer.from('Item         Qty   5\n'),
// // // Barcode Command for EAN-8
// // Buffer.from([0x1D, 0x6B, 0x44, 0x08]),  // GS k (EAN-8), Length 8
// // Buffer.from('12345678'),  // Barcode Data (8 digits)
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)

// // Buffer.from('Item         Qty   6\n'),
// // // Barcode Command for Code128
// // Buffer.from([0x1D, 0x6B, 0x49, 0x06]),  // GS k (Code128), Length 6
// // Buffer.from('123456'),  // Barcode Data
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)

// Buffer.from('Item         Qty   7\n'),
// // Barcode Command for Interleaved 2 of 5 (ITF)
// Buffer.from([0x1D, 0x6B, 0x46, 0x0A]),  // GS k (Interleaved 2 of 5), Length 10
// Buffer.from('1234567890'),  // Barcode Data (10 digits)
// Buffer.from([0x0A]),  // Line feed (Print the barcode)
// Buffer.from('Item         Qty   7\n'),

// Buffer.from('Item         Qty   7\n'),

// Buffer.from('Item         Qty   7\n'),
// Buffer.from('Item         Qty   7\n'),
// Buffer.from('Item         Qty   7\n'),


// // Buffer.from('Item         Qty   8\n'),
// // // Barcode Command for Codabar
// // Buffer.from([0x1D, 0x6B, 0x45, 0x06]),  // GS k (Codabar), Length 6
// // Buffer.from('A123456B'),  // Barcode Data (Codabar format can have letters like A/B)
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)



// // Buffer.from('Item         Qty   9\n'),

// // // Barcode Command for EAN-128
// // Buffer.from([0x1D, 0x6B, 0x49, 0x0D]),  // GS k (EAN-128), Length 13
// // Buffer.from('1234567890123'),  // Barcode Data (13 digits)
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)

// // Buffer.from('Item         Qty   10\n'),
// // // Barcode Command for PostNet
// // Buffer.from([0x1D, 0x6B, 0x47, 0x06]),  // GS k (PostNet), Length 6
// // Buffer.from('1234567890'),  // Barcode Data (example)
// // Buffer.from([0x0A]),  // Line feed (Print the barcode)


//     // Cut the paper (optional)
//     Buffer.from([0x1D, 0x56, 0x00]),  // Full cut command (GS V 0 for full cut)
// ];
// Assuming you're sending this buffer to the printer via network or serial

// Send the above commands to the printer

function generateAndPrintReceipt(receiptData) {
    console.log(receiptData, "=====receiptData")
    // ESC/POS commands as buffers
    const escPosCommands = [
        // Initialize printer
        Buffer.from([0x1B, 0x40]),

        // Center align for store details
        Buffer.from([0x1B, 0x61, 0x01]),
        // Buffer.from(`${receiptData.storeName}\n`),
        // Buffer.from(`${receiptData.address || ''}\n`),
        // Buffer.from(`${receiptData.city || ''}\n\n`),

        // Left align for items section
        Buffer.from([0x1B, 0x61, 0x00]),
        Buffer.from('--------------------------------\n'),
        Buffer.from('Item              Qty   Price\n'),
        Buffer.from('--------------------------------\n'),

        // Loop through items
        // ...receiptData.items.map(item => {
        //     const itemName = item.name.padEnd(16, ' '); // Ensure consistent spacing
        //     const itemQty = item.qty.toString().padStart(3, ' ');
        //     const itemPrice = `$${item.price.toFixed(2)}`.padStart(8, ' ');
        //     return Buffer.from(`${itemName}${itemQty}${itemPrice}\n`);
        // }),

        // Footer section
        Buffer.from('--------------------------------\n'),
        // Buffer.from(`Subtotal:               $${receiptData.subtotal.toFixed(2)}\n`),
        // Buffer.from(`Discount:              -$${receiptData.discount.toFixed(2)}\n`),
        // Buffer.from(`Total:                  $${receiptData.total.toFixed(2)}\n`),
        Buffer.from('--------------------------------\n\n'),
        Buffer.from('Thank you for shopping!\n\n'),

        // Add some space before barcode
        Buffer.from([0x0A, 0x0A]),

        // // Print Barcode (Code128)
        // Buffer.from([0x1D, 0x6B, 0x49, receiptData.barcode.length]),
        // Buffer.from(receiptData.barcode),

        // Add some space before cutting the paper
        Buffer.from([0x0A, 0x0A]),

        // Cut the paper
        Buffer.from([0x1B, 0x64, 0x03]),
    ];

    // Combine all buffers into a single buffer
    const finalBuffer = Buffer.concat(escPosCommands);

    // Write the receipt to a file (for testing purposes)
    const receiptFilePath = path.join(__dirname, 'receipt.txt');
    fs.writeFileSync(receiptFilePath, finalBuffer);

    console.log('Receipt generated and written to:', receiptFilePath);

    // In a real application, send finalBuffer to the printer.
    // Sending the print command using the Windows command line to the specific printer.
    const printerCommand = `print /D:"\\\\DESKTOP-1CBF04U\\EPSO TM-T88V Receipt" ${receiptFilePath}`;
    const exec = require('child_process').exec;

    exec(printerCommand, (error, stdout, stderr) => {
        if (error) {
            console.error('Error printing the receipt:', error);
        } else {
            console.log('Print command executed successfully:', stdout);
        }
    });
}


// Create the receipt file
// fs.open(receiptFilePath, 'w', (err, fd) => {
//     if (err) {
//         console.error('Error opening file:', err);
//         return;
//     }

//     // Write each ESC/POS command and text to the file
//     escPosCommands.forEach((command) => {
//         fs.write(fd, command, (err) => {
//             if (err) {
//                 console.error('Error writing to file:', err);
//             }
//         });
//     });

//     // Close the file after writing all data
//     fs.close(fd, (err) => {
//         if (err) {
//             console.error('Error closing file:', err);
//         } else {
//             console.log('Receipt with barcode saved to', receiptFilePath);
//         }
//     });
// });


// Function to load Electron Store
async function loadStore() {
    const { default: ElectronStore } = await import('electron-store');
    store = new ElectronStore(); // Initialize the electron-store
}

// Function to create the main application window
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

    newWindow.loadURL(url); // Load the dashboard URL

    newWindow.webContents.setWindowOpenHandler(({ url }) => {
        createWindow(url);
        return { action: 'deny' };
    });

    newWindow.zoomLevel = 1;
    return newWindow;
}

// Function to open the cash drawer for printers, including virtual ports like ESDPRT001
async function openCashDrawerForInstalledPrinter() {
    try {
        // ESC/POS command to open the cash drawer (Drawer 1)
         // Load the printer port from config
         const {printerBrand,  printerPort } = loadPrinterPortConfig();
         const n1 = 20; // Energizing time (200 ms)
         const n2 = 20; // Delay time (200 ms)
         const starPrinterDrawerCommand2 = Buffer.from([0x1B, 0x70, 0x00, 0x32, 0xFA]);
         
         // Writing this command to a binary file
         const fs = require('fs');
         const path = require('path');
         const tempFilePath2 = path.join(os.tmpdir(), 'STARdrawerCommand2.bin');
         
         fs.writeFileSync(tempFilePath2, starPrinterDrawerCommand2);

        const epsonPrinterDrawerCommand = Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFF]);
        const starPrinterDrawerCommand = Buffer.from([0x1B, 0x1D, 0x61, 0x01, 0x1B, 0x70, 0x00, 0x19, 0x78]);
        const tempFilePath = path.join(os.tmpdir(), 'drawerCommand.bin');
        const EPSONtempFilePath = path.join(os.tmpdir(), 'EPSONdrawerCommand.bin');
        const STARtempFilePath = path.join(os.tmpdir(), 'STARdrawerCommand.bin');
        // Write the binary command to a temporary file
        fs.writeFileSync(EPSONtempFilePath, epsonPrinterDrawerCommand);
       
        fs.writeFileSync(STARtempFilePath, starPrinterDrawerCommand);

        if(printerBrand === 'Epson'){
            fs.writeFileSync(tempFilePath, epsonPrinterDrawerCommand);

        }else
        if(printerBrand === 'Star'){
        fs.writeFileSync(tempFilePath, starPrinterDrawerCommand);
        }else{
            fs.writeFileSync(tempFilePath, epsonPrinterDrawerCommand);
        }

        // Verify if the file was created successfully
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`File not created: ${tempFilePath}`);
        }
        

        if (!printerPort) {
            dialog.showErrorBox('Error', 'Printer port is not configured.');
            return;
        }

        let command;

        // Determine if the port is an ESDPRT (virtual port) or another type
        if (/^ESDPRT\d+$/i.test(printerPort)) {
            // For virtual ports like ESDPRT001, we should not print but rather execute the command directly.
            // We'll use PowerShell to execute the ESC/POS command using Invoke-Expression
            command = `powershell -Command "[System.IO.File]::WriteAllBytes('${printerPort}', [System.IO.File]::ReadAllBytes('${tempFilePath}'))"`;
        } else if (/^COM\d+$/i.test(printerPort) || /^LPT\d+$/i.test(printerPort) || /^USB\d+$/i.test(printerPort)) {
            // Serial, Parallel, or USB ports (COM, LPT, USB)
            command = `print /D:"${printerPort}" "${tempFilePath}"`;
        } else if (/^IP_/.test(printerPort)) {
            // Network printers (IP)
            const ipAddress = printerPort.replace('IP_', '');
            command = `lpr -S ${ipAddress} -P RAW "${tempFilePath}"`;
        } else if (/^\\\\.+\\.+$/.test(printerPort)) {
            // Network shared printers (UNC paths)
            command = `print /D:"${printerPort}" "${tempFilePath}"`;
        } else {
            // fs.unlinkSync(tempFilePath); // Clean up the temporary file
            return;
        }


        // Execute the command
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error opening cash drawer: ${error.message}`);
                dialog.showErrorBox('Error', `Failed to open cash drawer: ${error.message}`);
            } else {
                console.log(`Cash drawer opened: ${stdout}`);
            }

            // Ensure the file is deleted after use
            if (fs.existsSync(tempFilePath)) {
                // fs.unlinkSync(tempFilePath); // Clean up temporary file
                console.log(`Temporary file deleted: ${tempFilePath}`);
            }
        });
    } catch (err) {
        console.error('Failed to open cash drawer:', err);
    }
}


// Function to prompt the user for a password and open the cash drawer if correct
async function openCashDrawer() {
    const { password: savedPassword } = loadPrinterPortConfig();

    if (!savedPassword) {
        dialog.showErrorBox('Error', 'No password is set for the cash drawer.');
        return;
    }

    // Create a modal window to prompt for the password
     passwordWindow = new BrowserWindow({
        width: 350,
        height: 270,
        parent: BrowserWindow.getFocusedWindow(), // Set the parent window
        modal: true, // Make it a modal
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js') // Preload for IPC communication
        }
    });

    passwordWindow.loadFile(path.join(__dirname, 'password-prompt.html'));
    passwordWindow.setMenu(null);
    passwordWindow.on('closed', () => {
        // Clean up if needed when the window is closed
        passwordWindow= null;
    });

}


// Function to load the printer port configuration from the store
function loadPrinterPortConfig() {
    if (store) {
        const printerName = store.get('printerName');
        const printerPort = store.get('printerPort');
        const password = store.get('password'); // Load the saved password
        return { printerName, printerPort, password };
    } else {
        console.error('Store is not initialized');
        return { printerName: null, printerPort: null, password: null };
    }
}

// Function to reset the printer configuration in the store
function resetPrinterConfig() {
    if (store) {
        store.delete('printerName');
        store.delete('printerPort');
        store.delete('password'); // Reset password as well
        dialog.showMessageBox({
            type: 'info',
            title: 'Reset Printer Configuration',
            message: 'Printer configuration has been reset.',
        });
    } else {
        console.error('Store is not initialized');
    }
}

// Function to open the reset password window
function openResetPasswordWindow() {
     resetPasswordWindow = new BrowserWindow({
        width: 300,
        height: 315,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        }
    });

    resetPasswordWindow.loadFile(path.join(__dirname, 'reset-password.html'));
    resetPasswordWindow.setMenu(null);
    resetPasswordWindow.on('closed', () => {
        // Dereference the window object when it is closed
        resetPasswordWindow = null;
    });
}

// Function to open the printer configuration window
function openPrinterConfigWindow() {
    if (!configWindow) {
        configWindow = new BrowserWindow({
            width: 355,
            height: 510,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        configWindow.loadFile(path.join(__dirname, 'printer-config.html'));
        configWindow.setMenu(null);
        // Dereference the window object once it is closed
        configWindow.on('closed', () => {
            configWindow = null;
        });
    }
}

// Function to create the application menu
function createMenu() {
    const template = [
        {
            label: 'Open Drawer (ctrl+D)',
            accelerator: 'CmdOrCtrl+D',
            click: openCashDrawer, // Opens drawer directly using stored configuration
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+Plus',
                    role: 'zoomIn', // Role is set to 'zoomIn' for built-in functionality
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    role: 'zoomOut', // Role is set to 'zoomOut' for built-in functionality
                },
                {
                    label: 'Reset Zoom',
                    accelerator: 'CmdOrCtrl+0',
                    role: 'resetZoom', // Role is set to 'resetZoom' for built-in functionality
                },
            ],
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Configure Printer',
                    accelerator: 'CmdOrCtrl+K',
                    click: openPrinterConfigWindow, // Use the global configWindow function
                },
                {
                    label: 'Reset Printer Configuration',
                    accelerator: 'CmdOrCtrl+R',
                    click: async () => {
                        await openResetPasswordWindow(); // Trigger the reset function with password check
                    },
                },
            ],
        },
        {
            label: 'Quit',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
                app.quit(); // Quit the app
            },
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu); // Set the custom menu
}


// Handle the event from the renderer (frontend)
ipcMain.on('send-receipt-data', (event, receiptData) => {
    console.log('Received receipt data:', receiptData);
    generateAndPrintReceipt(receiptData); // Custom function to handle receipt printing
});

// IPC handler to save printer configuration from renderer process
ipcMain.on('save-printer-config', (event, { printerBrand,printerName, printerPort, password }) => {
    if (store) {
        store.set('printerBrand', printerBrand);
        store.set('printerName', printerName);
        store.set('printerPort', printerPort);
        store.set('password', password); // Save the password as well

        dialog.showMessageBox({
            type: 'info',
            title: 'Configuration Saved',
            message: `${printerBrand} Printer Name: ${printerName}\nPrinter Port: ${printerPort}\nPassword: Saved`
        }).then(() => {
            // Close the configuration window after saving
            if (configWindow) {
                configWindow.close();
            }
        });
    } else {
        console.error('Store is not initialized');
    }
});

// IPC listener to handle password submission
ipcMain.on('submit-password', (event, enteredPassword) => {
    const { password: savedPassword } = loadPrinterPortConfig();
    console.log("enteredPassword: ", enteredPassword)
    if (enteredPassword === savedPassword) {
        // Close the password window if the password matches
        passwordWindow.close();

        // Open the cash drawer if password matches
        openCashDrawerForInstalledPrinter().catch((err) => {
            console.error('Failed to open cash drawer:', err);
        });
    } else {
        dialog.showErrorBox('Incorrect Password', 'The password you entered is incorrect. Please try again.');
    }
});

// IPC handler for password submission to reset the printer configuration
ipcMain.on('submit-reset-password', async (event,  password ) => {
    const { password: savedPassword } = loadPrinterPortConfig(); // Load the saved password

    if (password === savedPassword) {
        // Password is correct, proceed to reset the configuration
        resetPrinterConfig(); // Call the reset function
        resetPasswordWindow.close();
    } else {
        // Incorrect password
        dialog.showErrorBox('Incorrect Password', 'The password you entered is incorrect. Please try again.');
    }
});

// Initialize the application
app.on('ready', () => {
    loadStore().then(() => {
        createWindow(); // Create the main window
        createMenu();   // Create the menu
    }).catch(err => {
        console.error('Error initializing app:', err);
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(); // Recreate window if none are open
    }
});
