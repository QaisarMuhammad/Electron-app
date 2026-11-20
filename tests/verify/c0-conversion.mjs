// contract-matrix, part 0: no call site of the legacy desktop functions is left unconverted in the web worktree, and every original call has its twin.
// Run: NODE_NO_WARNINGS=1 node --test tests/verify/c0-conversion.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WEB, babelParse } from './_kit.mjs';

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs|cjs|tsx?|json|html|md)$/.test(entry.name)) out.push(full);
  }
  return out;
};
const rel = (file) => path.relative(WEB, file);
const isUtil = (file) => rel(file).startsWith('src/utils/desktop/');
const isTest = (file) => rel(file).includes('__tests__');

const sources = [...walk(path.join(WEB, 'src')), ...walk(path.join(WEB, 'pages'))].filter((f) => !isTest(f));
const read = (file) => fs.readFileSync(file, 'utf8');

test('no file outside src/utils/desktop mentions the three legacy functions at all (calls, aliases, strings)', () => {
  const hits = [];
  for (const file of sources) {
    if (isUtil(file)) continue;
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (/sendReceiptData|sendBarcodeData|sendOpenDrawerCommand/.test(line)) hits.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  // comments that merely NAME the old function are fine; a code line is not
  const code = hits.filter((h) => !/^[^:]+:\d+:\s*(\/\/|\*|\/\*)/.test(h));
  console.log('mentions outside the util (comments included):\n' + hits.map((h) => '  ' + h).join('\n'));
  assert.deepEqual(code, [], 'a code line outside the util still names a legacy function');
});

test('every `window.electron` in the web app outside the util is a presence check (no property of it is touched)', () => {
  const touched = [];
  const checks = [];
  for (const file of sources.filter((f) => /\.(jsx?|mjs)$/.test(f))) {
    if (isUtil(file)) continue;
    const code = read(file);
    if (!/electron/.test(code)) continue;
    let ast;
    try {
      ast = babelParse(code, { sourceType: 'module', plugins: ['jsx'] });
    } catch (error) {
      assert.fail(`cannot parse ${rel(file)}: ${error.message}`);
    }
    const visit = (node, parent) => {
      if (!node || typeof node.type !== 'string') return;
      const isElectron = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
        && n.object && n.object.type === 'Identifier' && n.object.name === 'window'
        && ((!n.computed && n.property.name === 'electron') || (n.computed && n.property.value === 'electron'));
      if (isElectron(node)) {
        const where = `${rel(file)}:${node.loc.start.line}`;
        const parentIsMember = parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node;
        if (parentIsMember) touched.push(`${where}: window.electron.${parent.property.name || parent.property.value}`);
        else checks.push(where);
      }
      // aliasing: `const x = window.electron`, `const { a } = window.electron`
      if (node.type === 'VariableDeclarator' && isElectron(node.init)) touched.push(`${rel(file)}:${node.loc.start.line}: aliased`);
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => visit(c, node));
        else if (child && typeof child.type === 'string') visit(child, node);
      }
    };
    visit(ast.program, null);
  }
  console.log(`presence checks: ${checks.length}; property touches: ${touched.length}`);
  assert.deepEqual(touched, []);
});

test('the number of calls of the desktop in each file equals the number of direct calls it had at origin/main (nothing dropped, nothing added)', () => {
  const originalFiles = execFileSync('git', ['-C', WEB, 'grep', '-l', '-E', 'window\\.electron\\.(sendReceiptData|sendBarcodeData|sendOpenDrawerCommand)\\(|deliver = send \\|\\|', 'origin/main', '--', 'src', 'pages'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => l.replace(/^origin\/main:/, '')).filter((f) => !f.includes('__tests__'));
  const rows = [];
  for (const file of originalFiles) {
    const before = execFileSync('git', ['-C', WEB, 'show', `origin/main:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const nBefore = (before.match(/window\.electron\.(sendReceiptData|sendBarcodeData|sendOpenDrawerCommand)\(/g) || []).length
      + (before.includes('window.electron.sendBarcodeData(payload)') && file.endsWith('labItemLabel.js') ? 0 : 0);
    const now = read(path.join(WEB, file));
    const nNow = (now.match(/\b(sendReceipt|sendLabel|openCashDrawer)\(/g) || []).length;
    rows.push({ file, before: nBefore, now: nNow, deliverDefault: file.endsWith('labItemLabel.js') });
  }
  console.log(rows.map((r) => `  ${r.file}: before ${r.before}, now ${r.now}`).join('\n'));
  for (const row of rows) {
    if (row.deliverDefault) continue; // labItemLabel.js: the old default `send` was an arrow, the new one is `sendLabel` itself
    // cashDrawerForm: its handler named openCashDrawer({ password }) is the call; the arrow is `handleOpenCashDrawer`
    assert.equal(row.now, row.before, `${row.file}: ${row.before} direct calls before, ${row.now} util calls now`);
  }
  assert.ok(rows.length >= 29, 'the original call sites were found');
});

test('every direct reader of window.electron in the original tree that CALLED a function is gone: the only callers are in src/utils/desktop/bridge.js', () => {
  const bridge = read(path.join(WEB, 'src/utils/desktop/bridge.js'));
  assert.match(bridge, /electron\(\)\[name\]\(\.\.\.args\)/);
  assert.match(bridge, /return electron\(\)\[name\]\(\.\.\.args\)/);
  // and nothing else in src calls window.electron.<fn>(
  const direct = [];
  for (const file of sources) {
    if (isUtil(file)) continue;
    if (/window\??\.electron\??\.[A-Za-z]+\??\(/.test(read(file))) direct.push(rel(file));
  }
  assert.deepEqual(direct, []);
});

test('no destructured, computed or global-object access to the desktop bridge outside the util (the AST test above only sees `window.electron.x`)', () => {
  const hits = [];
  const patterns = [/\{[^}]*\belectron\b[^}]*\}\s*=\s*(window|globalThis|self)\b/, /\b(globalThis|self)\s*\.\s*electron\b/, /\bwindow\s*\[\s*["'`]elec/, /\bwindow\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*\.\s*(send|print|open)/, /\bReflect\.get\(\s*window/];
  for (const file of sources) {
    if (isUtil(file)) continue;
    const code = read(file);
    for (const pattern of patterns) if (pattern.test(code)) hits.push(`${rel(file)}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
});
