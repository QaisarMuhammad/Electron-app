import { makeWebDesktop, oldDesktopStub, web, runV1 } from './_kit.mjs';
// cyclic object in barcodefinal (cloneable by structuredClone, so the old web could send it to v1)
const cyc = { printer: 'dymo', title: 'ok', barcode: '1', price: 5, conditionObject: { grade: 'A' } }; cyc.self = cyc;
const stub = oldDesktopStub(); const { desktop, events } = makeWebDesktop(stub.electron);
const r = await desktop.sendLabel({ barcodefinal: cyc, barcode: '1', title: 'ok', design: '1' });
console.log('cyclic barcodefinal on a v1 desktop ->', JSON.stringify(r), '| sent to v1:', stub.calls.length, '| events:', events.length);
const direct = oldDesktopStub(); direct.electron.sendBarcodeData({ barcodefinal: cyc, barcode: '1', title: 'ok', design: '1' });
console.log('the OLD web would have sent it (structured clone works on cycles):', (() => { try { structuredClone(direct.calls[0].payload); return 'clone ok'; } catch (e) { return String(e); } })());
// very deep nesting
let deep = { v: 'x' }; for (let i = 0; i < 20000; i++) deep = { n: deep };
const s2 = oldDesktopStub(); const w2 = makeWebDesktop(s2.electron);
const r2 = await w2.desktop.sendLabel({ barcodefinal: { printer: 'dymo', title: 't', barcode: '1', deep }, barcode: '1', title: 't' });
console.log('20000-deep object ->', JSON.stringify(r2).slice(0, 120), '| sent:', s2.calls.length);
// Date / Map / typed array values inside barcodefinal on v1 path
const s3 = oldDesktopStub(); const w3 = makeWebDesktop(s3.electron);
const date = new Date(0);
await w3.desktop.sendLabel({ barcodefinal: { printer: 'dymo', title: 't"', barcode: '1', when: date, bytes: new Uint8Array([1, 2]) }, barcode: '1', title: 't"' });
const sent = s3.calls[0].payload;
console.log('Date and Uint8Array travel as the same values:', sent.barcodefinal.when === date, sent.barcodefinal.bytes instanceof Uint8Array, '| title cleaned:', sent.barcodefinal.title);
