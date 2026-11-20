'use strict';

/**
 * Group B and F of the runtime-e2e lens: printing under stress in the REAL app.
 *
 *  B1-B10  the fake raw printer and the fake DYMO framework of launch-break.js (like the smoke harness): floods of labels with a failing
 *          printer (coalesced native boxes, unhandled rejections), a 6 MB receipt, 300 KB label payloads, odd payloads, a printer job that
 *          hangs (the 30 s queue timeout and the recovery of the queue), a quit with a hung job queued, concurrent printer lists.
 *  F1-F5   the app's REAL raw printer (real queue, real temp files, the real posix `lp` transport) with a fake `execFile`: temp files
 *          are created and removed, a printer that does not exist, hostile printer names stay ONE argument, and a job that hangs is
 *          killed by the queue timeout (a real child process) and the queue recovers.
 */

const fs = require('node:fs');

const { createBreakServer } = require('./break-server');
const {
  AppRun, scenario, sleep, seconds, waitFor, waitForPos, isAlive,
} = require('./harness');

const KB = 1024;
const MB = 1024 * 1024;

/** Receipt and label printers as Settings would save them. */
async function configurePrinters(run, { receipt = 'E2E-Receipt-58', label = 'E2E-Zebra-ZD420' } = {}) {
  await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: receipt, port: '' } });
  await run.cmd('setConfig', { path: 'printers.label', value: { transport: 'system', printerName: label, port: '' } });
}

/** A started app on a healthy fake POS with the POS page loaded and the printers configured. */
async function startPrintApp(name, options = {}) {
  const server = await createBreakServer();
  const run = new AppRun({ name, startUrl: server.smokeUrl, ...options });
  await run.start();
  await waitForPos(run, server.origin, 30_000);
  await configurePrinters(run, options.printerNames);
  return { server, run };
}

async function finish(server, run) {
  const stopped = await run.stop({ timeoutMs: 15_000 }).catch((error) => ({ error: error.message }));
  await server.stop();
  return stopped;
}

/** The native boxes recorded since `since` that mention a text. */
const boxesWith = (state, since, text) => state.dialogs.slice(since).filter((box) => `${box.message} ${box.detail}`.includes(text));

