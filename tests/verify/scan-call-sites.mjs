// Throwaway: AST scan of every sendReceipt( / sendLabel( / openCashDrawer( call in the vendor worktree, with the keys of the object literal passed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const WEB = '/Users/muhammadqaisar/Documents/projects/donesol/DGshop_vendor-labelprint';
const require = createRequire(path.join(WEB, 'package.json'));
const { parse } = require('@babel/parser');
const walkDir = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out); else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
};
const files = [...walkDir(path.join(WEB, 'src')), ...walkDir(path.join(WEB, 'pages'))].filter((f) => !f.includes('__tests__'));
const names = new Set(['sendReceipt', 'sendLabel', 'openCashDrawer']);
const rows = [];
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  if (!/sendReceipt|sendLabel|openCashDrawer/.test(code)) continue;
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); } catch (e) { rows.push({ file, error: String(e.message) }); continue; }
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name)) {
      const arg = node.arguments[0];
      let keys = null;
      if (arg && arg.type === 'ObjectExpression') keys = arg.properties.map((p) => (p.type === 'SpreadElement' ? '...' + code.slice(p.argument.start, p.argument.end) : (p.key.name || p.key.value)));
      else if (arg) keys = ['<' + arg.type + ':' + code.slice(arg.start, arg.end).slice(0, 40) + '>'];
      rows.push({ file: path.relative(WEB, file), line: node.loc.start.line, fn: node.callee.name, awaited: false, keys });
    }
    for (const k of Object.keys(node)) {
      const c = node[k];
      if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === 'string') visit(c);
    }
  };
  visit(ast.program);
}
for (const r of rows) console.log(JSON.stringify(r));
console.log('TOTAL', rows.length);
