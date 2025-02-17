
const path = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const os = require('os');
// Attach the virtual font system
const { exec } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');

let configWindow; // Declare a global variable to store the reference to the configuration window
let configLabelWindow;
let configA4Window;
let passwordWindow;
let resetPasswordWindow;
// Initialize default URL for app window
const defaultURL = 'https://dev.societyfiles.com/vendor/point-of-sale?active=buy';
let store; // Electron store for persisting configuration
const receiptFilePath = path.join(__dirname, 'receipt_new.txt');

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
        const orderItems = receiptData.order?.Cart_items?.length > 0 ? receiptData?.order?.Cart_items : receiptData?.order?.Sub_orders[0].Order_items?.length > 0 ? receiptData?.order.Sub_orders[0].Order_items : [];

        const salesOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === false && item?.is_return === false) : [];
        const replacementOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === true) : [];
        const returnOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_return === true) : [];

        const updatedOrderType = salesOrderItems?.filter(i => i.is_active_for === 3)?.length ? "Repair" : "Sale";

        // From and To Information
        // Add centered "From" information at the top of the page
       if(!sell_print_data?.show_business_info){
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
        doc.text(`Date: ${new Date(receiptData.order.created_at).toLocaleString()}`, 370, 120);
        doc.text(`Terminal: ${user.first_name} ${user.last_name}`, 370);

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
            console.log(status, "====status");
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


        // Finalize the PDF
        doc.end();
     


        // Write the receipt to a file (for testing purposes)
        const receiptFilePath = path.join(__dirname, outputPath);
        //  fs.writeFileSync(receiptFilePath, finalBuffer);


        const { printerBrand, printerPort } = loadA4PrinterPortConfig();
        // In a real application, send finalBuffer to the printer.
        // Sending the print command using the Windows command line to the specific printer.
        // const printerCommand = `print /D:"\\\\DESKTOP-1CBF04U\\Brother MFC-L8690CDW series" ${receiptFilePath}`;
        const printerCommand = `print /D:"${printerPort}" "${receiptFilePath}"`;

       
        exec(printerCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error printing the receipt:', error);
            } else {
                console.log('Print command executed successfully:', stdout);
                // Open the cash drawer if password matches
            }
        });

    } catch (err) {
        console.error('Error generating PDF:', err);
    }
}

