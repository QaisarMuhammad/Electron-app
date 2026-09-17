
const path = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const os = require('os');
// Attach the virtual font system
const { exec } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, dialog, session } = require('electron');

let configWindow; // Declare a global variable to store the reference to the configuration window
let configLabelWindow;
let configA4Window;
let passwordWindow;
let resetPasswordWindow;
// Initialize default URL for app window
const defaultURL = 'https://vendor.societyfiles.com/vendor/point-of-sale?active=buy';
let store; // Electron store for persisting configuration


app.disableHardwareAcceleration();



let dymoWindow; // hidden window to load DYMO framework once
async function loadDymoFramework() {
    return new Promise((resolve, reject) => {
        if (dymoWindow) return resolve(dymoWindow);

        dymoWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'dymo-preload.js')
            }
        });

        dymoWindow.loadFile(path.join(__dirname, 'dymo-loader.html'));

        dymoWindow.webContents.on('did-finish-load', () => {
            console.log('DYMO framework loaded in hidden window');
            resolve(dymoWindow);
        });

        dymoWindow.on('closed', () => {
            dymoWindow = null;
        });
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
        width: 1600,
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

// Function to load the printer port configuration from the store
function loadLabelPrinterPortConfig() {
    if (store) {
        const printerName = store.get('labelPrinterName');
        const printerPort = store.get('labelPrinterPort');
        const password = store.get('password'); // Load the saved password
        return { printerName, printerPort, password };
    } else {
        console.error('Store is not initialized');
        return { printerName: null, printerPort: null, password: null };
    }
}

