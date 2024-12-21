const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');

let configWindow; // Declare a global variable to store the reference to the configuration window
let passwordWindow;
let resetPasswordWindow;
// Initialize default URL for app window
const defaultURL = 'https://dev.societyfiles.com/vendor/point-of-sale?active=buy';
let store; // Electron store for persisting configuration
const receiptFilePath = path.join(__dirname, 'receipt_new.txt');

function stripHtml(htmlString) {
    return htmlString
        .replace(/<\/p>/g, "\n") // Replace closing </p> tags with a newline
        .replace(/<\/?[^>]+(>|$)/g, ""); // Remove all other HTML tags
}

function generateAndPrintReceipt(receiptData) {
    // Helper functions for formatting text
    const padRight = (text, width) => text.padEnd(width);
    const padLeft = (text, width) => text.padStart(width);

    const formatCurrency = (amount) => {

        return amount.toFixed(2);
    };
    const isDuplicate =  false;
    const status = receiptData.order?.cart_status === 3 ? "Pending" : receiptData.order?.cart_status === 4 ? "In-Progress" : '';
    // Extract business, customer, and user details from receiptData
    const business = receiptData.order.Business || receiptData.order.business;
    const customer = receiptData.order.Customer || receiptData.order.customer;

    let customer_note = receiptData?.order?.Sub_orders[0].customer_note;
    const user = receiptData.order.User || receiptData.order.user;
    const { sell_print_data, repair_print_data } = receiptData.businessData;
    const orderItems = receiptData.order?.Cart_items?.length > 0 ? receiptData?.order?.Cart_items : receiptData?.order?.Sub_orders[0].Order_items?.length > 0 ? receiptData?.order.Sub_orders[0].Order_items : [];

    const salesOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === false) : [];
    const replacementOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === true) : [];
