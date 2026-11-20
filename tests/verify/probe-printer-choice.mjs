import { bootNewDesktop, connectPage, runV1, dymoLabelsOf } from './_kit.mjs';
import * as P from './_payloads.mjs';
const mkp = (name, o = {}) => ({ name, modelName: name, printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true, ...o });
const lists = {
  'one LabelWriter 450': [mkp('DYMO LabelWriter 450')],
  '450 disconnected first, 550 connected': [mkp('DYMO LabelWriter 450', { isConnected: false }), mkp('DYMO LabelWriter 550')],
  'LabelManager (connected) first, LabelWriter second': [mkp('DYMO LabelManager PnP', { printerType: 'LabelManagerPrinter' }), mkp('DYMO LabelWriter 450')],
  'two connected LabelWriters': [mkp('DYMO LabelWriter 450 Turbo'), mkp('DYMO LabelWriter 550')],
  'network + local, network first': [mkp('DYMO LabelWriter 550 (network)', { isLocal: false }), mkp('DYMO LabelWriter 450')],
};
const payload = await P.modal('dymo');
for (const [name, printers] of Object.entries(lists)) {
  const v1 = await runV1('send-barcode-data', structuredClone(payload), { printers });
  const { world, factory } = await bootNewDesktop({ dymoFramework: { printers } });
  const page = connectPage(world);
  page.electron.sendBarcodeData(structuredClone(payload));
  await page.settle();
  const v2 = dymoLabelsOf(factory)[0];
  console.log(name.padEnd(52), 'v1 ->', String(v1.printer).padEnd(32), 'v2 ->', v2 && v2.printer, (v1.printer === (v2 && v2.printer)) ? '' : '   <== DIFFERENT PRINTER');
  world.cleanup();
}