function generateAndPrintReceipt(receiptData) {
    // Helper functions for formatting text
    const padRight = (text, width) => text.padEnd(width);
    const padLeft = (text, width) => text.padStart(width);

    const formatCurrency = (amount) => {

        return amount?.toFixed(2);
    };

    console.log(receiptData, "=====");
    const isDuplicate = receiptData.isDuplicate || false;
    const status = receiptData.order?.cart_status === 3 ? "Pending" : receiptData.order?.cart_status === 4 ? "In-Progress" : '';
    // Extract business, customer, and user details from receiptData
    const business = receiptData.order.Business || receiptData.order.business;
    const customer = receiptData.order.Customer || receiptData.order.customer;

    const userAssignment = receiptData?.order?.User_customer_assignment;
    const assignedUser = userAssignment?.User || userAssignment;
    
    const servedBy = assignedUser !== null
    ? `${assignedUser.first_name || ""} ${assignedUser.last_name || ""}`.trim() 
    : "";
    

    let customer_note = receiptData?.order?.customer_note;
    const user = receiptData.order.User || receiptData.order.user;
    const { sell_print_data, repair_print_data } = receiptData.businessData;
    const orderItems = receiptData?.order?.Sub_orders[0].Order_items  ? receiptData?.order?.Sub_orders[0].Order_items : receiptData?.order?.Sub_orders[0].Order_items?.length > 0 ? receiptData?.order.Sub_orders[0].Order_items : [];
    
   
   
        const salesOrderItems =  status != "" && orderItems?.sale_items ? orderItems?.sale_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === false && item?.is_return === false && item?.is_trade_in === false) : [];
        const replacementOrderItems = status != "" &&  orderItems?.replacement_items ? orderItems?.replacement_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === true) : [];
        const returnOrderItems = status != "" &&  orderItems?.return_items ? orderItems?.return_items :orderItems?.length > 0 ? orderItems?.filter(item => item?.is_return === true) : [];
        const tradeinOrderItems = status != "" && orderItems?.trade_items ? orderItems?.trade_items : orderItems?.length > 0 ? orderItems?.filter(item => item?.is_trade_in === true) : [];   
       console.log("salesOrderItems", salesOrderItems)
       console.log("replacementOrderItems", replacementOrderItems)
       console.log("returnOrderItems", returnOrderItems)
       console.log("tradeinOrderItems", tradeinOrderItems)
      

  
    const updatedOrderType = salesOrderItems?.filter(i => i.is_active_for === 3)?.length ? "Repair" : "Sale";

    // Initialize the receipt buffer
    const receiptBuffer = [];
    if (!isDuplicate) {
        // OPEN CASH DRAWER
        receiptBuffer.push(Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFF]));
    }
    receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer

    receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19])); // Select Code Page 858 (CP858)

    if(!sell_print_data?.show_business_info){
    receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x01]));  // Center align
    receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
    receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x01]));
    receiptBuffer.push(Buffer.from(`${business.business_name}`));
    receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x00]));
    receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold ON
    }
    receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Re-initialize printer
    receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
    if (isDuplicate) {
        receiptBuffer.push(Buffer.from('\n\n********* DUPLICATE RECEIPT *********'));
    }
    
    if(!sell_print_data?.show_business_info){
        receiptBuffer.push(Buffer.from(`\n\n${business.business_address}\n`));
        receiptBuffer.push(Buffer.from(` ${business?.post_code}\n`));
        const sanitizedPhone = business?.business_phone_no
            .replace(/[^0-9]/g, '') // Keep only numbers
            .replace(/^44/, '0');    // Replace '+44' or '44' with '0'

            const sanitizedWhatsapp = business?.business_whatsapp_no
            .replace(/[^0-9]/g, '')  // Keep only numbers
            .replace(/^44/, '0');     // Replace '+44' or '44' with '0'

        receiptBuffer.push(Buffer.from(`Tel: ${sanitizedPhone}\n`));
        receiptBuffer.push(Buffer.from(`WhatsApp: ${sanitizedWhatsapp}\n\n`));
    }
    
  
    receiptBuffer.push(Buffer.from(`Date: ${new Date(receiptData.order.created_at).toLocaleString()}\n`));
    receiptBuffer.push(Buffer.from(`Terminal: ${user.first_name} ${user.last_name}\n`));
    receiptBuffer.push(Buffer.from(`Order Type: ${updatedOrderType}\n`));
    receiptBuffer.push(Buffer.from(`Receipt #: ${receiptData.order.cart_no}\n\n`));


    if (customer) {
        receiptBuffer.push(Buffer.from('\n'));
        receiptBuffer.push(Buffer.from(`Name: ${customer.full_name}\n`));
        if (customer.cell_no) { receiptBuffer.push(Buffer.from(`Mobile: ${customer.cell_no}\n`)); }
        if (customer.email !== "") { receiptBuffer.push(Buffer.from(`Email: ${customer.email}\n`)); }
        if (customer.address !== "") { receiptBuffer.push(Buffer.from(`Address: ${customer.address}\n`)); }
        if(servedBy !== "") {  receiptBuffer.push(Buffer.from(`Served By: ${servedBy}\n`));  }
    }
    // // // Add Header for Sales Items
    if (salesOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from('\n'));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from(`Sale (${salesOrderItems?.length || 0})`));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold ON
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }

    // Process Sales Items
    if (salesOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer once
    
        salesOrderItems.forEach((item, i) => {
            receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align for product names
            let productName = item?.Product?.name || item?.product_name || "Unknown Product";
            
            if (item?.current_price > 0) {
                receiptBuffer.push(Buffer.from(` ${productName} - (${item.quantity}x`));
                receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19, 0x9C])); // Currency symbol
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price)}=`));
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price * item.quantity)})\n`));
            } else {
                receiptBuffer.push(Buffer.from(` ${productName}\n`));
            }
    
            if (item.item_discount != null && item.item_discount > 0) {
                receiptBuffer.push(Buffer.from(` Discount: ${formatCurrency(item.item_discount)}\n`));
            }
    
            if (item.product_sn_imei_no && item.product_sn_imei_no.trim()) {
                const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }
    
            if (item.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }
    
            if (item.repair_work_data?.customer_field_data?.length > 0) {
                item.repair_work_data.customer_field_data.forEach(field => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }
    
            if (item.Order_question_options?.length > 0) {
                const groupedOptions = item.Order_question_options.reduce((acc, option) => {
                    const { question_title, option_label } = option;
                    if (question_title && option_label) {
                        acc[question_title] = acc[question_title] || [];
                        acc[question_title].push(option_label);
                    }
                    return acc;
                }, {});
    
                Object.entries(groupedOptions).forEach(([questionTitle, options]) => {
                    receiptBuffer.push(Buffer.from(`${questionTitle}: ${options.join(", ")}\n`));
                });
            }
    
            if (item.current_price > 0) {
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x02]));  // Right align for price only
                const priceLine = formatCurrency(item?.after_discount_price || item?.after_discount_item_total_price);
                receiptBuffer.push(Buffer.from(`${priceLine}\n`));
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align after price
            }
        });
    } 
    


    // // Add Header for Sales Items
    if (returnOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer
        receiptBuffer.push(Buffer.from('\n'));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // left align
        receiptBuffer.push(Buffer.from(` RETURNS (${returnOrderItems?.length || 0})`));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold ON
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }
     // Process Return Items
     if (returnOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Initialize printer once
    
        returnOrderItems.forEach((item, i) => {
            receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align for product names
            let productName = item?.Product?.name || item?.product_name || "Unknown Product";
            
            if (item?.current_price !== 0) {
                receiptBuffer.push(Buffer.from(` ${productName} - (${item.quantity}x`));
                receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19, 0x9C])); // Currency symbol
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price)}=`));
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price * item.quantity)})\n`));
            } else {
                receiptBuffer.push(Buffer.from(` ${item.quantity} x ${productName}\n`));
            }
    
            if (item.item_discount != null && item.item_discount > 0) {
                receiptBuffer.push(Buffer.from(` Discount: ${formatCurrency(item.item_discount)}\n`));
            }
    
            if (item.product_sn_imei_no && item.product_sn_imei_no.trim()) {
                const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }
    
            if (item.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }
    
            if (item.repair_work_data?.customer_field_data?.length > 0) {
                item.repair_work_data.customer_field_data.forEach(field => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }
    
            if (item.Order_question_options?.length > 0) {
                const groupedOptions = item.Order_question_options.reduce((acc, option) => {
                    const { question_title, option_label } = option;
                    if (question_title && option_label) {
                        acc[question_title] = acc[question_title] || [];
                        acc[question_title].push(option_label);
                    }
                    return acc;
                }, {});
    
                Object.entries(groupedOptions).forEach(([questionTitle, options]) => {
                    receiptBuffer.push(Buffer.from(`${questionTitle}: ${options.join(", ")}\n`));
                });
            }
    
            if (item.current_price !== 0) {
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x02]));  // Right align for price only
                const priceLine = formatCurrency(item?.after_discount_price || item?.after_discount_item_total_price);
                receiptBuffer.push(Buffer.from(`${priceLine}\n`));
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align after price
            }
        });
    }

    // Add Header for Replacement Items if applicable
    if (replacementOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from('\n'));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // left align
        receiptBuffer.push(Buffer.from(` REPLACEMENT (${replacementOrderItems?.length || 0})`));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold OFF
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }

    // Process Replacement Items
    if (replacementOrderItems?.length > 0) {
        replacementOrderItems.forEach((item, i) => {
            receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align for product names
            let productName = item?.Product?.name || item?.product_name || "Unknown Product";
            
            if (item?.current_price > 0) {
                receiptBuffer.push(Buffer.from(` ${item.quantity} x ${productName} \n`));
            } else {
                receiptBuffer.push(Buffer.from(` ${item.quantity} x ${productName}\n`));
            }
    
        
    
            if (item.product_sn_imei_no && item.product_sn_imei_no.trim()) {
                const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }
    
            if (item.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }
    
            if (item.repair_work_data?.customer_field_data?.length > 0) {
                item.repair_work_data.customer_field_data.forEach(field => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }
    
            if (item.Order_question_options?.length > 0) {
                const groupedOptions = item.Order_question_options.reduce((acc, option) => {
                    const { question_title, option_label } = option;
                    if (question_title && option_label) {
                        acc[question_title] = acc[question_title] || [];
                        acc[question_title].push(option_label);
                    }
                    return acc;
                }, {});
    
                Object.entries(groupedOptions).forEach(([questionTitle, options]) => {
                    receiptBuffer.push(Buffer.from(`${questionTitle}: ${options.join(", ")}\n`));
                });
            }
        });
    }

    // Trade in 
     // Add Header for Replacement Items if applicable
     if (tradeinOrderItems?.length > 0) {
        receiptBuffer.push(Buffer.from('\n'));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // left align
        receiptBuffer.push(Buffer.from(` Trade-in (${tradeinOrderItems?.length || 0})`));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold OFF
        receiptBuffer.push(Buffer.from('\n----------------------------------------\n'));
    }

    // Process Replacement Items
    if (tradeinOrderItems?.length > 0) {
        tradeinOrderItems.forEach((item, i) => {
            receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align for product names
            let productName = item?.Product?.name || item?.product_name || "Unknown Product";
            
            if (item?.current_price != 0) {
                receiptBuffer.push(Buffer.from(` ${productName} - (${item.quantity}x`));
                receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19, 0x9C])); // Currency symbol
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price)}=`));
                receiptBuffer.push(Buffer.from(`${formatCurrency(item.current_price * item.quantity)})\n`));
            } else {
                receiptBuffer.push(Buffer.from(` ${productName}\n`));
            }
    
            if (item.item_discount != null && item.item_discount > 0) {
                receiptBuffer.push(Buffer.from(` Discount: ${formatCurrency(item.item_discount)}\n`));
            }
    
            if (item.product_sn_imei_no && item.product_sn_imei_no.trim()) {
                const imeiType = item.product_sn_imei_type === 1 ? " IMEI" : " Serial No";
                receiptBuffer.push(Buffer.from(`${imeiType}: ${item.product_sn_imei_no}\n`));
            }
    
            if (item.product_sn_imei_description) {
                receiptBuffer.push(Buffer.from(` ${item.product_sn_imei_description}\n`));
            }
    
            if (item.repair_work_data?.customer_field_data?.length > 0) {
                item.repair_work_data.customer_field_data.forEach(field => {
                    if (field.value) {
                        receiptBuffer.push(Buffer.from(`${field.field_label}: ${field.value}\n`));
                    }
                });
            }
    
            if (item.Order_question_options?.length > 0) {
                const groupedOptions = item.Order_question_options.reduce((acc, option) => {
                    const { question_title, option_label } = option;
                    if (question_title && option_label) {
                        acc[question_title] = acc[question_title] || [];
                        acc[question_title].push(option_label);
                    }
                    return acc;
                }, {});
    
                Object.entries(groupedOptions).forEach(([questionTitle, options]) => {
                    receiptBuffer.push(Buffer.from(`${questionTitle}: ${options.join(", ")}\n`));
                });
            }
    
            if (item.current_price !== 0) {
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x02]));  // Right align for price only
                const priceLine = formatCurrency(item?.after_discount_price || item?.after_discount_item_total_price);
                receiptBuffer.push(Buffer.from(`${priceLine}\n`));
                receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x00]));  // Reset to left align after price
            }
        });
    }
   
    receiptBuffer.push(Buffer.from([0x1B, 0x40]));  // Re-initialize printer
    receiptBuffer.push(Buffer.from([0x1B, 0x61]));  // Left align
    // Add totals and final amounts
    receiptBuffer.push(Buffer.from('----------------------------------------\n\n'));
    if (receiptData?.order?.sub_total > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from('Subtotal:           '),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.sub_total)}\n`)
            ])
        );
    }

    if (receiptData?.order?.total_discount > 0) {
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

    if (receiptData?.order?.tax_total > 0) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`${business.tax_title} (${business.vat}%):          `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.tax_total)}\n`)
            ])
        );

    }
    if (receiptData?.order?.grand_total) {
        // Make 'Grand Total' bold and bigger size
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold ON
        receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x01]));
        receiptBuffer.push(Buffer.from(`Grand Total:        `))
        receiptBuffer.push(Buffer.from([0x1B, 0x74, 0x19, 0x9C]));
        receiptBuffer.push(Buffer.from(`${formatCurrency(receiptData.order.grand_total)}\n\n`));
        // Reset to normal font and weight
        receiptBuffer.push(Buffer.from([0x1D, 0x21, 0x00]));
        receiptBuffer.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold OFF
        if (receiptData?.order?.payments_against_total_balance === false) {
            receiptBuffer.push(
                Buffer.concat([
                    Buffer.from(`Paid:               `),
                    Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                    Buffer.from(`${formatCurrency(receiptData.order.total_amount_received)}\n`)
                ])
            );

            receiptBuffer.push(Buffer.from(`Cash: ${receiptData.order.cash}, Card: ${receiptData.order.credit_card}, Bank: ${receiptData.order.bank}\n`));
        }
    }

    if (receiptData?.order?.payments_against_total_balance === false && receiptData.order.remaining_amount > 0) {
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
            Buffer.from(`Status:             `),
            Buffer.from(`${status === "" ? "Complete" : status}\n\n`)
        ])
    );

    if (receiptData?.order?.payments_against_total_balance === true && receiptData.order.customer_meta_data) {
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`Previous Balance:    `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.customer_meta_data.previous_balance)}\n`)
            ])
        );
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`Due Balance:         `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.customer_meta_data.due_balance)}\n`)
            ])
        );
        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`Received:            `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.customer_meta_data.payment_received)}\n`)
            ])
        );

        if (receiptData.order.customer_meta_data.payment_received !== 0) {
            receiptBuffer.push(Buffer.from(`Cash: ${receiptData.order.customer_meta_data.cash}, Card: ${receiptData.order.customer_meta_data.credit_card}, Bank: ${receiptData.order.customer_meta_data.bank}\n`));
        }

        receiptBuffer.push(
            Buffer.concat([
                Buffer.from(`New Balance:         `),
                Buffer.from([0x1B, 0x74, 0x19, 0x9C]),
                Buffer.from(`${formatCurrency(receiptData.order.customer_meta_data.new_balance)}\n`)
            ])
        );
    }

    if (receiptData?.order?.payments_against_total_balance === false && receiptData?.order?.Payment_logs?.length > 1) {

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

    if (tradeinOrderItems?.length > 0) { 
        receiptBuffer.push(Buffer.from(`\nI "${customer?.full_name ? customer?.full_name :""}" hereby confirm that the above-mentioned items have been sold to at the agreed price. ${business.business_name} has the rights to deal with these items in the future.\n`))
    
         receiptBuffer.push(Buffer.from(`\n\n\nSignature:_______________ \n\n\n`));
    }


    if (customer_note && customer_note === "") {
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
        receiptBuffer.push(Buffer.from(stripHtml(customer_note)));
    }
    // Initialize Printer
    receiptBuffer.push(Buffer.from([0x1B, 0x40])); // Reset printer
    receiptBuffer.push(Buffer.from([0x1B, 0x61, 0x01]));
    receiptBuffer.push(Buffer.from(`\nThank you for your visit!\n`))
    receiptBuffer.push(Buffer.from(`See you soon!\n\n`))

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
                },
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


