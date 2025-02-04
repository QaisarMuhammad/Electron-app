

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
        doc.moveDown(1);
        doc.fontSize(18).fillColor('black');
        doc.font('Helvetica-Bold').text(business.business_name, 40, 20, { underline: true });
        doc.font('Helvetica').fontSize(12).text(business.business_address, 40, 40);
        doc.text(business.post_code, 40);
        doc.text(`Tel: ${business.business_phone_no}`, 40);
        doc.text(`WhatsApp: ${business.business_whatsapp_no}`, 40);

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
                    let productLine = `${item.Product?.product_no ? item.Product?.product_no : item?.product_no}-${item?.Product?.name ? item.Product.name : item?.product_name}`;

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
                    let productLine = `${item.Product?.product_no ? item.Product?.product_no : item?.product_no}-${item?.Product?.name ? item.Product.name : item?.product_name}`;

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
                    let productLine = `${item.Product?.product_no ? item.Product?.product_no : item?.product_no}-${item?.Product?.name ? item.Product.name : item?.product_name}`;

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