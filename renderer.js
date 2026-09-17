// renderer.js
const { ipcRenderer } = require('electron');

async function printReceipt() {
    function generateReceiptHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        width: 72mm;
        margin: 0;
        padding: 5px;
        font-family: monospace;
        font-size: 12px;
        color: #000;
      }

      .center {
        text-align: center;
      }

      .bold {
        font-weight: bold;
      }

      .row {
        display: flex;
        justify-content: space-between;
      }

      hr {
        border: none;
        border-top: 1px dashed #000;
        margin: 5px 0;
      }

      .title {
        font-size: 16px;
        font-weight: bold;
      }
    </style>
  </head>

  <body>
    <div class="center">
      <div class="title">Doctor Gadgets</div>
      <div>London</div>
      <div>Tel: 0123456789</div>
    </div>

    <hr>

    <div class="row">
      <span>Item 1</span>
      <span>£10.00</span>
    </div>

    <div class="row">
      <span>Item 2</span>
      <span>£5.00</span>
    </div>

    <hr>

    <div class="row bold">
      <span>Total</span>
      <span>£15.00</span>
    </div>

    <hr>

    <div class="center">
      Thank you for your business!
    </div>
  </body>
  </html>
  `;
}
  const html = generateReceiptHTML();

  try {
    await ipcRenderer.invoke('print-receipt', html);
    console.log("Printed successfully");
  } catch (err) {
    console.error("Print failed:", err);
  }
}