// Handle the event from the renderer (frontend)
ipcMain.on('send-receipt-data', async (event, receiptData) => {
    // genreceiptPrint();
    
    if(receiptData?.openCashDrawer){
        openCashDrawer();
    }else{
        const orderItems = receiptData.order?.Cart_items?.length > 0 ? receiptData?.order?.Cart_items : receiptData?.order?.Sub_orders[0].Order_items?.length > 0 ? receiptData?.order.Sub_orders[0].Order_items : [];
        const { sell_print_data, repair_print_data } = receiptData.businessData;
        const salesOrderItems = orderItems?.length > 0 ? orderItems?.filter(item => item?.is_replacement === false) : [];
        const updatedOrderType = salesOrderItems?.filter(i => i.is_active_for === 3)?.length ? "Repair" : "Sale";
        if (updatedOrderType === "Sale") {
            if (sell_print_data.template_print == 1) {
                generateAndPrintReceipt(receiptData);
            } else {
                generateA4Receipt(receiptData);
            }
        } else if (updatedOrderType === "Repair") {
            if (repair_print_data.template_print == 1) {
                generateAndPrintReceipt(receiptData);
            } else {
                generateA4Receipt(receiptData);
            }
        }
    }
    
   
});

// IPC handler to save printer configuration from renderer process
ipcMain.on('save-printer-config', (event, { printerName, printerPort, password }) => {
    if (store) {
        store.set('printerName', printerName);
        store.set('printerPort', printerPort);
        store.set('password', password); // Save the password as well

        dialog.showMessageBox({
            type: 'info',
            title: 'Configuration Saved',
            message: `Printer Name: ${printerName}\nPrinter Port: ${printerPort}\nPassword: Saved`
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