async function runPrintGroup(only) {
  const wants = (id) => !only || only.includes(id);

  // ---- B1..B4 floods ------------------------------------------------------------------------------------------------------------
  if (wants('B1')) {
    await scenario('B1', '100 rapid label sends with a FAILING printer: legacy (one coalesced box, no unhandled rejection) and acknowledged (100 failed Results)', async (t) => {
      const { server, run } = await startPrintApp('b1-flood');
      try {
        await run.cmd('failPrinter', { code: 'SPOOLER_ERROR' });
        const rssBefore = run.rssKb();
        const before = await run.cmd('light');

        // legacy, fire-and-forget: 100 in one tick
        const began = Date.now();
        await run.page("for (let i = 0; i < 100; i += 1) window.electron.sendBarcodeData({ barcodefinal: '^XA^FDlabel ' + i + '^FS^XZ', barcode: String(i) }); return 100;");
        await waitFor(async () => (await run.cmd('light')).jobs.filter((job) => job.ok === false).length >= 100, '100 failed legacy jobs', { timeoutMs: 20_000, intervalMs: 150 });
        const afterLegacy = await run.cmd('light');
        const legacyMs = Date.now() - began;
        const boxes = afterLegacy.dialogs.slice(before.dialogs.length);
        t.check('the 100 failures produced exactly ONE native box (coalesced per error code)', boxes.length === 1, boxes.map((box) => `${box.message} | ${box.detail}`));
        t.check('the box says what failed and what to do', boxes[0] && boxes[0].message === 'The label could not be printed' && /could not send the job to the printer/.test(boxes[0].detail), boxes[0]);
        t.check('every one of the 100 jobs failed with SPOOLER_ERROR', afterLegacy.jobs.filter((job) => job.code === 'SPOOLER_ERROR').length === 100, afterLegacy.jobs.length);
        t.check('no unhandled rejection or uncaught exception in the main process', afterLegacy.uncaught.length === 0, afterLegacy.uncaught);
        t.note(`100 legacy failing labels took ${seconds(legacyMs)}; the main process answered afterwards`);

        // acknowledged: 100 in parallel, every Result is a failure with the same code
        const answers = await run.page("const results = await Promise.all(Array.from({ length: 100 }, (_, i) => window.electron.printBarcode({ barcodefinal: '^XA^FDack ' + i + '^FS^XZ' }))); return results.map((r) => ({ ok: r.ok, code: r.code }));", 30_000);
        t.check('the 100 acknowledged calls all answer { ok: false, code: SPOOLER_ERROR }', answers.ok && answers.value.length === 100 && answers.value.every((r) => r.ok === false && r.code === 'SPOOLER_ERROR'), answers.ok ? answers.value.slice(0, 3) : answers);
        const afterAck = await run.cmd('light');
        t.check('the acknowledged path shows no box at all (the page shows the Result)', afterAck.dialogs.length === afterLegacy.dialogs.length, afterAck.dialogs.slice(afterLegacy.dialogs.length));

        // the printer is fine again: nothing is stuck
        await run.cmd('failPrinter', { code: null });
        const healthy = await run.pos('printBarcode');
        t.check('after the failures a healthy printer prints the next label at once (nothing stuck in the queue)', healthy.result && healthy.result.ok === true, healthy);
        t.check('the print queue is idle', (await run.cmd('queueSize', { key: 'system:E2E-Zebra-ZD420' })) === 0);
        t.note(`resident memory of the app: ${Math.round(rssBefore / 1024)} MB before, ${Math.round(run.rssKb() / 1024)} MB after 200 failed labels`);
      } finally {
        await finish(server, run);
      }
    });
  }

  if (wants('B2')) {
    await scenario('B2', '100 rapid DYMO labels: a failing printer (one box) then a healthy one (all 100 printed, in order)', async (t) => {
      const { server, run } = await startPrintApp('b2-dymo');
      try {
        await run.cmd('dymoFail', { message: 'The printer is out of labels' });
        const before = await run.cmd('light');
        await run.page("for (let i = 0; i < 100; i += 1) window.electron.sendBarcodeData({ size: '32x57', design: '1', currency: 'GBP', barcode: 'B' + i, barcodefinal: { printer: 'dymo', title: 'ITEM-' + i, barcode: 'B' + i, price: '9.99', conditionObject: { grade: 'A' } } }); return 100;");
        await waitFor(async () => (await run.cmd('light')).dialogs.length > before.dialogs.length, 'the DYMO error box', { timeoutMs: 40_000, intervalMs: 200 });
        await sleep(2500);
        const mid = await run.cmd('light');
        const boxes = mid.dialogs.slice(before.dialogs.length);
        t.check('100 failing DYMO labels produce ONE native box', boxes.length === 1 && /DYMO label could not be printed/.test(boxes[0].detail), boxes);
        t.check('no unhandled rejection', mid.uncaught.length === 0, mid.uncaught);

        await run.cmd('dymoFail', { message: null });
        const printedBefore = mid.dymo.labels.filter((label) => label.printed).length;
        const began = Date.now();
        await run.page("for (let i = 0; i < 100; i += 1) window.electron.sendBarcodeData({ size: '32x57', design: '1', currency: 'GBP', barcode: 'OK' + i, barcodefinal: { printer: 'dymo', title: 'OKITEM-' + i, barcode: 'OK' + i, price: '9.99', conditionObject: { grade: 'A' } } }); return 100;");
        const done = await waitFor(async () => {
          const now = await run.cmd('light');
          return now.dymo.labels.filter((label) => label.printed).length >= printedBefore + 100 ? now : null;
        }, '100 DYMO labels', { timeoutMs: 60_000, intervalMs: 250 }).catch(() => null);
        t.check('all 100 labels print once the printer is fine', Boolean(done), (await run.cmd('light')).dymo.labels.length);
        if (done) {
          const titles = done.dymo.labels.filter((label) => label.printed).map((label) => (label.ops.find((op) => /^OKITEM-\d+$/.test(op.value)) || {}).value).filter(Boolean);
          const inOrder = titles.length === 100 && titles.every((title, index) => title === `OKITEM-${index}`);
          t.check('and they come out in the order they were sent', inOrder, titles.slice(0, 8));
          t.note(`100 DYMO labels printed in ${seconds(Date.now() - began)}`);
        }
        t.check('one helper window served all of them', (await run.cmd('light')).dymo.windowsCreated === 1, (await run.cmd('light')).dymo.windowsCreated);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- B5 big receipts ------------------------------------------------------------------------------------------------------------
  if (wants('B5')) {
    await scenario('B5', 'A 6 MB receipt (legacy and acknowledged), exactly 5 MB, and a 6-million-element array', async (t) => {
      const { server, run } = await startPrintApp('b5-big');
      try {
        const memoryBefore = await run.cmd('memory');
        const ack = await run.page("const began = performance.now(); const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array(6 * 1024 * 1024).fill(65) }); return { result, ms: Math.round(performance.now() - began) };", 60_000);
        t.check('a 6 MB receipt answers INVALID_PAYLOAD (too large), nothing is printed', ack.ok && ack.value.result.ok === false && ack.value.result.code === 'INVALID_PAYLOAD' && ack.value.result.details && ack.value.result.details.reason === 'too-large', ack);
        t.note(`the 6 MB refusal took ${ack.ok ? ack.value.ms : '?'} ms in the page`);
        t.check('no job reached the printer', (await run.cmd('light')).jobs.length === 0, (await run.cmd('light')).jobs);

        const boxesBefore = (await run.cmd('light')).dialogs.length;
        await run.page("window.electron.sendReceiptData({ receiptFileBinary: new Uint8Array(6 * 1024 * 1024).fill(66), order: { id: 1 } }); return 1;", 60_000);
        await waitFor(async () => (await run.cmd('light')).dialogs.length > boxesBefore, 'the native box of the legacy 6 MB receipt', { timeoutMs: 15_000 });
        const box = (await run.cmd('light')).dialogs.at(-1);
        t.check('the legacy path shows ONE plain native box for the 6 MB receipt', box.message === 'The receipt could not be printed' && /could not read/.test(box.detail), box);

        const exact = await run.page("const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array(5 * 1024 * 1024).fill(67) }); return result;", 60_000);
        t.check('exactly 5 MB is accepted and prints', exact.ok && exact.value.ok === true, exact);
        const jobs = (await run.cmd('light')).jobs;
        t.check('the job carries all 5242880 bytes', jobs.length === 1 && jobs[0].length === 5 * MB, jobs.map((job) => job.length));

        const over = await run.page("return await window.electron.printReceipt({ receiptFileBinary: new Uint8Array(5 * 1024 * 1024 + 1).fill(68) });", 60_000);
        t.check('5 MB + 1 byte is refused', over.ok && over.value.ok === false && over.value.code === 'INVALID_PAYLOAD', over);

        const array = await run.page("const began = performance.now(); const result = await window.electron.printReceipt({ receiptFileBinary: new Array(6000000).fill(65) }); return { result, ms: Math.round(performance.now() - began) };", 60_000);
        t.check('a plain array of 6 million numbers is refused too (no loop over it, no hang)', array.ok && array.value.result.ok === false && array.value.result.code === 'INVALID_PAYLOAD', array);
        t.note(`the 6M-element array answer took ${array.ok ? array.value.ms : '?'} ms`);

        const memoryAfter = await run.cmd('memory');
        t.check('the main process memory did not balloon (heap growth under 200 MB after all of this)', memoryAfter.heapUsed - memoryBefore.heapUsed < 200 * MB, { before: memoryBefore.heapUsed, after: memoryAfter.heapUsed });
        t.check('the main process is still responsive and threw nothing', (await run.cmd('light')).uncaught.length === 0);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- B6 300 KB labels --------------------------------------------------------------------------------------------------------
  if (wants('B6')) {
    await scenario('B6', '300 KB label payloads: ZPL limits, a 300 KB DYMO title, 300 KB of unread properties on repair labels and receipts', async (t) => {
      const { server, run } = await startPrintApp('b6-labels');
      try {
        const zpl = async (bytes) => {
          const answer = await run.page(`const zpl = '^XA^FD' + 'A'.repeat(${bytes} - 12) + '^FS^XZ'; return await window.electron.printBarcode({ barcodefinal: zpl });`, 30_000);
          return answer.ok ? answer.value : answer;
        };
        const big = await zpl(300 * KB);
        t.check('a 300 KB ZPL label is refused with INVALID_PAYLOAD (over every limit)', big.ok === false && big.code === 'INVALID_PAYLOAD', big);
        const mid = await zpl(100 * KB);
        t.record('zpl100kb', mid);
        t.check('SPEC 12 names a 256 KB label limit: a 100 KB ZPL label prints', mid.ok === true, mid);
        const exact = await zpl(64 * KB);
        t.check('a ZPL label of exactly 64 KB prints', exact.ok === true, exact);
        const over = await zpl(64 * KB + 1);
        t.record('zpl64kb+1', over);
        t.note(`64 KB + 1 byte: ${JSON.stringify({ ok: over.ok, code: over.code })}`);

        const labelsBefore = (await run.cmd('light')).dymo.labels.length;
        const title = await run.page("const result = await window.electron.printBarcode({ size: '32x57', design: '1', currency: 'GBP', barcode: 'T1', barcodefinal: { printer: 'dymo', title: 'T'.repeat(300 * 1024), barcode: 'T1', price: '1.00' } }); return result;", 30_000);
        t.check('a DYMO label with a 300 KB title prints (the text is cut to 2 KB, not rejected)', title.ok && title.value.ok === true, title);
        const printed = (await run.cmd('light')).dymo.labels.slice(labelsBefore).at(-1);
        const longest = printed ? Math.max(...printed.ops.map((op) => Buffer.byteLength(op.value))) : -1;
        t.check('and no text on the label is longer than 2 KB', printed && longest <= 2048, { longest });

        const repair = await run.page(`
          const item = (name) => ({ product_name: name, current_price: 1, junk: 'J'.repeat(300 * 1024), custom_field_value: [{ value: 'Black' }, { value: '123' }, { value: 'ok' }] });
          return await window.electron.printBarcode({ size: '70x54', design: 'repair', barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R1', orderDate: '19/11/2026', customer: { name: 'A', cell_no: '1' }, business: { business_name: 'B', branch_name: 'C' }, orderItems: [item('one'), item('two')] } });`, 30_000);
        t.check('a repair label whose two order items carry 300 KB of unread data each prints both labels (SPEC 12)', repair.ok && repair.value.ok === true, repair);

        const receipt = await run.page("return await window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, 72, 105, 10, 29, 86, 0]), order: { notes: 'n'.repeat(300 * 1024) }, business: { x: 'b'.repeat(300 * 1024) }, settings: { note: 's'.repeat(10 * 1024) } });", 30_000);
        t.check('a receipt envelope with 600 KB of unread order data prints', receipt.ok && receipt.value.ok === true, receipt);
        const lastJob = (await run.cmd('light')).jobs.at(-1);
        t.check('and only the 8 receipt bytes reached the printer', lastJob && lastJob.length === 8, lastJob);

        const tooMuch = await run.page(`
          const items = Array.from({ length: 100 }, (_, i) => ({ product_name: 'P'.repeat(2048), custom_field_value: [{ value: 'a'.repeat(2048) }, { value: 'b'.repeat(2048) }, { value: 'c'.repeat(2048) }] }));
          return await window.electron.printBarcode({ size: '70x54', design: 'repair', barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R2', orderDate: 'd', customer: { name: 'A', cell_no: '1' }, business: { business_name: 'B', branch_name: 'C' }, orderItems: items } });`, 40_000);
        t.note(`a repair message that READS ${(100 * 4 * 2048) / KB} KB: ${JSON.stringify(tooMuch.ok ? { ok: tooMuch.value.ok, code: tooMuch.value.code } : tooMuch)}`);
        t.check('a repair message that reads 800 KB answers a clean Result (rejected or printed), never a hang or crash', tooMuch.ok && typeof tooMuch.value.ok === 'boolean', tooMuch);
        const over100 = await run.page(`
          const items = Array.from({ length: 101 }, (_, i) => ({ product_name: 'P' + i, custom_field_value: [] }));
          return await window.electron.printBarcode({ size: '70x54', design: 'repair', barcodefinal: { printer: 'dymo', design: 'repair', barcode: 'R3', orderDate: 'd', customer: { name: 'A', cell_no: '1' }, business: { business_name: 'B', branch_name: 'C' }, orderItems: items } });`, 40_000);
        t.check('101 repair labels in one message are refused (limit 100)', over100.ok && over100.value.ok === false, over100);
        t.check('the main process threw nothing', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- B7 odd payloads --------------------------------------------------------------------------------------------------------
  if (wants('B7')) {
    await scenario('B7', 'Odd and hostile payloads on every call: always a Result (or a refusal in the page), the main process never throws', async (t) => {
      const { server, run } = await startPrintApp('b7-odd');
      try {
        const answer = await run.page(`
          const make = {
            'null': () => null, 'undefined': () => undefined, 'number': () => 42, 'string': () => 'hello', 'array': () => [1, 2, 3], 'empty object': () => ({}),
            'barcodefinal number': () => ({ barcodefinal: 5 }), 'barcodefinal true': () => ({ barcodefinal: true }),
            'dymo no fields': () => ({ barcodefinal: { printer: 'dymo' } }),
            'dymo orderItems string': () => ({ barcodefinal: { printer: 'dymo', design: 'repair', orderItems: 'x' } }),
            'dymo size object': () => ({ size: {}, design: [], barcodefinal: { printer: 'dymo', title: { a: 1 }, barcode: [1, 2], price: {} } }),
            'dymo title number': () => ({ barcodefinal: { printer: 'dymo', title: 12345, barcode: 987654321, storage: false, price: 5 } }),
            'receipt string': () => ({ receiptFileBinary: 'text' }), 'receipt number': () => ({ receiptFileBinary: 5 }),
            'receipt bad buffer': () => ({ receiptFileBinary: { type: 'Buffer', data: [1, 2, 300] } }),
            'receipt negative': () => ({ receiptFileBinary: [1, -2, 3] }), 'receipt floats': () => ({ receiptFileBinary: new Float64Array(8) }),
            'receipt arraybuffer': () => ({ receiptFileBinary: new ArrayBuffer(16) }), 'receipt dataview': () => ({ receiptFileBinary: new DataView(new ArrayBuffer(16)) }),
            'receipt empty buffer json': () => ({ receiptFileBinary: { type: 'Buffer', data: [] } }),
            'drawer password object': () => ({ password: { a: 1 }, cashDrawerOpenPassword: 5 }),
            'proto key': () => JSON.parse('{"__proto__":{"printer":"dymo"},"barcodefinal":"^XA^XZ"}'),
            'constructor key': () => JSON.parse('{"constructor":{"prototype":{"polluted":true}},"barcodefinal":"^XA^XZ"}'),
            'cycle': () => { const o = { barcodefinal: '^XA^FDcycle^FS^XZ' }; o.self = o; return o; },
            'bigint': () => ({ barcodefinal: '^XA^XZ', n: 10n }), 'date map set': () => ({ barcodefinal: '^XA^XZ', d: new Date(), m: new Map([[1, 2]]), s: new Set([1]) }),
            'deep 3000': () => { let o = { barcodefinal: '^XA^XZ' }; for (let i = 0; i < 3000; i += 1) o = { next: o, barcodefinal: '^XA^XZ' }; return o; },
            'function': () => ({ barcodefinal: '^XA^XZ', f() {} }), 'symbol': () => ({ s: Symbol('x') }),
          };
          const calls = { printReceipt: (p) => window.electron.printReceipt(p), printBarcode: (p) => window.electron.printBarcode(p), openCashDrawer: (p) => window.electron.openCashDrawer(p) };
          const out = [];
          for (const [name, build] of Object.entries(make)) {
            for (const [callName, call] of Object.entries(calls)) {
              let payload;
              try { payload = build(); } catch (error) { out.push({ name, callName, built: String(error.message).slice(0, 60) }); continue; }
              try {
                const result = await call(payload);
                out.push({ name, callName, ok: result && result.ok, code: result && result.code, type: typeof result });
              } catch (error) {
                out.push({ name, callName, thrown: String(error && error.name || error).slice(0, 60) });
              }
            }
          }
          // the legacy fire-and-forget calls with the same garbage
          for (const [name, build] of Object.entries(make)) {
            for (const method of ['sendReceiptData', 'sendBarcodeData', 'sendOpenDrawerCommand']) {
              try { window.electron[method](build()); } catch (error) { out.push({ name, method, thrown: String(error && error.name || error).slice(0, 60) }); }
            }
          }
          return out;`, 120_000);
        t.check('the page ran every odd call', answer.ok, answer);
        if (answer.ok) {
          const rows = answer.value;
          const results = rows.filter((row) => row.callName);
          const answered = results.filter((row) => row.type === 'object');
          const thrown = results.filter((row) => row.thrown);
          t.record('thrownInPage', thrown.map((row) => `${row.name}/${row.callName}: ${row.thrown}`));
          t.note(`${results.length} acknowledged calls: ${answered.length} answered a Result, ${thrown.length} were refused inside the page (not cloneable): ${[...new Set(thrown.map((row) => row.name))].join(', ')}`);
          t.check('every call that reached the app answered a Result object with a boolean ok', answered.every((row) => typeof row.ok === 'boolean'), answered.filter((row) => typeof row.ok !== 'boolean').slice(0, 5));
          t.check('only values that cannot cross the process boundary (function, symbol) were refused in the page', thrown.every((row) => /function|symbol/.test(row.name) || /DataCloneError|Error/.test(row.thrown)), thrown.slice(0, 6));
          const polluted = await run.page("return ({}).polluted === undefined && typeof window.electron === 'object';");
          t.check('the page still has its bridge and nothing polluted Object.prototype', polluted.ok && polluted.value === true, polluted);
        }
        await sleep(1500);
        const state = await run.cmd('light');
        t.check('the main process threw nothing and rejected nothing', state.uncaught.length === 0, state.uncaught);
        const rendererAlive = await run.page('return 1;').catch(() => ({ ok: false }));
        t.check('the app is still responsive', rendererAlive.ok, rendererAlive);
        t.note(`${state.dialogs.length} native boxes were shown during the garbage run (coalesced per code): ${[...new Set(state.dialogs.map((box) => box.message))].join(' | ')}`);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- B8 / B9 a hung printer job ------------------------------------------------------------------------------------------------
  if (wants('B8')) {
    await scenario('B8', 'A printer job that hangs: PRINT_TIMEOUT after 30 s, the job behind it prints, the queue recovers; then a legacy hang and a quit with that job queued', async (t) => {
      const { server, run } = await startPrintApp('b8-hang');
      try {
        await run.cmd('delayPrinter', { ms: 90_000 });
        const t0 = Date.now();
        const first = run.page("const began = performance.now(); const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, 49, 10]) }); return { result, ms: Math.round(performance.now() - began) };", 80_000);
        await sleep(400);
        const second = run.page("const began = performance.now(); const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, 50, 10]) }); return { result, ms: Math.round(performance.now() - began) };", 80_000);
        await sleep(400);
        t.check('two jobs queue on the same printer key (one running, one waiting)', (await run.cmd('queueSize', { key: 'system:E2E-Receipt-58' })) === 2, await run.cmd('queueSize', { key: 'system:E2E-Receipt-58' }));
        await sleep(8000);
        await run.cmd('delayPrinter', { ms: 0 });
        const a = await first;
        const aAt = Date.now() - t0;
        const b = await second;
        const bAt = Date.now() - t0;
        t.record('timeline', { firstSettledMs: aAt, secondSettledMs: bAt });
        t.check('the hung job answers PRINT_TIMEOUT', a.ok && a.value.result.ok === false && a.value.result.code === 'PRINT_TIMEOUT', a);
        t.check('after about 30 s (not earlier, not much later)', aAt >= 29_000 && aAt <= 33_500, aAt);
        t.check('the job behind it runs once the hung one is abandoned and prints', b.ok && b.value.result.ok === true, b);
        t.check('right after the timeout (within 3 s)', bAt - aAt < 3000, { aAt, bAt });
        t.check('the print queue is idle again', (await run.cmd('queueSize', { key: 'system:E2E-Receipt-58' })) === 0);
        const healthy = await run.pos('printReceipt');
        t.check('and later jobs print normally', healthy.result && healthy.result.ok === true, healthy);
        t.note(`the first job settled ${seconds(aAt)} after it was sent, the second ${seconds(bAt)}`);

        // legacy hang, then quit with the job queued
        await run.cmd('delayPrinter', { ms: 90_000 });
        await run.page("window.electron.sendReceiptData({ receiptFileBinary: new Uint8Array([27, 64, 51, 10]) }); return 1;");
        await sleep(1500);
        t.check('the legacy job is running (queued on the printer)', (await run.cmd('queueSize', { key: 'system:E2E-Receipt-58' })) === 1);
        const quitAt = Date.now();
        await run.cmd('quit');
        const exited = await Promise.race([run.exited, sleep(25_000).then(() => null)]);
        const quitMs = Date.now() - quitAt;
        t.check('quitting with a hung job queued ends the app by itself (the drain gives up after 5 s)', exited !== null, 'still running after 25 s');
        t.check('and it exits cleanly (code 0)', exited && exited.code === 0, exited);
        t.check('within 5 to 9 seconds', quitMs >= 4500 && quitMs <= 9500, quitMs);
        t.note(`quit with a hung job took ${seconds(quitMs)}`);
      } finally {
        await finish(server, run);
      }
    });
  }

  if (wants('B10')) {
    await scenario('B10', '30 concurrent printer lists and 30 concurrent app-info calls: one helper window, one answer for all', async (t) => {
      const { server, run } = await startPrintApp('b10-concurrent');
      try {
        const answer = await run.page("const lists = await Promise.all(Array.from({ length: 30 }, () => window.electron.getPrinters())); const infos = await Promise.all(Array.from({ length: 30 }, () => window.electron.getAppInfo())); return { systems: lists.map((l) => l.system.length), dymos: lists.map((l) => l.dymo.length), infos: infos.map((i) => i.apiVersion) };", 60_000);
        t.check('all 30 lists answer 3 system printers and 2 DYMO printers', answer.ok && answer.value.systems.every((n) => n === 3) && answer.value.dymos.every((n) => n === 2), answer);
        t.check('all 30 app-info calls answer apiVersion 2', answer.ok && answer.value.infos.every((v) => v === 2), answer);
        t.check('exactly ONE DYMO helper window was created for the 30 concurrent requests', (await run.cmd('light')).dymo.windowsCreated === 1, (await run.cmd('light')).dymo.windowsCreated);
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0);
      } finally {
        await finish(server, run);
      }
    });
  }

  if (wants('B11')) {
    await scenario('B11', 'A soak: 5000 acknowledged receipts and 2000 legacy labels in bursts: all answered, the queue is idle, memory does not grow', async (t) => {
      const { server, run } = await startPrintApp('b11-soak');
      try {
        const heapBefore = (await run.cmd('memory')).heapUsed;
        const rssBefore = run.rssKb();
        const began = Date.now();
        for (let burst = 0; burst < 10; burst += 1) {
          const answer = await run.page("const results = await Promise.all(Array.from({ length: 500 }, (_, i) => window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, i % 256, 10]) }))); return results.filter((r) => r.ok === true).length;", 60_000);
          if (!answer.ok || answer.value !== 500) {
            t.check(`burst ${burst + 1}: all 500 receipts answered ok`, false, answer);
            break;
          }
        }
        for (let burst = 0; burst < 4; burst += 1) {
          await run.page("for (let i = 0; i < 500; i += 1) window.electron.sendBarcodeData({ barcodefinal: '^XA^FD' + i + '^FS^XZ' }); return 500;", 30_000);
        }
        await waitFor(async () => (await run.cmd('queueSize', { key: 'system:E2E-Zebra-ZD420' })) === 0, 'the label queue to drain', { timeoutMs: 30_000, intervalMs: 200 });
        const light = await run.cmd('light');
        t.check('all 5000 receipts and 2000 labels reached the printer and succeeded', light.jobs.length === 7000 && light.jobs.every((job) => job.ok === true), { jobs: light.jobs.length, failed: light.jobs.filter((job) => job.ok !== true).length });
        t.check('both print queues are idle', (await run.cmd('queueSize', { key: 'system:E2E-Receipt-58' })) === 0 && (await run.cmd('queueSize', { key: 'system:E2E-Zebra-ZD420' })) === 0);
        t.check('no uncaught exception and no native box', light.uncaught.length === 0 && light.dialogs.length === 0, { uncaught: light.uncaught, dialogs: light.dialogs.length });
        const heapAfter = (await run.cmd('memory')).heapUsed;
        t.note(`7000 jobs in ${seconds(Date.now() - began)}; main heap ${Math.round(heapBefore / MB)} -> ${Math.round(heapAfter / MB)} MB, all processes ${Math.round(rssBefore / 1024)} -> ${Math.round(run.rssKb() / 1024)} MB`);
        t.check('the main process heap grew by less than 150 MB (the test recorder keeps one small record per job)', heapAfter - heapBefore < 150 * MB, { heapBefore, heapAfter });
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- F the REAL raw transport ----------------------------------------------------------------------------------------------------
  if (wants('F1')) {
    await scenario('F1', 'REAL raw printer, printer unknown to CUPS: PRINTER_NOT_FOUND, exact argv, a 0600 temp file of the right size that is removed', async (t) => {
      const { server, run } = await startPrintApp('f1-real', { realRaw: true, execMode: 'notfound', printerNames: { receipt: 'GPOS-E2E-NO-SUCH-PRINTER', label: 'GPOS-E2E-NO-SUCH-LABEL' } });
      try {
        const result = await run.pos('printReceipt');
        t.check('the real transport answers PRINTER_NOT_FOUND', result.result && result.result.ok === false && result.result.code === 'PRINTER_NOT_FOUND', result);
        t.check('and the message names the printer', result.result && /GPOS-E2E-NO-SUCH-PRINTER/.test(result.result.message), result.result);
        const exec = await run.cmd('execLog');
        t.check('exactly one `lp` run with the argv [-d, <name>, -o, raw, <temp file>]', exec.log.length === 1 && exec.log[0].file === 'lp' && JSON.stringify(exec.log[0].args.slice(0, 4)) === JSON.stringify(['-d', 'GPOS-E2E-NO-SUCH-PRINTER', '-o', 'raw']), exec.log);
        const entry = exec.log[0];
        t.check('the temp file existed while `lp` ran, with mode 0600 and the size of the receipt', entry && entry.temp.mode === '600' && entry.temp.size > 20 && /gpos-\d+-\d+-\d+\.bin$/.test(entry.temp.path), entry && entry.temp);
        t.check('and it is gone afterwards (nothing leaked in the temp folder)', (await run.cmd('tempFiles')).length === 0, await run.cmd('tempFiles'));
        const label = await run.pos('printBarcode');
        t.check('a ZPL label goes through the same path and also answers PRINTER_NOT_FOUND', label.result && label.result.code === 'PRINTER_NOT_FOUND', label);
        t.check('its temp file is a .zpl one and is removed as well', (await run.cmd('execLog')).log[1].temp.path.endsWith('.zpl') && (await run.cmd('tempFiles')).length === 0);
      } finally {
        await finish(server, run);
      }
    });
  }

  if (wants('F2')) {
    await scenario('F2', 'REAL raw printer: a 5 MB receipt, 50 concurrent receipts, unique temp names, nothing left behind', async (t) => {
      const { server, run } = await startPrintApp('f2-real', { realRaw: true, execMode: 'ok' });
      try {
        const began = Date.now();
        const big = await run.page("return await window.electron.printReceipt({ receiptFileBinary: new Uint8Array(5 * 1024 * 1024).fill(65) });", 60_000);
        t.check('a 5 MB receipt prints through the real transport', big.ok && big.value.ok === true, big);
        const first = (await run.cmd('execLog')).log[0];
        t.check('the temp file held all 5242880 bytes while `lp` ran', first && first.temp.size === 5 * MB, first && first.temp);
        t.note(`the 5 MB receipt took ${Date.now() - began} ms end to end`);
        t.check('and it was removed', (await run.cmd('tempFiles')).length === 0, await run.cmd('tempFiles'));

        const many = await run.page("const results = await Promise.all(Array.from({ length: 50 }, (_, i) => window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, i, 10]) }))); return results.map((r) => r.ok);", 60_000);
        t.check('50 concurrent receipts all print', many.ok && many.value.length === 50 && many.value.every(Boolean), many);
        const exec = await run.cmd('execLog');
        const names = exec.log.slice(1).map((entry) => entry.temp.path);
        t.check('every one of them had its own temp file name', new Set(names).size === 50 && names.every((name) => name), names.length);
        t.check('every temp file existed while `lp` ran, with 4 bytes', exec.log.slice(1).every((entry) => entry.temp.size === 4), exec.log.slice(1, 4).map((entry) => entry.temp));
        t.check('and none is left in the temp folder', (await run.cmd('tempFiles')).length === 0, await run.cmd('tempFiles'));
      } finally {
        await finish(server, run);
      }
    });
  }

  if (wants('F3')) {
    await scenario('F3', 'REAL raw printer: hostile printer names stay ONE argument, a leading dash and a 600-character name are refused', async (t) => {
      const { server, run } = await startPrintApp('f3-real', { realRaw: true, execMode: 'notfound' });
      const marker = `/tmp/gpos-e2e-pwned-${process.pid}`;
      try {
        const nasty = `GPOS "q" $(touch ${marker}) ; | & \`touch ${marker}\` x`;
        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: nasty, port: '' } });
        const nastyResult = await run.pos('printReceipt');
        const exec = await run.cmd('execLog');
        t.check('a name full of shell characters reaches `lp` as ONE argv element, unchanged', exec.log.length === 1 && exec.log[0].args[1] === nasty && exec.log[0].args.length === 5, exec.log[0] && exec.log[0].args);
        t.check('no shell ran it: the marker file does not exist', !fs.existsSync(marker), marker);
        t.check('the answer is a plain PRINTER_NOT_FOUND Result', nastyResult.result && nastyResult.result.code === 'PRINTER_NOT_FOUND', nastyResult);

        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: '-oops', port: '' } });
        const dash = await run.pos('printReceipt');
        t.check('a name that starts with a dash is refused (it would be read as an option of `lp`)', dash.result && dash.result.code === 'INVALID_SETTINGS', dash);
        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: 'N'.repeat(600), port: '' } });
        const long = await run.pos('printReceipt');
        t.check('a 600-character name is refused', long.result && long.result.code === 'INVALID_SETTINGS', long);
        t.check('neither of the two reached `lp`', (await run.cmd('execLog')).log.length === 1);
        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'port', printerName: '', port: 'LPT1' } });
        const port = await run.pos('printReceipt');
        t.check('a legacy port printer on macOS answers UNSUPPORTED_PLATFORM with a plain message (no crash)', port.result && port.result.code === 'UNSUPPORTED_PLATFORM', port);
        t.check('no temp file is left', (await run.cmd('tempFiles')).length === 0, await run.cmd('tempFiles'));
      } finally {
        try { fs.unlinkSync(marker); } catch { /* not there: good */ }
        await finish(server, run);
      }
    });
  }

  if (wants('F4')) {
    await scenario('F4', 'REAL raw printer, `lp` hangs: the queue timeout kills the real child process after 30 s, the temp file is removed, the next job prints', async (t) => {
      const { server, run } = await startPrintApp('f4-real', { realRaw: true, execMode: 'hang' });
      try {
        const t0 = Date.now();
        const first = run.page("const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, 49, 10]) }); return result;", 80_000);
        await sleep(1500);
        const exec = await run.cmd('execLog');
        const child = exec.log[0] && exec.log[0].childPid;
        t.check('the real transport started a real child process (sleep)', Number.isInteger(child) && child > 0 && isAlive(child), exec.log);
        t.check('and the temp file exists while it runs', (await run.cmd('tempFiles')).length === 1, await run.cmd('tempFiles'));
        const second = run.page("const result = await window.electron.printReceipt({ receiptFileBinary: new Uint8Array([27, 64, 50, 10]) }); return result;", 80_000);
        await sleep(500);
        await run.cmd('execMode', { mode: 'ok' });
        const a = await first;
        const aAt = Date.now() - t0;
        t.check('the hung job answers PRINT_TIMEOUT after about 30 s', a.ok && a.value.code === 'PRINT_TIMEOUT' && aAt >= 29_000 && aAt <= 34_000, { a, aAt });
        await sleep(300);
        t.check('the hung child process was killed (the abort signal reached it)', Number.isInteger(child) && !isAlive(child), { child });
        const b = await second;
        t.check('the job behind it prints', b.ok && b.value.ok === true, b);
        t.check('no temp file is left', (await run.cmd('tempFiles')).length === 0, await run.cmd('tempFiles'));
        const after = await run.pos('printReceipt');
        t.check('and later jobs print normally', after.result && after.result.ok === true, after);
        t.note(`the hung job settled ${seconds(aAt)} after it was sent`);
      } finally {
        await finish(server, run);
      }
    });
  }


  // ---- F5 the REAL DYMO service without DYMO software ------------------------------------------------------------------------------
  if (wants('F5')) {
    await scenario('F5', 'REAL DYMO service and hidden window on a machine without DYMO software: lists and labels fail plainly and quickly, one helper window, no leak', async (t) => {
      const { server, run } = await startPrintApp('f5-dymo', { realDymo: true });
      const dymoWindows = async () => (await run.cmd('windows')).filter((win) => /dymo-loader\.html/.test(win.url));
      try {
        t.check('no helper window exists before the first DYMO call (lazy)', (await dymoWindows()).length === 0, await run.cmd('windows'));
        const began = Date.now();
        const list = await run.page('return await window.electron.getPrinters();', 60_000);
        const listMs = Date.now() - began;
        t.record('listMs', listMs);
        t.check('getPrinters answers: the 3 system printers, no DYMO printer, and a plain dymoError', list.ok && list.value.system.length === 3 && Array.isArray(list.value.dymo) && list.value.dymo.length === 0 && typeof list.value.dymoError === 'string' && list.value.dymoError.length > 0, list);
        t.check('within 20 s', listMs < 20_000, listMs);
        t.note(`getPrinters with no DYMO software: ${listMs} ms, dymoError "${list.ok && list.value.dymoError}"`);
        t.check('one hidden helper window was created, and it is not visible', (await dymoWindows()).length === 1 && (await dymoWindows())[0].visible === false, await run.cmd('windows'));

        const first = Date.now();
        const label = await run.pos('printBarcode:dymo', {}, 60_000);
        const labelMs = Date.now() - first;
        t.record('labelMs', labelMs);
        t.check('a DYMO label answers a clean failure (DYMO_NO_PRINTER or DYMO_UNAVAILABLE) with a plain message', label.result && label.result.ok === false && /^DYMO_(NO_PRINTER|UNAVAILABLE)$/.test(label.result.code) && /DYMO/.test(label.result.message), label);
        t.note(`one DYMO label with no DYMO software: ${labelMs} ms -> ${label.result && label.result.code}`);

        const burst = await run.page("const results = await Promise.all(Array.from({ length: 10 }, (_, i) => window.electron.printBarcode({ size: '32x57', design: '1', barcodefinal: { printer: 'dymo', title: 'B' + i, barcode: String(i) } }))); return results.map((r) => ({ ok: r.ok, code: r.code }));", 120_000);
        t.check('10 labels sent at once all answer the same clean failure', burst.ok && burst.value.length === 10 && burst.value.every((r) => r.ok === false && /^DYMO_/.test(r.code)), burst);
        t.check('still at most one helper window (no leak)', (await dymoWindows()).length <= 1, await run.cmd('windows'));

        const boxesBefore = (await run.cmd('light')).dialogs.length;
        await run.page("for (let i = 0; i < 10; i += 1) window.electron.sendBarcodeData({ size: '32x57', design: '1', barcodefinal: { printer: 'dymo', title: 'L' + i, barcode: String(i) } }); return 10;");
        await waitFor(async () => (await run.cmd('light')).dialogs.length > boxesBefore, 'the native box for the legacy DYMO failures', { timeoutMs: 60_000, intervalMs: 300 });
        await sleep(2000);
        const boxes = (await run.cmd('light')).dialogs.slice(boxesBefore);
        t.check('10 legacy DYMO failures show ONE native box with a plain message', boxes.length === 1 && /DYMO/.test(boxes[0].detail), boxes);
        const test = await run.cmd('desktopApi', { name: 'testPrint', args: ['dymo'] }, 60_000);
        t.check('the Settings test print on DYMO answers a clean failure too', test && test.ok === false && /^DYMO_/.test(test.code), test);
        const receipt = await run.pos('printReceipt');
        t.check('a receipt still prints while DYMO is missing', receipt.result && receipt.result.ok === true, receipt);
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- F6 missing printers -------------------------------------------------------------------------------------------------------------
  if (wants('F6')) {
    await scenario('F6', 'The operating system lists no printers, fails, or never answers: getPrinters and Settings stay usable', async (t) => {
      const { server, run } = await startPrintApp('f6-printers');
      const openAndShoot = async (name, waitMs) => {
        await run.cmd('openSettingsN', { n: 1, tab: 'printers' });
        const win = await waitFor(async () => (await run.cmd('windows')).find((w) => /settings\.html/.test(w.url)) || null, 'the Settings window', { timeoutMs: 15_000 });
        await sleep(waitMs);
        const shot = await run.cmd('captureWindow', { id: win.id, file: `${require('node:path').join(__dirname, 'out')}/break-${name}.png` });
        await run.cmd('closeWindow', { id: win.id });
        await waitFor(async () => !(await run.cmd('windows')).some((w) => /settings\.html/.test(w.url)), 'Settings to close', { timeoutMs: 8000 }).catch(() => {});
        return shot;
      };
      try {
        await run.cmd('printersMode', { mode: 'empty' });
        const empty = await run.page('return await window.electron.getPrinters();', 30_000);
        t.check('no printers: getPrinters answers empty system list, the DYMO list intact, no failure', empty.ok && empty.value.system.length === 0 && empty.value.dymo.length === 2 && empty.value.ok === undefined, empty);
        const emptyShot = await openAndShoot('settings-no-printers', 3000);
        t.check('Settings paints with an empty printer list', emptyShot.ok, emptyShot);

        await run.cmd('printersMode', { mode: 'throw' });
        const thrown = await run.page('return await window.electron.getPrinters();', 30_000);
        t.check('the print system failing: a failed Result that still carries both lists', thrown.ok && thrown.value.ok === false && Array.isArray(thrown.value.system) && Array.isArray(thrown.value.dymo) && thrown.value.dymo.length === 2, thrown);
        const thrownShot = await openAndShoot('settings-printers-error', 3000);
        t.check('Settings paints when the system list fails', thrownShot.ok, thrownShot);

        await run.cmd('printersMode', { mode: 'hang' });
        const pending = run.page('return await window.electron.getPrinters();', 120_000).then((answer) => ({ settled: true, answer }), (error) => ({ settled: true, error: error.message }));
        const early = await Promise.race([pending, sleep(15_000).then(() => ({ settled: false }))]);
        t.record('hangedListSettledWithin15s', early.settled);
        t.note(`getPrinters while the operating system never answers: ${early.settled ? 'answered' : 'still pending after 15 s (no timeout in the app)'}`);
        t.check('getPrinters() settles within 15 s even when the operating system never answers (a timeout turns it into a failed Result)', early.settled === true, early);
        const hangShot3 = await openAndShoot('settings-printers-hang-3s', 3000);
        t.check('Settings paints while the list is pending', hangShot3.ok, hangShot3);
        const hangShot20 = await openAndShoot('settings-printers-hang-20s', 20_000);
        t.check('and after 20 s', hangShot20.ok, hangShot20);
        await run.cmd('setConfig', { path: 'printers.receipt', value: { transport: 'system', printerName: 'E2E-Receipt-58', port: '' } });
        const meanwhile = await run.pos('printReceipt');
        t.check('printing a receipt is not blocked by the pending list', meanwhile.result && meanwhile.result.ok === true, meanwhile);
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- F7 the operating system's REAL printer list ------------------------------------------------------------------------------------
  if (wants('F7')) {
    await scenario('F7', 'The REAL operating-system printer list (Electron getPrintersAsync on this Mac): answers quickly, well-formed, 30 at once', async (t) => {
      const { server, run } = await startPrintApp('f7-os-printers', { realPrinters: true });
      try {
        const began = Date.now();
        const answer = await run.page('return await window.electron.getPrinters();', 60_000);
        const ms = Date.now() - began;
        t.record('ms', ms);
        t.check('getPrinters answers', answer.ok && answer.value && Array.isArray(answer.value.system), answer.ok ? Object.keys(answer.value || {}) : answer);
        t.check('within 10 s', ms < 10_000, ms);
        t.check('every entry has a name, a displayName and an isDefault flag', answer.ok && answer.value.system.every((printer) => typeof printer.name === 'string' && printer.name !== '' && typeof printer.displayName === 'string' && typeof printer.isDefault === 'boolean'), answer.ok && answer.value.system.slice(0, 2).map((printer) => Object.keys(printer)));
        t.note(`the real list has ${answer.ok ? answer.value.system.length : '?'} printer(s) and took ${ms} ms`);
        const many = await run.page('const lists = await Promise.all(Array.from({ length: 30 }, () => window.electron.getPrinters())); return lists.map((list) => list.system.length);', 90_000);
        t.check('30 concurrent calls all answer the same number of printers', many.ok && new Set(many.value).size === 1, many);
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await finish(server, run);
      }
    });
  }

  // ---- F8 the REAL hidden DYMO window crashes or is closed ------------------------------------------------------------------------------
  if (wants('F8')) {
    await scenario('F8', 'REAL hidden DYMO window killed (renderer crash) and destroyed: the next call builds a new one and answers, no zombie windows', async (t) => {
      const { server, run } = await startPrintApp('f8-dymo-crash', { realDymo: true });
      const dymoWindows = async () => (await run.cmd('windows')).filter((win) => /dymo-loader\.html/.test(win.url));
      try {
        const first = await run.page('return await window.electron.getPrinters();', 60_000);
        t.check('the first list answers (no DYMO software: a plain dymoError)', first.ok && Array.isArray(first.value.dymo) && typeof first.value.dymoError === 'string', first);
        const created = await dymoWindows();
        t.check('one hidden helper window exists', created.length === 1, created);
        await run.cmd('crashWindow', { id: created[0].id });
        await sleep(1500);
        const began = Date.now();
        const label = await run.pos('printBarcode:dymo', {}, 60_000);
        t.check('a label after the helper window crashed answers a clean DYMO failure', label.result && label.result.ok === false && /^DYMO_/.test(label.result.code), label);
        t.check('within 20 s', Date.now() - began < 20_000, Date.now() - began);
        t.check('and there is still at most one helper window (the dead one was replaced, not kept)', (await dymoWindows()).length <= 1, await dymoWindows());
        const again = await dymoWindows();
        if (again.length === 1) {
          await run.cmd('closeWindow', { id: again[0].id });
          await sleep(500);
        }
        const second = await run.page('return await window.electron.getPrinters();', 60_000);
        t.check('after the helper window was destroyed the list still answers', second.ok && Array.isArray(second.value.dymo), second);
        t.check('exactly one new helper window exists', (await dymoWindows()).length === 1, await dymoWindows());
        t.check('no uncaught exception', (await run.cmd('light')).uncaught.length === 0, (await run.cmd('light')).uncaught);
      } finally {
        await finish(server, run);
      }
    });
  }
}

module.exports = { runPrintGroup };