console.log(salesOrderItems, "=====salesOrderItems");
    const updatedOrderType = salesOrderItems?.filter(i => i.is_active_for === 3)?.length ? "Repair" : "Sale";

    // Initialize the receipt buffer
    const receiptBuffer = [];
    receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer

    receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19])); // Select Code Page 858 (CP858)
    receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x01]));  // Center align
    receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
    receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x01]));

    receiptBuffer.push(Buffer.from(`${business.business_name}`));

    receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x00]));
    receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold ON
    if (!isDuplicate) {
        receiptBuffer.push(Buffer.from('********* DUPLICATE RECEIPT *********\n'));
    }
    receiptBuffer.push(Buffer.from(`\n\n${business.business_address}\n`));
    receiptBuffer.push(Buffer.from(`${business.post_code}\n`));
    receiptBuffer.push(Buffer.from(`Tel: ${business.business_phone_no}\n`));
    receiptBuffer.push(Buffer.from(`WhatsApp: ${business.business_whatsapp_no}\n\n`));

    // Add receipt information
    receiptBuffer.push(Buffer.from('----------------------------------------\n'));
    receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Re-initialize printer
    receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
    receiptBuffer.push(Buffer.from(` Date: ${new Date(receiptData.order.created_at).toLocaleString()}\n`));
    receiptBuffer.push(Buffer.from(`Terminal: ${user.first_name} ${user.last_name}\n`));
    receiptBuffer.push(Buffer.from(`Order Type: ${updatedOrderType}\n`));
    receiptBuffer.push(Buffer.from(`Receipt #: ${receiptData.order.cart_no}\n\n`));


    if (customer) {
        receiptBuffer.push(Buffer.from('----------------------------------------\n'));
        receiptBuffer.push(Buffer.from(`Name: ${customer.full_name}\n`));
        if (customer.cell_no) { receiptBuffer.push(Buffer.from(`Mobile: ${customer.cell_no}\n`)); }
        if (customer.email !== "") { receiptBuffer.push(Buffer.from(`Email: ${customer.email}\n`)); }
        if (customer.address !== "") { receiptBuffer.push(Buffer.from(`Address: ${customer.address}\n`)); }
        receiptBuffer.push(Buffer.from('----------------------------------------\n'));
    }
    // // Add Header for Sales Items
    if (salesOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from("SALES"));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold ON
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }

    // Process Sales Items
    if (salesOrderItems?.length > 0) {
        salesOrderItems.forEach((item) => {

            // Product Details: Align product number and name
            receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
            receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
            receiptBuffer.push(Buffer.from(` ${item.Product?.product_no ? item.Product?.product_no : item?.product_no}-${item?.Product?.name ? item.Product.name : item?.product_name} `));
                if(item?.current_price > 0){
                    receiptBuffer.push(
                        Buffer.concat([
                            Buffer.from(`-(${item.quantity}x`),
                            Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                            Buffer.from(`${formatCurrency(item.current_price)}=`),
                            Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                            Buffer.from(`${formatCurrency((item.current_price) * item.quantity)})\n`)
                        ]));
                }

            if (item?.item_discount && item.item_discount > 0) {
                receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
                receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                receiptBuffer.push(
                    Buffer.concat([
                        Buffer.from(` Discount: `),
                        Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                        Buffer.from(`${formatCurrency(item.item_discount)}\n`)
                    ])
                );
            }

            // IMEI or Serial No: Add IMEI/Serial No if available
            if (item?.product_sn_imei_no) {
                const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
                receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }

            // notes or Serial No: Add IMEI/Serial No if available
            if (item?.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
                receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }

            // Additional Custom Fields: For repair or other custom data
            if (item?.repair_work_data?.customer_field_data?.length > 0) {
                item?.repair_work_data?.customer_field_data.forEach((field) => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
                        receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }

            if (item.Order_question_options?.length > 0) {
                const groupedOptions = item.Order_question_options.reduce((acc, option) => {
                    const { question_title, option_label } = option;
                    if (!acc[question_title]) {
                        acc[question_title] = [];
                    }
                    acc[question_title].push(option_label);
                    return acc;
                }, {});

                Object.entries(groupedOptions).forEach(([questionTitle, options]) => {

                    receiptBuffer.push(Buffer.from(`${questionTitle}: ${options.join(", ")}`))
                });
            }

            receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
            receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x02]));  // right align
            // Pricing and Quantity: Format price and quantity
            const priceLine = `${formatCurrency((item.current_price - item.item_discount) * item.quantity)}`;
            receiptBuffer.push(
                Buffer.concat([
                    Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                    Buffer.from(`${priceLine}\n`)
                ])
            );
            // receiptBuffer.push(Buffer.from(`${priceLine}\n`));
            receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
            receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // left align
            // Add separator line after each item
        });
    }

    // Add Header for Replacement Items if applicable
    if (replacementOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from("REPLACEMENT"));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold OFF
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }

    // Process Replacement Items
    if (replacementOrderItems?.length > 0) {
        replacementOrderItems.forEach((item) => {
            // Product Details: Format quantity, product number, and name for replacements
            const productLine = `${padRight(`${item.quantity} x ${item?.Product?.product_no || item.product_no}`, 20)} ${padRight(item?.Product?.name || item.product_name, 20)}`;
            receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
            receiptBuffer.push(Buffer.from(`${productLine}\n`));

            // Additional Details for Replacement Items
            if (item.product_sn_imei_no) {
                receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                const imeiType = item.product_sn_imei_type === 1 ? "IMEI" : "Serial No";
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }

            // notes or Serial No: Add IMEI/Serial No if available
            if (item.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }

            if (item.repair_work_data?.customer_field_data?.length > 0) {
                item.repair_work_data.customer_field_data.forEach((field) => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }
        });
    }
  
    // Add totals and final amounts
    receiptBuffer.push(Buffer.from('----------------------------------------\n\n'));
    if(receiptData.order.sub_total > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from('Subtotal:           '),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.sub_total)}\n`)
            ])
        );
       }

    if (receiptData.order.total_discount > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from('Discount:           '),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.total_discount)}\n`)
            ])
        );
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from('Total:              '),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.total)}\n`)
            ])
        );
    }

    if (receiptData.order.tax_total > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`${business.tax_title} (${business.vat}%):          `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.tax_total)}\n`)
            ])
        );

    }
    if(receiptData.order.grand_total){
        // Make 'Grand Total' bold and bigger size
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x01]));
        receiptBuffer.push(Buffer.from(`Grand Total:        `))
        receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19, 0x9C]));
        receiptBuffer.push(Buffer.from(`${formatCurrency(receiptData.order.grand_total)}\n\n`));
        // Reset to normal font and weight
        receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x00]));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold OFF
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`Paid:               `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.total_amount_received)}\n`)
            ])
        );

        receiptBuffer.push(Buffer.from(`Cash: ${receiptData.order.cash}, Card: ${receiptData.order.credit_card}, Bank: ${receiptData.order.credit_card}\n`));
    }
   
    if (receiptData.order.remaining_amount > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`Balance:             `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.remaining_amount)}\n`)
            ])
        );
    }
 
    receiptBuffer.push(
        Buffer.concat([
            Buffer.from(`Status:              `),
            Buffer.from(`${status === "" ? "Complete" : status}\n\n`)
        ])
    );

    if (receiptData?.order?.Payment_logs?.length > 1) {

        receiptBuffer.push(Buffer.from(`Payment Logs: \n`));
        receiptData.order.Payment_logs.forEach(log => {
            if (log.cash + log.bank + log.credit_card > 0) {
                receiptBuffer.push(
                    Buffer.concat([
                        Buffer.from(`${new Date(log.created_at).toLocaleString()} : `),
                        Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                        Buffer.from(`${log.cash + log.bank + log.credit_card}\n`),
                        Buffer.from(`${log.remarks !== "" ? `${log.remarks}\n` : ""}`)
                    ])
                );
            }

        })
        receiptBuffer.push(Buffer.from(`\n`));
    }

    if (customer_note === "") {
        const status = receiptData.order?.cart_status === 3 ? "Pending" : receiptData.order?.cart_status === 4 ? "In-Progress" : 30;

        if (updatedOrderType === "Repair") {
            if (receiptData?.order?.cart_status === 3) {
                customer_note = repair_print_data.pending_note.note;
            }
            if (receiptData?.order?.cart_status === 4) {
                customer_note = repair_print_data.procress_note.note;
            }
            if (status === 30) {
                customer_note = repair_print_data.complete_note.note;
            }
        }
        if (updatedOrderType === "Sale") {
            if (receiptData?.order?.cart_status === 3) {
                customer_note = sell_print_data.pending_note.note;
            }
            if (receiptData?.order?.cart_status === 4) {
                customer_note = sell_print_data.procress_note.note;
            }
            if (status === 30) {
                customer_note = sell_print_data.complete_note.note;
            }
        }
    }

    // receiptBuffer.push(Buffer.from(stripHtml(customer_note)));
    receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x01]));
    receiptBuffer.push(Buffer.from(`\nThank You for Your order!\n`))
    receiptBuffer.push(Buffer.from(`See you again soon!\n\n`))

    // Initialize Printer
    receiptBuffer.push(Buffer.from([0x1B, 0x40])); // Reset printer
    receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x01])); // Center align
    receiptBuffer.push(Buffer.from([0x1D, 0x68, 80])); // Set barcode height (80 dots)
    receiptBuffer.push(Buffer.from([0x1D, 0x77, 2])); // Set barcode width (2 dots)

    // CODE39 Barcode Test
    receiptBuffer.push(Buffer.from([0x1D, 0x6B, 0x04, ...Buffer.from(`${receiptData.order.cart_no}\0`)]));
    receiptBuffer.push(Buffer.from(`\n${receiptData.order.cart_no}`));

    receiptBuffer.push(Buffer.from('\n\n\n\n\n\n'));
    // Cut the paper after the receipt is printed
    receiptBuffer.push(Buffer.from([0x1D, 0x56, 0x00]));  // Full cut

    // Ensure all elements in escPosCommands are Buffers before calling Buffer.concat()
    const flatCommands = receiptBuffer.flat(); // Flatten the array in case any nested arrays are present
    const finalBuffer = Buffer.concat(flatCommands);

    // Write the receipt to a file (for testing purposes)
    const receiptFilePath = path.join(__dirname, 'receipt.txt');
    fs.writeFileSync(receiptFilePath, finalBuffer);

    console.log('Receipt generated and written to:', receiptFilePath);
    const { printerBrand, printerPort } = loadPrinterPortConfig();
    // In a real application, send finalBuffer to the printer.
    // Sending the print command using the Windows command line to the specific printer.
    // const printerCommand = `print /D:"\\\\DESKTOP-1CBF04U\\EPSO TM-T88V Receipt" ${receiptFilePath}`;
    const printerCommand = `print /D:"${printerPort}" "${receiptFilePath}"`;
   
    exec(printerCommand, (error, stdout, stderr) => {
        if (error) {
            console.error('Error printing the receipt:', error);
        } else {
            console.log('Print command executed successfully:', stdout);
            // Open the cash drawer if password matches
            if (!isDuplicate) {
                openCashDrawerForInstalledPrinter().catch((err) => {
                    console.error('Failed to open cash drawer:', err);
                });
            }

        }
    });
}

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

async function openCashDrawerForInstalledPrinter() {
    try {
        // ESC/POS command to open the cash drawer (Drawer 1)
        const drawerCommand = Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFF]);
        const tempFilePath = path.join(os.tmpdir(), 'drawerCommand.bin');

        // Write the binary command to a temporary file
        fs.writeFileSync(tempFilePath, drawerCommand);

        // Verify if the file was created successfully
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`File not created: ${tempFilePath}`);
        }

        // Load the printer port from config
        const { printerPort } = loadPrinterPortConfig();

        if (!printerPort) {
            dialog.showErrorBox('Error', 'Printer port is not configured.');
            return;
        }

        const command = `print /D:"${printerPort}" "${tempFilePath}"`;
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
                fs.unlinkSync(tempFilePath); // Clean up temporary file
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
        passwordWindow = null;
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
ipcMain.on('save-printer-config', (event, { printerBrand, printerName, printerPort, password }) => {
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
ipcMain.on('submit-reset-password', async (event, password) => {
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
