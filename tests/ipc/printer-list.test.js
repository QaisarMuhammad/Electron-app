'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrinterLister, normalizeSystemPrinters } = require('../../src/main/printerList');
const { userMessage } = require('../../src/main/errors');

const SYSTEM = [
  { name: 'EPSON TM-T20', displayName: 'EPSON TM-T20 Receipt', description: 'x', isDefault: true, status: 0, options: {} },
  { name: 'ZDesigner ZD420', displayName: '', isDefault: false, status: 3 },
];
const DYMO = { printers: [{ name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', printerType: 'LabelWriterPrinter', isConnected: true, isLocal: true }] };

test('both lists are normalised to the shapes of SPEC 6.1 and nothing else leaks through', async () => {
  const list = createPrinterLister({ getPrintersAsync: async () => SYSTEM, dymo: { listPrinters: async () => DYMO } });
  assert.deepEqual(await list(), {
    system: [
      { name: 'EPSON TM-T20', displayName: 'EPSON TM-T20 Receipt', isDefault: true, status: 0 },
      { name: 'ZDesigner ZD420', displayName: 'ZDesigner ZD420', isDefault: false, status: 3 },
    ],
    dymo: [{ name: 'DYMO LabelWriter 450', modelName: 'LabelWriter 450', isConnected: true }],
  });
});

test('entries without a name are dropped and a list that is not a list is empty', () => {
  assert.deepEqual(normalizeSystemPrinters([{ name: '' }, null, 'x', { displayName: 'no name' }, { name: 'ok' }]), [{ name: 'ok', displayName: 'ok', isDefault: false, status: undefined }]);
  assert.deepEqual(normalizeSystemPrinters(undefined), []);
  assert.deepEqual(normalizeSystemPrinters({}), []);
});

test('when DYMO Connect is not running the system list is complete and `dymoError` says what to do', async () => {
  const dymo = { listPrinters: async () => ({ printers: [], error: 'No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on.' }) };
  const result = await createPrinterLister({ getPrintersAsync: async () => SYSTEM, dymo })();
  assert.equal(result.system.length, 2);
  assert.deepEqual(result.dymo, []);
  assert.match(result.dymoError, /DYMO Connect/);
  assert.equal(result.ok, undefined);
});

test('a DYMO service that throws is reported with the standard text of DYMO_UNAVAILABLE and never breaks the list', async () => {
  const warned = [];
  const dymo = { listPrinters: async () => { throw new Error('window crashed'); } };
  const result = await createPrinterLister({ getPrintersAsync: async () => SYSTEM, dymo, log: { warn: (text) => warned.push(text) } })();
  assert.equal(result.dymoError, userMessage('DYMO_UNAVAILABLE'));
  assert.equal(result.system.length, 2);
  assert.match(warned[0], /window crashed/);
});

test('when the system list cannot be read the answer is a failed Result that still carries the DYMO list', async () => {
  const warned = [];
  const getPrintersAsync = async () => { throw new Error('print spooler is not running'); };
  const result = await createPrinterLister({ getPrintersAsync, dymo: { listPrinters: async () => DYMO }, log: { warn: (text) => warned.push(text) } })();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(result.message, 'The list of printers could not be read.');
  assert.deepEqual(result.system, []);
  assert.equal(result.dymo.length, 1);
  assert.match(warned[0], /print spooler/);
});

test('both lists failing still answers (the page shows its own messages)', async () => {
  const result = await createPrinterLister({
    getPrintersAsync: async () => { throw new Error('a'); },
    dymo: { listPrinters: async () => { throw new Error('b'); } },
  })();
  assert.equal(result.ok, false);
  assert.deepEqual(result.system, []);
  assert.deepEqual(result.dymo, []);
  assert.ok(result.dymoError);
});
