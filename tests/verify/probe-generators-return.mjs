import fs from 'node:fs';
import path from 'node:path';
import { WEB, babelParse, freeNamesOf } from './_kit.mjs';
import { createRequire } from 'node:module';
const traverse = createRequire(path.join(WEB, 'package.json'))('@babel/traverse').default;
const code = fs.readFileSync(path.join(WEB, 'src/lib.js'), 'utf8');
const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx'] });
const wanted = ['generateAndPrintReceipt', 'generateAndPrintReceiptStar', 'generateAndPrintPaymentReceipt', 'generateAndPrintPaymentReceiptStar', 'purchaseOrderReceipt', 'dailyClosingReceipt', 'generateAndPrintGiftCard', 'generateAndPrintVoucher', 'generateAndPrintStockTransferReceipt', 'generateAndPrintStockReportReceipt', 'generateAndPrintLoyaltyCard', 'RequestOrderReceipt', 'opencashdrawer'];
traverse(ast, {
  VariableDeclarator(p) {
    const name = p.node.id && p.node.id.name;
    if (!wanted.includes(name) || !/Function/.test(p.node.init?.type || '')) return;
    const returns = [];
    p.get('init').traverse({
      Function(inner) { if (inner.node !== p.node.init) inner.skip(); },
      ReturnStatement(r) { returns.push(code.slice(r.node.argument.start, r.node.argument.end)); },
    });
    console.log(name.padEnd(40), JSON.stringify([...new Set(returns)]));
  },
});