// Function to load the printer port configuration from the store
function loadA4PrinterPortConfig() {
    if (store) {
        const printerName = store.get('a4PrinterName');
        const printerPort = store.get('a4PrinterPort');
        const password = store.get('a4Password'); // Load the saved password
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

// Function to open the Receipt printer configuration window
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

// Function to open the Receipt printer configuration window
function openPrinterA4ConfigWindow() {
    if (!configA4Window) {
        configA4Window = new BrowserWindow({
            width: 355,
            height: 510,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        configA4Window.loadFile(path.join(__dirname, 'printer-a4-config.html'));
        configA4Window.setMenu(null);
        // Dereference the window object once it is closed
        configA4Window.on('closed', () => {
            configA4Window = null;
        });
    }
}




function stripHtml(htmlString) {
    if (htmlString) {
        return htmlString
            .replace(/<\/p>/g, "\n") // Replace closing </p> tags with a newline
            .replace(/<\/?[^>]+(>|$)/g, ""); // Remove all other HTML tags
    } else {
        return "";
    }

}

function ensureSpace(doc, requiredHeight) {
    if (doc.y + requiredHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
    }
}


function createTable(doc, data, startX, startY, columnWidths, rowPadding = 5) {
    // Helper function to calculate the max height of a row
    const calculateRowHeight = (row) => {
        return row.reduce((maxHeight, cell, index) => {
            const cellWidth = columnWidths[index] - rowPadding * 2; // Subtract padding for text width
            const cellHeight = doc.heightOfString(cell, { width: cellWidth });
            return Math.max(maxHeight, cellHeight + rowPadding * 2); // Add padding for row height
        }, 0);
    };

    // Draw the table headers
    doc.fontSize(13).font('Helvetica-Bold');
    let y = startY;

    if (data?.headers) {
        // Draw header row
        const headerRowHeight = calculateRowHeight(data.headers);
        data.headers.forEach((header, index) => {
            doc.rect(startX + columnWidths.slice(0, index).reduce((a, b) => a + b, 0), y, columnWidths[index], headerRowHeight)
                .stroke();
            doc.text(header, startX + columnWidths.slice(0, index).reduce((a, b) => a + b, 0) + rowPadding, y + rowPadding, {
                width: columnWidths[index] - rowPadding * 2, align: 'left',
            });
        });
        y += headerRowHeight; // Move to the next row
    }

    // Draw table rows
    doc.fontSize(10).font('Helvetica');
    data.rows.forEach((row) => {
        const rowHeight = calculateRowHeight(row);
        row.forEach((cell, index) => {
            doc.rect(startX + columnWidths.slice(0, index).reduce((a, b) => a + b, 0), y, columnWidths[index], rowHeight)
                .stroke();
            doc.text(cell, startX + columnWidths.slice(0, index).reduce((a, b) => a + b, 0) + rowPadding, y + rowPadding, {
                width: columnWidths[index] - rowPadding * 2, align: 'left',
            });
        });
        y += rowHeight; // Move to the next row
    });
}

// Function to center text
const centerText = (doc, text, yPosition) => {
    const pageWidth = doc.page.width; // Get the width of the page
    const textWidth = doc.widthOfString(text); // Calculate the width of the text
    const xPosition = (pageWidth - textWidth) / 2; // Center the text
    doc.text(text, xPosition, yPosition);
};

async function generateA4Receipt(receiptData) {
    try {

        const doc = new PDFDocument({ margin: 30 });
        const outputPath = 'receipt-pdf.pdf';
        doc.pipe(fs.createWriteStream(outputPath));


        pageNumber = 1; // Reset page number
        totalPages = 1; // Initialize total pages count

        const drawPageHeader = (doc,) => {
            // Get the current page number and total pages
            const currentPage = pageNumber;
            const totalPages = doc.bufferedPageRange().count + 1; // Calculate the total pages

            // Set the color for the page number only
            doc.fillColor('#888888') // Grey color for the page number
                .font('Helvetica-Bold')
                .fontSize(8)
                .text(`Page ${currentPage}`, doc.page.width - 100, 10, { align: 'right' });

            // Reset the color if you want other content to not be affected
            doc.fillColor('black'); // Reset to default black color for other content
        };


        const fontSize = 10; // Font size for the text
        const lineHeight = 14; // Line height for each row, can adjust based on your font size
        const rowPaddingTop = 5; // Padding space for text from the top border of the row


        // Function to calculate the row height based on the number of lines
        const getRowHeight = (row) => {
            let maxLines = 0;
            row.forEach((cell) => {
                // Split cell content by '\n' to count lines
                const lines = cell.split('\n').length;
                if (lines > maxLines) maxLines = lines; // Find the max number of lines in any cell
            });
            return maxLines * lineHeight + rowPaddingTop + rowPaddingTop; // Add padding to row height
        };

        // Function to draw table headers
        const drawTableHeaders = (headers, columnWidths, alignments, x, y) => {
            let currentX = x; // Initialize the starting X position for the first column
            headers.forEach((header, index) => {
                const alignment = alignments[index]; // Get alignment for the current column
                doc.font('Helvetica-Bold').fontSize(fontSize).text(header, currentX, y, {
                    width: columnWidths[index],
                    align: alignment, // Use the alignment for the header
                });
                currentX += columnWidths[index]; // Move to the next column's X position
            });

            // Calculate the total width of all columns for the bottom border
            const totalWidth = columnWidths.reduce((acc, width) => acc + width, 0);

            doc.moveTo(x, y + lineHeight).lineTo(x + totalWidth, y + lineHeight).stroke();
        };

        // Function to draw table rows
        const drawTableRow = (row, columnWidths, alignments, x, y) => {
            let currentX = x; // Initialize the starting X position for the first column
            row.forEach((cell, index) => {
                const lines = cell.split('\n');
                const alignment = alignments[index]; // Get alignment for the current column
                lines.forEach((line, lineIndex) => {
                    doc.font('Helvetica').fontSize(fontSize).text(line, currentX, y + rowPaddingTop + lineIndex * lineHeight, {
                        width: columnWidths[index],
                        align: alignment, // Use the alignment for the row's cell
                    });
                });
                currentX += columnWidths[index]; // Move to the next column's X position
            });

            // Set the color for the bottom border to grey (light grey in this case)
            doc.strokeColor('#888888'); // Set stroke color to grey (light grey)

            // Calculate the total width of all columns for the bottom border
            const totalWidth = columnWidths.reduce((acc, width) => acc + width, 0);

            // Draw the bottom border line for the row
            doc.moveTo(x, y + getRowHeight(row) - rowPaddingTop)
                .lineTo(x + totalWidth, y + getRowHeight(row) - rowPaddingTop)
                .stroke();
        };

        // Function to draw the entire table (headers, rows, and handle page breaks)
        const drawTable = (tableData, x, y, doc) => {
            // Draw the table headers at the top of the table
            if (tableData?.headers) {
                drawTableHeaders(tableData.headers, tableData.columnWidths, tableData.alignments, x, y);
                y += lineHeight; // Move below headers
            }


            tableData.rows.forEach((row) => {
                const rowHeight = getRowHeight(row); // Calculate the dynamic row height

                // Check if there is enough space for the next row
                if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
                    doc.addPage(); // Add a new page if there isn't enough space
                    pageNumber++; // Increment page number
                    drawPageHeader(doc); // Add page header with page number
                    y = 40; // Reset Y position for the new page
                    if (tableData?.headers) {
                        drawTableHeaders(tableData.headers, tableData.columnWidths, tableData.alignments, x, y); // Redraw headers on the new page
                        y += lineHeight; // Adjust Y after headers
                    }
                }

                // Draw the row on the current page
                drawTableRow(row, tableData.columnWidths, tableData.alignments, x, y);
                y += rowHeight; // Move to the next row position
            });
        };
        // Draw the first page header
        drawPageHeader(doc);


        const formatCurrency = (amount) => {

            return `£${amount.toFixed(2)}`;
        };

        const isDuplicate = receiptData.isDuplicate || false;
        const status = receiptData.order?.cart_status === 3 ? "Pending" : receiptData.order?.cart_status === 4 ? "In-Progress" : '';
        // Extract business, customer, and user details from receiptData
        const business = receiptData.order.Business || receiptData.order.business;
        const customer = receiptData.order.Customer || receiptData.order.customer;

        let customer_note = receiptData?.order?.customer_note;
        const user = receiptData.order.User || receiptData.order.user;
        const { sell_print_data, repair_print_data } = receiptData.businessData;

        const orderItems = receiptData?.order?.Sub_orders[0].Order_items ? receiptData?.order?.Sub_orders[0].Order_items : receiptData?.order?.Sub_orders[0].Order_items?.length > 0 ? receiptData?.order.Sub_orders[0].Order_items : [];

        const salesOrderItems = status != "" && orderItems?.sale_items ? orderItems?.sale_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === false && item?.is_return === false && item?.is_trade_in === false) : [];
        const replacementOrderItems = status != "" && orderItems?.replacement_items ? orderItems?.replacement_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === true) : [];
        const returnOrderItems = status != "" && orderItems?.return_items ? orderItems?.return_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_return === true) : [];
        const tradeinOrderItems = status != "" && orderItems?.trade_items ? orderItems?.trade_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_trade_in === true) : [];

        const updatedOrderType = salesOrderItems?.filter(i => i.is_active_for === 3)?.length ? "Repair" : "Sale";

        // From and To Information
        // Add centered "From" information at the top of the page
        if (!sell_print_data?.show_business_info) {
            doc.moveDown(1);
            doc.fontSize(18).fillColor('black');
            doc.font('Helvetica-Bold').text(business.business_name, 40, 20, { underline: true });
            doc.font('Helvetica').fontSize(12).text(business.business_address, 40, 40);
            doc.text(business.post_code, 40);
            doc.text(`Tel: ${business.business_phone_no}`, 40);
            doc.text(`WhatsApp: ${business.business_whatsapp_no}`, 40);
        }


        doc.fontSize(12).text(`Invoice# ${receiptData.order.cart_no}`, 410, 20);

        if (receiptData?.order?.payments_against_total_balance === true && receiptData.order.customer_meta_data) {
            doc.text('Balance Due');
            doc.text(formatCurrency(receiptData.order.customer_meta_data.new_balance));
        }
        if (receiptData?.order?.payments_against_total_balance === false) {
            doc.text('Balance Due');
            doc.text(formatCurrency(receiptData.order.remaining_amount))
        }


        if (customer) {
            doc.moveDown(1);

            doc.font('Helvetica-Bold').text(`Bill To:`, 40, doc.y + 50, { underline: true });
            doc.font('Helvetica').text(`${customer.full_name}`, 40);
            if (customer.address !== "") { doc.text(`Address: ${customer.address}`, 40); }
            if (customer.cell_no) { doc.text(`Mobile: ${customer.cell_no}`, 40); }
            if (customer.email !== "") { doc.text(`Email: ${customer.email}`, 40); }

        }
        // Receipt Information (Left-aligned)
        doc.moveDown(1);
        // doc.fontSize(12).text('Receipt Information:', 370, 90, { underline: true });
        doc.text(`Date: ${new Date(receiptData?.order?.created_at).toLocaleString()}`, 370, 120);
        doc.text(`Terminal: ${user?.first_name} ${user?.last_name}`, 370);

        // Table Header for the First Table
        const columnWidths = [25, 300, 40, 70, 110];
        const rowHeight = 20;

        if (salesOrderItems?.length > 0) {
            doc.moveDown().font('Helvetica-Bold').fontSize(14).text(`SALE (${salesOrderItems?.length || 0})`, 40, doc.y + 40, { underline: true });


            const tableData = {
                headers: ['#', 'Item & Description', 'Qty', 'Rate', 'Amount'],
                rows: salesOrderItems.map((item, i) => {
                    const row = [];
                    row.push(i + 1);
                    let productLine = `${item?.Product?.name ? item.Product.name : item?.product_name}`;

                    const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                    const imei = item?.product_sn_imei_no && item?.product_sn_imei_no !== "" ? `\n${imeiType}: ${item.product_sn_imei_no}` : "";
                    const description = item?.product_sn_imei_description && item?.product_sn_imei_description !== "" ? `\n${item.product_sn_imei_description}` : '';

                    productLine = productLine + imei + description;
                    // Additional Custom Fields: For repair or other custom data
                    if (item?.repair_work_data?.customer_field_data?.length > 0) {
                        item?.repair_work_data?.customer_field_data.forEach((field) => {
                            if (field.value) {
                                productLine = productLine + `\n${field.field_label}: ${field.value}`;
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
                            productLine = productLine + `\n${questionTitle}: ${options.join(", ")}`;
                        });
                    }

                    row.push(productLine);
                    row.push(item.quantity);
                    row.push(formatCurrency((item.current_price - item.item_discount)));
                    row.push(formatCurrency((item.current_price - item.item_discount) * item.quantity));
                    return row;
                }).map(row => row.map(cell => String(cell))),
                columnWidths: [25, 300, 40, 70, 110], // Custom column widths for each column
                alignments: ['left', 'left', 'right', 'right', 'right'], // Alignment for each column (left, center, right)
            };

            drawTable(tableData, 40, doc.y + 10, doc);
        }

        if (returnOrderItems?.length > 0) {
            // Check if there is enough space for the next row
            if (doc.y + 70 > doc.page.height - doc.page.margins.bottom) {
                doc.addPage(); // Add a new page if there isn't enough space
                pageNumber++; // Increment page number
                drawPageHeader(doc); // Add page header with page number   
                doc.moveDown();
            }
            doc.moveDown().font('Helvetica-Bold').fontSize(14).text(`RETURNS (${returnOrderItems?.length || 0})`, 40, doc.y + 25, { underline: true });


            const returnTableData = {
                headers: ['#', 'Item & Description', 'Qty', 'Rate', 'Amount'],
                rows: returnOrderItems.map((item, i) => {
                    const row = [];
                    row.push(i + 1);
                    let productLine = `${item?.Product?.name ? item.Product.name : item?.product_name}`;

                    const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                    const imei = item?.product_sn_imei_no && item?.product_sn_imei_no !== "" ? `\n${imeiType}: ${item.product_sn_imei_no}` : "";
                    const description = item?.product_sn_imei_description && item?.product_sn_imei_description !== "" ? `\n${item.product_sn_imei_description}` : '';

                    productLine = productLine + imei + description;
                    // Additional Custom Fields: For repair or other custom data
                    if (item?.repair_work_data?.customer_field_data?.length > 0) {
                        item?.repair_work_data?.customer_field_data.forEach((field) => {
                            if (field.value) {
                                productLine = productLine + `\n${field.field_label}: ${field.value}`;
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
                            productLine = productLine + `\n${questionTitle}: ${options.join(", ")}`;
                        });
                    }

                    row.push(productLine);
                    row.push(item.quantity);
                    row.push(formatCurrency((item.current_price - item.item_discount)));
                    row.push(formatCurrency((item.current_price - item.item_discount) * item.quantity));
                    return row;
                }).map(row => row.map(cell => String(cell))),
                columnWidths: [25, 300, 40, 70, 110], // Custom column widths for each column
                alignments: ['left', 'left', 'right', 'right', 'right'], // Alignment for each column (left, center, right)
            };

            drawTable(returnTableData, 40, doc.y, doc);
        }


        if (replacementOrderItems?.length > 0) {
            // Check if there is enough space for the next row
            if (doc.y + 70 > doc.page.height - doc.page.margins.bottom) {
                doc.addPage(); // Add a new page if there isn't enough space
                pageNumber++; // Increment page number
                drawPageHeader(doc); // Add page header with page number   
                doc.moveDown();
            }
            doc.moveDown().font('Helvetica-Bold').fontSize(14).text(`REPLACEMENTS (${replacementOrderItems?.length || 0})`, 40, doc.y + 10, { underline: true });
            doc.moveDown();

            const returnTableData = {
                headers: ['#', 'Item & Description', 'Qty'],
                rows: replacementOrderItems.map((item, i) => {
                    const row = [];
                    row.push(i + 1);
                    let productLine = `${item?.Product?.name ? item.Product.name : item?.product_name}`;

                    const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                    const imei = item?.product_sn_imei_no && item?.product_sn_imei_no !== "" ? `\n${imeiType}: ${item.product_sn_imei_no}` : "";
                    const description = item?.product_sn_imei_description && item?.product_sn_imei_description !== "" ? `\n${item.product_sn_imei_description}` : '';

                    productLine = productLine + imei + description;
                    // Additional Custom Fields: For repair or other custom data
                    if (item?.repair_work_data?.customer_field_data?.length > 0) {
                        item?.repair_work_data?.customer_field_data.forEach((field) => {
                            if (field.value) {
                                productLine = productLine + `\n${field.field_label}: ${field.value}`;
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
                            productLine = productLine + `\n${questionTitle}: ${options.join(", ")}`;
                        });
                    }

                    row.push(productLine);
                    row.push(item.quantity);
                    return row;
                }).map(row => row.map(cell => String(cell))),
                columnWidths: [25, 480, 40], // Custom column widths for each column
                alignments: ['left', 'left', 'right'], // Alignment for each column (left, center, right)
            };

            drawTable(returnTableData, 40, doc.y, doc);
        }

        // Check if there is enough space for the next row
        if (doc.y + 70 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage(); // Add a new page if there isn't enough space
            pageNumber++; // Increment page number
            drawPageHeader(doc); // Add page header with page number   
            doc.moveDown();
        }

        // Table Header for the Second Table
        doc.moveDown().font('Helvetica-Bold').text('Billing Summary:', 300, doc.y + 40, { underline: true });
        doc.moveDown();
        const billingTotal = [];
        if (receiptData?.order?.sub_total > 0) {
            billingTotal.push(['Subtotal', formatCurrency(receiptData.order.sub_total)]);
        }
        if (receiptData?.order?.total_discount > 0) {
            billingTotal.push(['Discount', formatCurrency(receiptData.order.total_discount)]);
            billingTotal.push(['Total', formatCurrency(receiptData.order.total)]);
        }
        if (receiptData?.order?.tax_total > 0) {
            billingTotal.push([`${business.tax_title} (${business.vat}%)`, formatCurrency(receiptData.order.tax_total)]);
        }
        if (receiptData?.order?.grand_total) {
            billingTotal.push(['Grand Total', formatCurrency(receiptData.order.grand_total)]);
            if (receiptData?.order?.payments_against_total_balance === false) {
                billingTotal.push(['Paid', formatCurrency(receiptData.order.total_amount_received)]);
                billingTotal.push(['Balance', formatCurrency(receiptData.order.remaining_amount)]);

            }
        }

        if (receiptData?.order?.payments_against_total_balance === false && receiptData.order.remaining_amount > 0) {
            billingTotal.push(['Balance', formatCurrency(receiptData.order.remaining_amount)])
        }
        if (receiptData?.order?.payments_against_total_balance === true && receiptData.order.customer_meta_data) {
            billingTotal.push(['Previous Balance', formatCurrency(receiptData.order.customer_meta_data.previous_balance)]);
            billingTotal.push(['Due Balance', formatCurrency(receiptData.order.customer_meta_data.due_balance)]);

            billingTotal.push(['Paid', formatCurrency(receiptData.order.customer_meta_data.payment_received)]);
            billingTotal.push([`Cash: ${receiptData.order.customer_meta_data.cash}, Card: ${receiptData.order.customer_meta_data.credit_card}`, `Bank: ${receiptData.order.customer_meta_data.bank}`]);

            billingTotal.push(['New Balance', formatCurrency(receiptData.order.customer_meta_data.new_balance)]);

        }
        billingTotal.push(["Status", status === "" ? "Complete" : status]);

        // // Draw the second table
        const BillingData = {
            rows: billingTotal,
            columnWidths: [170, 100], // Custom column widths for each column
            alignments: ['left', 'right'], // Alignment for each column (left, center, right)
        };

        drawTable(BillingData, 300, doc.y, doc);
        // // Dynamically position the second table based on the current `doc.y`
        // createTable(doc, BillingData, 320, doc.y, [150, 100]);


        if (customer_note && customer_note.toString().trim().length == "") {
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

        if (customer_note && customer_note !== "") {
            doc.font('Helvetica')
                .fontSize(10)
                .text(stripHtml(customer_note), 50, doc.y + 20,);
        }

        doc.font('Helvetica')
            .fontSize(10)
            .text('\n\nThank you for your visit!\n See you soon!\n', 50, doc.y + 20, { align: 'center' });
        doc.end();

        // Write the receipt to a file (for testing purposes)
        const receiptFilePath = path.join(__dirname, outputPath);

        const { printerBrand, printerPort } = loadA4PrinterPortConfig();
        // const printerCommand = `print /D:"\\\\DESKTOP-1CBF04U\\Brother MFC-L8690CDW series" ${receiptFilePath}`;
        // const printerCommand = `print /D:"${printerPort}" "${receiptFilePath}"`;

        const copyCmd = `cmd /c copy /B "${receiptFilePath}" "${printerPort}"`;
        exec(copyCmd, { shell: true }, (err, stdout, stderr) => {
            if (err) {
                console.error("Error printing:", err);
            } else {
                console.log("Printed successfully");
            }
        });



    } catch (err) {
        console.error('Error generating PDF:', err);
    }
}

async function printBarcodes(zplCommand) {
    // 1) Use OS temp folder so the file is writable in production:
    const tmpDir = app.getPath('temp');

    const zplFilePath = path.join(tmpDir, 'label.zpl');
    // 2) Write your ZPL out:
    fs.writeFileSync(zplFilePath, zplCommand);

    // 3) Load the correct port:
    const { printerPort } = loadLabelPrinterPortConfig();
    console.log('Label printer port:', printerPort);

    // 4) Send it via Windows copy in a shell:
    const copyCmd = `cmd /c copy /B "${zplFilePath}" "${printerPort}"`;
    exec(copyCmd, { shell: true }, (err, stdout, stderr) => {
        if (err) {
            console.error('Error printing barcodes:', err, stderr);
        } else {
            console.log('Barcodes printed successfully:', stdout);
        }
    });
}

const formatCurrency = (amount) => {
    return amount?.toFixed(2);
};



// Function to open the Receipt printer configuration window
function openPrinterLabelConfigWindow() {
    if (!configLabelWindow) {
        configLabelWindow = new BrowserWindow({
            width: 355,
            height: 510,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        configLabelWindow.loadFile(path.join(__dirname, 'printer-label-config.html'));
        configLabelWindow.setMenu(null);
        // Dereference the window object once it is closed
        configLabelWindow.on('closed', () => {
            configLabelWindow = null;
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
                }
                ,
                {
                    label: 'Toggle Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.toggleDevTools();
                        }
                    }
                }
            ],
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Configure Receipt Printer',
                    click: openPrinterConfigWindow, // Use the global configWindow function
                },
                {
                    label: 'Configure A4 Size Printer',
                    click: openPrinterA4ConfigWindow, // Use the global configWindow function
                },
                {
                    label: 'Configure Label Printer',
                    click: openPrinterLabelConfigWindow, // Use the global configWindow function
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

function printDirectReceipt(finalBuffer) {

    // write into the OS temp directory
    const tmpDir = app.getPath('temp');
    const receiptFilePath = path.join(tmpDir, 'receipt.bin');
    fs.writeFileSync(receiptFilePath, finalBuffer);

    const { printerPort } = loadPrinterPortConfig();
    console.log('Printing to port:', printerPort);

    // Ensure you're running under CMD shell on Windows
    const copyCmd = `cmd /c copy /B "${receiptFilePath}" "${printerPort}"`;
    exec(copyCmd, { shell: true }, (err, stdout, stderr) => {
        if (err) {
            console.error("Error printing:", err, stderr);
        } else {
            console.log("Printed successfully:", stdout);
        }
    });
}

// Handle the event from the renderer (frontend)
ipcMain.on('send-receipt-data', async (event, receiptData) => {
    if (receiptData?.openCashDrawer === true && !receiptData?.order) {
        openCashDrawer();
    } else if (receiptData?.receiptFileBinary) {
        printDirectReceipt(receiptData?.receiptFileBinary);
    }
});


async function loadDymoFramework() {
    return new Promise((resolve, reject) => {
        if (dymoWindow) return resolve(dymoWindow);

        dymoWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, './dymo-preload.js') // expose dymoAPI if needed
            }
        });

        dymoWindow.loadFile(path.join(__dirname, './dymo-loader.html'));

        dymoWindow.webContents.on('did-finish-load', () => {
            console.log('DYMO framework loaded in hidden window');
            resolve(dymoWindow);
        });

        dymoWindow.on('closed', () => {
            dymoWindow = null;
        });
    });
}

// Utility to escape XML safely
function escapeLabelXml(xml) {
    return xml
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\${/g, '\\${')
        .replace(/\r?\n/g, '');
}

ipcMain.on('send-barcode-data', async (event, barcodeData) => {
console.log(barcodeData, "=====barcodeData");
    if (barcodeData.barcodefinal.printer === "dymo") {
        try {

            const obj = barcodeData.barcodefinal;
            const barcodeSize = barcodeData?.size || '32x57';
            const title = obj?.title ?? "";
            const storage = obj?.storage ?? "";
            const condition = obj?.conditionObject?.grade ?? "";
            let network = obj?.network ?? "";
            let color = obj?.misc_color ?? "";
            const processor = obj?.Processor ?? "";
            let ram = obj?.ram ?? "";
            let warranty = obj?.warranty?.length > 3 ? `${obj?.warranty} WARRANTY`.toUpperCase() : "";



            const price = obj?.price !== "" && obj?.price > 0 ? `£${obj?.price}` : "";
            const salePrice = obj?.salePrice;
            const regular_price = obj?.regular_price;
            const isSale = obj?.isSale;
            const off = isSale === true && (regular_price - salePrice) > 0 ? parseFloat(regular_price - salePrice).toFixed(2) : 0;
            const barcode = obj?.barcode ?? "";
            
            const specs = [condition === "New" ? "NEW" : condition === "A+" ? "Like New" : "GRADE " + condition, storage, network, ram, processor, color]
                .filter(v => v && v !== "").map(v => v.toUpperCase()); // removes empty, null, undefined, false

            const NumberOfPrints = parseInt(barcodeData?.prints) || 1;

            let printDesign = barcodeData?.barcodefinal?.design === "repair" ? "repair" : parseInt(barcodeData?.design);

            const win = await loadDymoFramework(); // ensure hidden window is loaded
            const tmpDir = app.getPath('temp');
            let currentDesign = path.join(__dirname, `Labeldesign1_1.dymo`);
       
            if (barcodeData.type == "lab") {
                 currentDesign = path.join(__dirname, `labitemdesign.dymo`);
            }else if (barcodeSize === "25x25") {
                if (printDesign === 1 || printDesign === 3) {
                    currentDesign = path.join(__dirname, `25_25_barcode.dymo`);
                } else {
                    currentDesign = path.join(__dirname, `25_25_qrcode.dymo`);
                }
            } else if (barcodeSize === "70x54") {
                if (printDesign === 1) {
                    if (isSale === true && off > 0) {
                        currentDesign = path.join(__dirname, `70_54_Labeldesign_sale.dymo`);
                    } else {
                        currentDesign = path.join(__dirname, `70_54_Labeldesign1_2_22.dymo`);
                    }
                }
                if (printDesign === 2) {
                    if (isSale === true && off > 0) {
                        printDesign = 7;
                        currentDesign = path.join(__dirname, `70_54_Labeldesign3.dymo`);

                    } else {
                        currentDesign = path.join(__dirname, `70_54_Labeldesign2.dymo`);
                    }

                }
                if (printDesign === 3) {
                    currentDesign = path.join(__dirname, `70_54_mukltipleBarcode.dymo`);
                }
                if (printDesign === 4) {
                    currentDesign = path.join(__dirname, `70_54_multipleQRCODE.dymo`);
                }

                if (printDesign === 'repair') {
                    currentDesign = path.join(__dirname, `LabeldesignRepair.dymo`);
                    //    currentDesign = path.join(__dirname, `70_54_LabeldesignRepair_2.dymo`);
                }
            } else {
                if (printDesign === 1) {
                    if (isSale === true && off > 0) {
                        currentDesign = path.join(__dirname, `Labeldesign_sale.dymo`);
                    } else {
                        // currentDesign = path.join(__dirname, `Labeldesign1_2_22.dymo`);
                        currentDesign = path.join(__dirname, `Labeldesign1_1.dymo`);

                    }
                }
                if (printDesign === 2) {
                    if (isSale === true && off > 0) {
                        printDesign = 7;
                        currentDesign = path.join(__dirname, `Labeldesign3.dymo`);

                    } else {
                        currentDesign = path.join(__dirname, `Labeldesign2.dymo`);
                    }

                }
                if (printDesign === 3) {
                    currentDesign = path.join(__dirname, `mukltipleBarcode.dymo`);
                }
                if (printDesign === 4) {
                    currentDesign = path.join(__dirname, `multipleQRCODE.dymo`);
                }

                if (printDesign === 'repair') {
                    currentDesign = path.join(__dirname, `LabeldesignRepair.dymo`);
                    // currentDesign = path.join(__dirname, `70_54_LabeldesignRepair_2.dymo`);
                }


            }


            if (!fs.existsSync(currentDesign)) {
                console.error('DYMO label file not found:', currentDesign);
                return;
            }


            function maskBarcodeText(barcode) {
                if (barcode.length <= 6) return barcode;
                return "*".repeat(barcode.length - 6) + barcode.slice(-6);
            }
            console.log(currentDesign, "====")
            const labelXmlRaw = fs.readFileSync(currentDesign, 'utf-8');
            const labelXml = escapeLabelXml(labelXmlRaw);

            // Get DYMO printers from hidden window
            const printers = await win.webContents.executeJavaScript(
                'dymo.label.framework.getPrinters()'
            );

            if (!printers || printers.length === 0) {
                console.error('No DYMO printers detected.');
                return;
            }

            const printerName =printers?.length > 0 ?  printers[0].name: null;
            console.log('Printing to DYMO printer:', printerName);

            if (barcodeData.type === "lab") {

                 const barcode1 = barcodeData.barcode;
                const title = barcodeData.title;

                await win.webContents.executeJavaScript(`
                    (function() {
                    const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                    label.setObjectText("BarcodeObject1", "${barcode1}");
                    label.setObjectText("TextObject12", "${title}");
                    label.print("${printerName}");
                    })();
                `);

            } else if (barcodeSize === "25x25") {
                if (printDesign === 1 || printDesign === 3) {
                    const barcode1 = barcode;
                    const price1 = price;

                    await win.webContents.executeJavaScript(`
                    (function() {
                    const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                    label.setObjectText("BarcodeObject0", "${barcode1}");
                    label.setObjectText("TextObject1", "${price1}");
                    label.print("${printerName}");
                    })();
                `);
                } else {
                    // --- Sanitize barcode for XML safety ---
                    const cleanXML = (str) =>
                        str
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/[`"']/g, '');

                    // --- Prepare QR values ---
                    const qr1 = barcode;

                    const price1 = price;


                    // --- Update XML directly ---
                    let updatedLabelXml = labelXml;

                    // Loop through each QR object and replace its QR content
                    for (let i = 0; i < 3; i++) {
                        const qrVal = [qr1][i];
                        updatedLabelXml = updatedLabelXml.replace(
                            new RegExp(
                                `(<ObjectInfo[^>]*name="QRCodeObject${i}"[\\s\\S]*?<DataString>)([\\s\\S]*?)(<\\/DataString>)`,
                                "m"
                            ),
                            `$1${qrVal}$3`
                        );
                    }

                    // --- Force DYMO to re-render QR Code object via patch ---
                    await win.webContents.executeJavaScript(`
(function() {
  console.log("🔧 Patching DYMO for QR update...");

  if (!dymo.label.framework.Label.prototype._forceQRCodeUpdate) {
    dymo.label.framework.Label.prototype._forceQRCodeUpdate = function(objectName, text) {
      const objElem = this._getObjectByNameElement(objectName);
      if (!objElem) return this;

      const dataElem = dymo.xml.getElement(objElem, "Data");
      if (dataElem) {
        const dataStringElem = dymo.xml.getElement(dataElem, "DataString");
        if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
      }

      const textHolder = dymo.xml.getElement(objElem, "TextDataHolder");
      if (textHolder) {
        const valElem = dymo.xml.getElement(textHolder, "Value");
        if (valElem) dymo.xml.setElementText(valElem, text);
      }

      // Remove cached QR image (forces regeneration)
      const renderCache = objElem.getElementsByTagName("RenderCache");
      if (renderCache.length > 0) objElem.removeChild(renderCache[0]);

      return this;
    };
  }

  console.log("QR update patch ready.");
})();
`);

                    // --- Now print with forced updates ---
                    await win.webContents.executeJavaScript(`
(function() {
  try {
    const label = dymo.label.framework.openLabelXml(\`${updatedLabelXml}\`);
    console.log("📦 Label opened, applying forced QR updates...");

    label._forceQRCodeUpdate("QRCodeObject2", "${qr1}");
   
    label.setObjectText("TextObject2", "${price1}");

    label.setObjectText("TextObject3", "${qr1?.length > 6 ? `**${qr1.slice(-6)}` : qr1}");

    label.print("${printerName}");
    console.log("Printed multiple updated QR codes:", "${qr1}");
  } catch (err) {
    console.error("Error printing label:", err);
  }
})();
`);
                }
            }

            // Print label safely in hidden window context
            else if (printDesign === 'repair') {
                const obj = barcodeData.barcodefinal;

                const business = obj.business;
                const customer = obj?.customer;
                let orderDate = barcodeData?.barcodefinal?.orderDate || "";

                // Assuming you may have multiple order items
                const items = Array.isArray(obj.orderItems) ? obj.orderItems : [obj.orderItem];

                for (const orderItem of items) {
                    const productName = orderItem?.product_name ?? "";
                    const businessName = business?.business_name ?? "";
                    const branchName = business?.branch_name ?? "";
                    const postCode = business?.post_code ?? "";
                    const imeiDescription = orderItem?.product_sn_imei_description ?? "";
                    const barcode = obj?.barcode ?? "";
                    const current_price = orderItem?.current_price !== "" && orderItem?.current_price > 0 ? `£${orderItem?.current_price}` : "";
                    const customFields = Array.isArray(orderItem?.custom_field_value)
                        ? orderItem.custom_field_value.map(f => f?.value?.length > 0 ? f?.value ?? "" : "")
                        : "";

                    // Clean barcode for XML safety
                    const safeBarcode = barcode
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/[`"']/g, '');
                    console.log(productName, customFields, businessName, branchName, orderDate, barcode, "====", safeBarcode)
                    await win.webContents.executeJavaScript(`
    (function() {
      try {
        const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);

        // Set text fields
        label.setObjectText("ItemNameVal", "${productName}");
        label.setObjectText("TEXT", "${customFields?.length > 0 ? customFields[0] : ""}");
        label.setObjectText("TEXT8", "${customFields?.length > 1 ? customFields[1] : ""}");
        label.setObjectText("TEXT9", "${customFields?.length > 2 ? customFields[2] : ""}");

        label.setObjectText("TextObject7", "");
        label.setObjectText("TextObject5", "${customer?.name || ""}");
        label.setObjectText("TextObject6", "${customer?.cell_no || ""}");
        
        label.setObjectText("TEXT_5", "${businessName} ${branchName}");
        label.setObjectText("TextObject1", "${orderDate}");
        label.setObjectText("TEXT4", "${barcode}");

        // --- Force QR code update ---
        if (!dymo.label.framework.Label.prototype._forceQRCodeUpdate) {
          dymo.label.framework.Label.prototype._forceQRCodeUpdate = function(objectName, text) {
            const objElem = this._getObjectByNameElement(objectName);
            if (!objElem) return this;

            const dataElem = dymo.xml.getElement(objElem, "Data");
            if (dataElem) {
              const dataStringElem = dymo.xml.getElement(dataElem, "DataString");
              if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
            }

            const textHolder = dymo.xml.getElement(objElem, "TextDataHolder");
            if (textHolder) {
              const valElem = dymo.xml.getElement(textHolder, "Value");
              if (valElem) dymo.xml.setElementText(valElem, text);
            }

            const renderCache = objElem.getElementsByTagName("RenderCache");
            if (renderCache.length > 0) objElem.removeChild(renderCache[0]);

            return this;
          };
        }

        label._forceQRCodeUpdate("QRCodeObject0", "${barcode}");

        // Print the label
        label.print("${printerName}");
        console.log("Printed label for ${productName} with QR:", "${barcode}");
      } catch (err) {
        console.error("Error printing label for ${productName}:", err);
      }
    })();
  `);
                }

            }
            else if (printDesign === 4) {
                // --- Sanitize barcode for XML safety ---
                const cleanXML = (str) =>
                    str
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/[`"']/g, '');

                // --- Prepare QR values ---
                const qr1 = barcode;
                const qr2 = barcode;
                const qr3 = barcode;
                const price1 = price;
                const price2 = price;
                const price3 = price;

                // --- Update XML directly ---
                let updatedLabelXml = labelXml;

                // Loop through each QR object and replace its QR content
                for (let i = 0; i < 3; i++) {
                    const qrVal = [qr1, qr2, qr3][i];
                    updatedLabelXml = updatedLabelXml.replace(
                        new RegExp(
                            `(<ObjectInfo[^>]*name="QRCodeObject${i}"[\\s\\S]*?<DataString>)([\\s\\S]*?)(<\\/DataString>)`,
                            "m"
                        ),
                        `$1${qrVal}$3`
                    );
                }

                // --- Force DYMO to re-render QR Code object via patch ---
                await win.webContents.executeJavaScript(`
(function() {
  console.log("🔧 Patching DYMO for QR update...");

  if (!dymo.label.framework.Label.prototype._forceQRCodeUpdate) {
    dymo.label.framework.Label.prototype._forceQRCodeUpdate = function(objectName, text) {
      const objElem = this._getObjectByNameElement(objectName);
      if (!objElem) return this;

      const dataElem = dymo.xml.getElement(objElem, "Data");
      if (dataElem) {
        const dataStringElem = dymo.xml.getElement(dataElem, "DataString");
        if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
      }

      const textHolder = dymo.xml.getElement(objElem, "TextDataHolder");
      if (textHolder) {
        const valElem = dymo.xml.getElement(textHolder, "Value");
        if (valElem) dymo.xml.setElementText(valElem, text);
      }

      // Remove cached QR image (forces regeneration)
      const renderCache = objElem.getElementsByTagName("RenderCache");
      if (renderCache.length > 0) objElem.removeChild(renderCache[0]);

      return this;
    };
  }

  console.log("QR update patch ready.");
})();
`);

                // --- Now print with forced updates ---
                await win.webContents.executeJavaScript(`
(function() {
  try {
    const label = dymo.label.framework.openLabelXml(\`${updatedLabelXml}\`);
    console.log("📦 Label opened, applying forced QR updates...");

    label._forceQRCodeUpdate("QRCodeObject0", "${qr1}");
    label._forceQRCodeUpdate("QRCodeObject1", "${qr2}");
    label._forceQRCodeUpdate("QRCodeObject2", "${qr3}");
        
    label.setObjectText("TextObject12", "${price1}");
    label.setObjectText("TextObject1", "${price2}");
    label.setObjectText("TextObject2", "${price3}");

    label.setObjectText("TextObject3", "${qr1?.length > 6 ? `**${qr1.slice(-6)}` : qr1}");
    label.setObjectText("TextObject4", "${qr2?.length > 6 ? `**${qr2.slice(-6)}` : qr2}");
    label.setObjectText("TextObject5", "${qr3?.length > 6 ? `**${qr3.slice(-6)}` : qr3}");

    label.print("${printerName}");
    console.log("Printed multiple updated QR codes:", "${qr1}", "${qr2}", "${qr3}");
  } catch (err) {
    console.error("Error printing label:", err);
  }
})();
`);


            } else if (printDesign === 3) {
                const barcode1 = barcode;
                const barcode2 = barcode;
                const price1 = price;
                const price2 = price;

                await win.webContents.executeJavaScript(`
                    (function() {
                    const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                    label.setObjectText("BarcodeObject0", "${barcode1}");
                    label.setObjectText("BarcodeObject1", "${barcode2}");
                    label.setObjectText("TextObject1", "${price1}");
                    label.setObjectText("TextObject12", "${price2}");
                    label.print("${printerName}");
                    })();
                `);
            }
            else if (printDesign === 7) {
                // Clean up barcode text for XML safety
                const safeBarcode = barcode
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/[`"']/g, '');
                const maskedBarcode = maskBarcodeText(barcode);
                // Replace QR code text directly in XML (updates both <DataString> and <Value>)
                let updatedLabelXml = labelXml
                    // Update DataString
                    .replace(
                        /(<QRCodeObject>[\s\S]*?<Name>QRCodeObject0<\/Name>[\s\S]*?<Data>[\s\S]*?<DataString>)([\s\S]*?)(<\/DataString>)/,
                        `$1${barcode}$3`
                    )
                    // Update TextDataHolder <Value>
                    .replace(
                        /(<QRCodeObject>[\s\S]*?<Name>QRCodeObject0<\/Name>[\s\S]*?<TextDataHolder>[\s\S]*?<Value>)([\s\S]*?)(<\/Value>)/,
                        `$1${barcode}$3`
                    );

                // Force a label refresh by giving it a unique temporary name
                updatedLabelXml = updatedLabelXml.replace(
                    /(<Name>QRCodeObject0<\/Name>)/,
                    `<Name>QRCodeObject0_${Date.now()}</Name>`
                );

                await win.webContents.executeJavaScript(`
                (function() {
                    if (!dymo.label.framework.Label.prototype._setQRCodeObjectText) {
                        console.log("Patching DYMO QRCodeObject support...");

                        dymo.label.framework.Label.prototype._setQRCodeObjectText = function(objectElem, text) {
                            var dataElem = dymo.xml.getElement(objectElem, "Data");
                            if (dataElem) {
                                var dataStringElem = dymo.xml.getElement(dataElem, "DataString");
                                if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
                            }

                            var holderElem = dymo.xml.getElement(objectElem, "TextDataHolder");
                            if (holderElem) {
                                var valueElem = dymo.xml.getElement(holderElem, "Value");
                                if (valueElem) dymo.xml.setElementText(valueElem, text);
                            }

                            return this;
                        };

                        const originalSetObjectText = dymo.label.framework.Label.prototype.setObjectText;
                        dymo.label.framework.Label.prototype.setObjectText = function(name, value) {
                            var objectElem = this._getObjectByNameElement(name);
                            if (!objectElem) return this;
                            if (objectElem.tagName === "QRCodeObject") {
                                return this._setQRCodeObjectText(objectElem, value);
                            }
                            return originalSetObjectText.call(this, name, value);
                        };

                        console.log("DYMO QRCodeObject patch applied successfully.");
                    }
                })();
                `);

                await win.webContents.executeJavaScript(`
                (function() {
                    try {
                        console.log("Opening updated DYMO label XML...");
                        const label = dymo.label.framework.openLabelXml(\`${updatedLabelXml}\`);

                        // Set normal text fields
                        label.setObjectText("ItemNameVal", "${title}");

                        label.setObjectText("TEXT_4", "${specs[0] || ''}");
                        label.setObjectText("TEXT", "${specs[1] || ''}");
                        label.setObjectText("TEXT_1", "${specs[2] || ''}");
                        label.setObjectText("TEXT_5", "${specs[3] || ''}");
                        label.setObjectText("TEXT__1", "${specs[4] || ''}");
                        label.setObjectText("TextObject11", "${warranty}");
                        label.setObjectText("TEXT_3", "£${salePrice}");
                        label.setObjectText("TextObject1", "£${off} OFF");
                        label.setObjectText("TextObject9", "£${regular_price}");
                        
                        label.setObjectText("Text_barcode", "${maskedBarcode}");
                        
                        // Print
                        label.print("${printerName}");
                        console.log("DYMO Label printed successfully with QR:", "${safeBarcode}");
                    } catch (err) {
                        console.error("Error printing DYMO label:", err);
                    }
                })();
                `);


            }
            else if (printDesign === 2) {
                // Clean up barcode text for XML safety
                const safeBarcode = barcode
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/[`"']/g, '');
                const maskedBarcode = maskBarcodeText(barcode);
                // Replace QR code text directly in XML (updates both <DataString> and <Value>)
                let updatedLabelXml = labelXml
                    // Update DataString
                    .replace(
                        /(<QRCodeObject>[\s\S]*?<Name>QRCodeObject0<\/Name>[\s\S]*?<Data>[\s\S]*?<DataString>)([\s\S]*?)(<\/DataString>)/,
                        `$1${barcode}$3`
                    )
                    // Update TextDataHolder <Value>
                    .replace(
                        /(<QRCodeObject>[\s\S]*?<Name>QRCodeObject0<\/Name>[\s\S]*?<TextDataHolder>[\s\S]*?<Value>)([\s\S]*?)(<\/Value>)/,
                        `$1${barcode}$3`
                    );

                // Force a label refresh by giving it a unique temporary name
                updatedLabelXml = updatedLabelXml.replace(
                    /(<Name>QRCodeObject0<\/Name>)/,
                    `<Name>QRCodeObject0_${Date.now()}</Name>`
                );

                await win.webContents.executeJavaScript(`
                (function() {
                    if (!dymo.label.framework.Label.prototype._setQRCodeObjectText) {
                        console.log("Patching DYMO QRCodeObject support...");

                        dymo.label.framework.Label.prototype._setQRCodeObjectText = function(objectElem, text) {
                            var dataElem = dymo.xml.getElement(objectElem, "Data");
                            if (dataElem) {
                                var dataStringElem = dymo.xml.getElement(dataElem, "DataString");
                                if (dataStringElem) dymo.xml.setElementText(dataStringElem, text);
                            }

                            var holderElem = dymo.xml.getElement(objectElem, "TextDataHolder");
                            if (holderElem) {
                                var valueElem = dymo.xml.getElement(holderElem, "Value");
                                if (valueElem) dymo.xml.setElementText(valueElem, text);
                            }

                            return this;
                        };

                        const originalSetObjectText = dymo.label.framework.Label.prototype.setObjectText;
                        dymo.label.framework.Label.prototype.setObjectText = function(name, value) {
                            var objectElem = this._getObjectByNameElement(name);
                            if (!objectElem) return this;
                            if (objectElem.tagName === "QRCodeObject") {
                                return this._setQRCodeObjectText(objectElem, value);
                            }
                            return originalSetObjectText.call(this, name, value);
                        };

                        console.log("DYMO QRCodeObject patch applied successfully.");
                    }
                })();
                `);

                await win.webContents.executeJavaScript(`
                (function() {
                    try {
                        console.log("Opening updated DYMO label XML...");
                        const label = dymo.label.framework.openLabelXml(\`${updatedLabelXml}\`);

                        // Set normal text fields
                        label.setObjectText("ItemNameVal", "${title}");

                        label.setObjectText("TEXT_4", "${specs[0] || ''}");
                        label.setObjectText("TEXT", "${specs[1] || ''}");
                        label.setObjectText("TEXT_1", "${specs[2] || ''}");
                        label.setObjectText("TEXT_5", "${specs[3] || ''}");
                        label.setObjectText("TEXT__1", "${specs[4] || ''}");

                        label.setObjectText("TextObject11", "${warranty}");

                        label.setObjectText("TEXT_3", "${price}");
                        label.setObjectText("Text_barcode", "${maskedBarcode}");
                        
                        // Print
                        label.print("${printerName}");
                        console.log("DYMO Label printed successfully with QR:", "${safeBarcode}");
                    } catch (err) {
                        console.error("Error printing DYMO label:", err);
                    }
                })();
                `);


            }
            else if (printDesign === 1) {
                const maskedBarcode = maskBarcodeText(barcode);
                if (isSale === true && off > 0) {
                    await win.webContents.executeJavaScript(`
            (function() {
                const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                label.setObjectText("ItemNameVal", "${title}");

                label.setObjectText("TEXT_4", "${specs[0] || ''}");
                label.setObjectText("TEXT", "${specs[1] || ''}"); 
                label.setObjectText("TEXT_1", "${specs[2] || ''}");
                label.setObjectText("TEXT_5", "${specs[3] || ''}");

                label.setObjectText("TextObject11", "${warranty}");        

                label.setObjectText("TEXT_3", "£${salePrice}");
                label.setObjectText("TEXT__1", "£${off} OFF");
                label.setObjectText("Text_was", "£${regular_price}");
                
                label.setObjectText("BARCODE", "${barcode}");
                
                label.setObjectText("TextObject1", "${maskedBarcode}");

               label.print("${printerName}");
            })();
        `);
                } else {
                    console.log(barcode, "barcode====", currentDesign)

                    await win.webContents.executeJavaScript(`
            (function() {
                const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                label.setObjectText("ItemNameVal", "${title}");

                label.setObjectText("TEXT_4", "${specs[0] || ''}"); 
                label.setObjectText("TEXT", "${specs[1] || ''}"); 
                label.setObjectText("TEXT_1", "${specs[2] || ''}");
                label.setObjectText("TEXT_5", "${specs[3] || ''}");
                label.setObjectText("TEXT__1", "${specs[4] || ''}");
                label.setObjectText("TextObject11", "${warranty}");        
                label.setObjectText("TEXT_3", "${price}");
                label.setObjectText("BARCODE", "${barcode}");
                
                label.setObjectText("TextObject1", "${maskedBarcode}");

               label.print("${printerName}");
            })();
        `);
                }

            } else {
                const maskedBarcode = maskBarcodeText(barcode);
                if (isSale === true && off > 0) {
                    await win.webContents.executeJavaScript(`
            (function() {
                const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                label.setObjectText("ItemNameVal", "${title}");

                label.setObjectText("TEXT_4", "${specs[0] || ''}");
                label.setObjectText("TEXT", "${specs[1] || ''}"); 
                label.setObjectText("TEXT_1", "${specs[2] || ''}");
                label.setObjectText("TEXT_5", "${specs[3] || ''}");
                label.setObjectText("TextObject11", "${warranty}");        
                label.setObjectText("TEXT_3", "£${salePrice}");
                label.setObjectText("TEXT__1", "£${off} OFF");
                label.setObjectText("Text_was", "£${regular_price}");
                
                label.setObjectText("BARCODE", "${barcode}");
                
                label.setObjectText("TextObject1", "${maskedBarcode}");
               const printParamsXml = dymo.label.framework.createLabelWriterPrintParamsXml({
            printQuality: dymo.label.framework.PrintQuality.BarcodeAndGraphics,
            darkness: -1 
        });
               label.print("${printerName}", printParamsXml);
            })();
        `);
                } else {
                    await win.webContents.executeJavaScript(`
            (function() {
                const label = dymo.label.framework.openLabelXml(\`${labelXml}\`);
                label.setObjectText("ItemNameVal", "${title}");

                label.setObjectText("TEXT_4", "${specs[0] || ''}");
                label.setObjectText("TEXT", "${specs[1] || ''}"); 
                label.setObjectText("TEXT_1", "${specs[2] || ''}");
                label.setObjectText("TEXT_5", "${specs[3] || ''}");
                label.setObjectText("TextObject11", "${warranty}");
                label.setObjectText("TEXT_3", "${price}");
                label.setObjectText("TEXT__1", "${processor}");
                label.setObjectText("BARCODE", "${barcode}");
                
                label.setObjectText("TextObject1", "${maskedBarcode}");

               label.print("${printerName}");
            })();
        `);

                }
            }

            console.log('DYMO label printed successfully!');
        } catch (err) {
            console.error('Error printing DYMO label:', err);
        }
    } else {
        printBarcodes(barcodeData?.barcodefinal);
    }

});




// IPC handler to save printer configuration from renderer process
ipcMain.on('save-printer-config', (event, { printerName, printerPort, password }) => {
    if (store) {

        if (printerName !== "") {
            store.set('printerName', printerName);
        }

        if (printerPort !== "") {
            store.set('printerPort', printerPort);
        }

        if (password !== "") {
            store.set('password', password); // Save the password as well
        }

        dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
            type: 'info',
            title: 'Configuration Saved',
            message: `Printer Name: ${printerName}\nPrinter Port: ${printerPort}\nPassword: Saved`
        }).then(() => {
            if (configWindow) {
                configWindow.close();
            }
        });
    } else {
        console.error('Store is not initialized');
    }
});

// IPC handler to save printer configuration from renderer process
ipcMain.on('save-a4-printer-config', (event, { printerName, printerPort }) => {
    if (store) {
        store.set('a4PrinterName', printerName);
        store.set('a4PrinterPort', printerPort);

        dialog.showMessageBox({
            type: 'info',
            title: 'Configuration Saved',
            message: `A4 Printer Name: ${printerName}\nPrinter Port: ${printerPort}\n: Saved`
        }).then(() => {
            // Close the configuration window after saving
            if (configA4Window) {
                configA4Window.close();
            }
        });
    } else {
        console.error('Store is not initialized');
    }
});

// IPC handler to save printer configuration from renderer process
ipcMain.on('save-label-printer-config', (event, { printerName, printerPort }) => {

    if (store) {
        store.set('labelPrinterName', printerName);
        store.set('labelPrinterPort', printerPort);

        dialog.showMessageBox({
            type: 'info',
            title: 'Configuration Saved',
            message: `Label Printer Name: ${printerName}\nPrinter Port: ${printerPort}\n: Saved`
        }).then(() => {
            // Close the configuration window after saving
            if (configLabelWindow) {
                configLabelWindow.close();
            }
        });
    } else {
        console.error('Store is not initialized');
    }
});

// IPC listener to handle password submission
ipcMain.on('submit-password', (event, enteredPassword) => {
    const { password: savedPassword } = loadPrinterPortConfig();

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

app.commandLine.appendSwitch('disable-brotli');

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
