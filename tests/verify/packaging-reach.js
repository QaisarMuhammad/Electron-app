#!/usr/bin/env node
'use strict';

/**
 * Independent packaging reachability check (verification script, read-only; not a unit test, so `node --test` never runs it).
 *
 *   node tests/verify/packaging-reach.js [projectRoot]            human summary, exit code 1 when something is missing
 *   node tests/verify/packaging-reach.js [projectRoot] --json     machine readable
 *
 * What it does, with a real JavaScript parser (acorn) instead of the regular expressions of tests/packaging/manifest.test.js:
 *   1. emulates electron-builder 24.13.3's main file set for `build.files` (the same patterns, the same minimatch options and the
 *      same "first include, then exclude" rule as app-builder-lib/out/fileMatcher.js) and its `asarUnpack` filter;
 *   2. follows every require() / import() / import-from of src/main/index.js (and of every file it reaches) with Node's own resolver;
 *   3. follows every <script>/<link>/<img>/srcset of the renderer pages and every import of the renderer modules;
 *   4. collects every string literal under src that looks like a file name and checks the file is in the installer;
 *   5. lists what the installer carries that nothing references (dead weight).
 *
 * Names that Electron, the DYMO helper page or PowerShell load by themselves (icons, the DYMO framework, the two print scripts) are
 * listed in `loadedByElectron` below; they were read from windows/main.js, renderer/dymo-loader.html and transports/win32-spooler.js.
 *
 * It needs `acorn` and `minimatch` (both resolved from <projectRoot>/node_modules; electron-builder brings minimatch, acorn is not
 * a declared dependency, so run it before pruning node_modules or install acorn temporarily).
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const args = require.main === module ? process.argv.slice(2) : [];
const ROOT = path.resolve(args.find((arg) => !arg.startsWith('--')) || process.env.GPOS_PACKAGING_ROOT || path.join(__dirname, '..', '..'));
const AS_JSON = args.includes('--json');

const fromRoot = (name) => require(require.resolve(name, { paths: [ROOT] }));
const { Minimatch } = fromRoot('minimatch'); // brought by electron-builder (app-builder-lib)
let acornModule = null;
/** acorn is loaded only when a file is parsed, so requiring this module for its file filter (packaging-installed-layout.js) does not need it. */
const getAcorn = () => acornModule || (acornModule = fromRoot('acorn'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const posix = (file) => file.split(path.sep).join('/');
const abs = (relative) => path.join(ROOT, relative);
const exists = (relative) => fs.existsSync(abs(relative));

/**
 * True when every segment of the project-relative path has exactly the spelling of the directory entry. macOS and Windows file
 * systems ignore case, so fs.existsSync() says yes to `Settings.js` for `settings.js`; inside app.asar every lookup is case
 * sensitive on every platform, so such a reference loads in development and crashes in the installed app.
 */
function existsExact(relative) {
  let dir = ROOT;
  for (const segment of relative.split('/').filter(Boolean)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}
const caseProblems = [];
const checkCase = (from, spec, target) => {
  if (exists(target) && !existsExact(target)) caseProblems.push({ from, spec, target });
};

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. electron-builder's file filter (app-builder-lib 24.13.3: fileMatcher.js getMainFileMatchers + util/filter.js)
// ---------------------------------------------------------------------------------------------------------------------------------

const EXCLUDED_NAMES = '.git,.hg,.svn,CVS,RCS,SCCS,__pycache__,.DS_Store,thumbs.db,.gitignore,.gitkeep,.gitattributes,.npmignore,.idea,.vs,.flowconfig,.jshintrc,.eslintrc,.circleci,.yarn-integrity,.yarn-metadata.json,yarn-error.log,yarn.lock,package-lock.json,npm-debug.log,appveyor.yml,.travis.yml,circle.yml,.nyc_output,.husky,.github,electron-builder.env';
const EXCLUDED_EXTS = 'iml,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,suo,xproj,cc,d.ts,mk,a,o,forge-meta';
const MINIMATCH = { dot: true };

function hasMagic(matcher) {
  if (matcher.set.length > 1) return true;
  return matcher.set[0].some((part) => typeof part !== 'string');
}

/** Turns a list of electron-builder patterns into `(relativePosixPath, isDirectory) => boolean` (createFilter + minimatchAll). */
function createFilter(patterns) {
  const parsed = [];
  for (const raw of patterns) {
    const pattern = path.posix.normalize(raw.replace(/\\/g, '/').replace(/^\.\//, ''));
    const matcher = new Minimatch(pattern, MINIMATCH);
    parsed.push(matcher);
    if (!pattern.includes('.') && !hasMagic(matcher)) parsed.push(new Minimatch(`${pattern}/**/*`, MINIMATCH));
  }
  return (relative, isDirectory) => {
    let match = false;
    for (const pattern of parsed) {
      if (match !== pattern.negate) continue;
      match = pattern.match(relative, isDirectory && !pattern.negate);
    }
    return match;
  };
}

/** The main matcher's pattern list for this package.json, in electron-builder's order. */
function mainPatterns() {
  const user = [...pkg.build.files];
  if (!user.includes('package.json')) user.push('package.json');
  const outDir = (pkg.build.directories && pkg.build.directories.output) || 'dist';
  user.push(`!${outDir}/*-unpacked{,/**/*}`);
  const first = ['!**/node_modules', '!build{,/**/*}', `!${outDir}{,/**/*}`];
  const patterns = [...first, ...user];
  patterns.push(`!**/*.{${EXCLUDED_EXTS},pdb}`, '!**/._*', '!**/electron-builder.{yaml,yml,json,json5,toml,ts}', `!**/{${EXCLUDED_NAMES}}`, '!.yarn{,/**/*}', '!.editorconfig', '!.yarnrc.yml');
  return patterns;
}

/** Every file electron-builder would put into app.asar from the project folder (node_modules are a separate file set). */
function walkMainFileSet() {
  const accept = createFilter(mainPatterns());
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(abs(dir || '.'), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      if (!accept(relative, isDirectory)) continue;
      if (isDirectory) visit(relative);
      else files.push(relative);
    }
  };
  visit('');
  return files;
}

const unpackFilter = createFilter(pkg.build.asarUnpack || []);

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. JavaScript scanning
// ---------------------------------------------------------------------------------------------------------------------------------

function parseSource(relative) {
  const source = fs.readFileSync(abs(relative), 'utf8');
  const wantModule = relative.endsWith('.mjs');
  const options = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true };
  try {
    return getAcorn().parse(source, { ...options, sourceType: wantModule ? 'module' : 'script' });
  } catch (error) {
    if (wantModule) throw error;
    return getAcorn().parse(source, { ...options, sourceType: 'module' }); // a renderer script that uses import/export
  }
}

function visit(node, callback) {
  if (!node || typeof node.type !== 'string') return;
  callback(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => visit(item, callback));
    else if (child && typeof child.type === 'string') visit(child, callback);
  }
}

const literalString = (node) => {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

/** @returns {{ specs: {spec: string, kind: string, line: number}[], dynamic: {kind: string, line: number}[], strings: string[] }} */
function scan(relative) {
  const ast = parseSource(relative);
  const specs = [];
  const dynamic = [];
  const strings = [];
  visit(ast, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    if (node.type === 'TemplateLiteral') node.quasis.forEach((quasi) => strings.push(quasi.value.cooked));
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const isRequire = callee.type === 'Identifier' && callee.name === 'require';
      const isResolve = callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'require' && callee.property.name === 'resolve';
      if (isRequire || isResolve) {
        const spec = literalString(node.arguments[0]);
        if (spec === null) dynamic.push({ kind: isResolve ? 'require.resolve' : 'require', line: node.loc ? node.loc.start.line : 0 });
        else specs.push({ spec, kind: isResolve ? 'require.resolve' : 'require', line: 0 });
      }
    }
    if (node.type === 'ImportExpression') {
      const spec = literalString(node.source);
      if (spec === null) dynamic.push({ kind: 'import()', line: 0 });
      else specs.push({ spec, kind: 'import()', line: 0 });
    }
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source) {
      specs.push({ spec: node.source.value, kind: 'import-from', line: 0 });
    }
  });
  return { specs, dynamic, strings };
}

const BUILTINS = new Set(Module.builtinModules);
const packageRoot = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** Node's own resolution for a relative specifier; null when it does not resolve to a project file. */
function resolveRelative(fromRelative, spec) {
  try {
    const resolved = Module.createRequire(abs(fromRelative)).resolve(spec);
    return posix(path.relative(ROOT, resolved));
  } catch {
    // ESM-only or extension-less specifiers (renderer modules): try the plain candidates
    const base = path.join(path.dirname(abs(fromRelative)), spec);
    const candidate = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    return candidate ? posix(path.relative(ROOT, candidate)) : null;
  }
}

/** The main-process graph: every project file reachable from `main` by require/import, the packages named on the way, and what failed. */
function crawlMain(entry) {
  const files = new Set();
  const packages = new Map(); // name -> set of requiring files
  const unresolved = [];
  const dynamic = [];
  const strings = new Map(); // file -> strings
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(c|m)?js$/.test(file)) continue;
    const found = scan(file);
    strings.set(file, found.strings);
    for (const item of found.dynamic) dynamic.push({ file, ...item });
    for (const { spec, kind } of found.specs) {
      if (spec.startsWith('node:') || BUILTINS.has(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolveRelative(file, spec);
        if (target === null) unresolved.push({ file, spec, kind });
        else {
          checkCase(file, spec, target);
          queue.push(target);
        }
      } else {
        const name = packageRoot(spec);
        if (!packages.has(name)) packages.set(name, new Set());
        packages.get(name).add(file);
      }
    }
  }
  return { files, packages, unresolved, dynamic, strings };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Renderer pages: HTML references, CSS url()/@import and the ES module graph
// ---------------------------------------------------------------------------------------------------------------------------------

function crawlRenderer() {
  const files = new Set();
  const missing = [];
  const external = [];
  const add = (from, spec) => {
    if (/^(https?:|data:|blob:|mailto:|tel:|#)/.test(spec)) {
      if (!spec.startsWith('#') && !spec.startsWith('data:')) external.push({ from, spec });
      return;
    }
    const clean = spec.split(/[?#]/)[0];
    if (clean === '') return;
    const target = posix(path.normalize(path.join(path.dirname(from), clean)));
    if (files.has(target)) return;
    if (!exists(target)) {
      missing.push({ from, spec, target });
      return;
    }
    checkCase(from, spec, target);
    files.add(target);
    if (/\.(css)$/.test(target)) cssRefs(target);
    else if (/\.(m?js)$/.test(target)) jsRefs(target);
  };
  const cssRefs = (file) => {
    const css = fs.readFileSync(abs(file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) add(file, match[1]);
    for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(file, match[1]);
  };
  const jsRefs = (file) => {
    const found = scan(file);
    for (const { spec } of found.specs) {
      if (spec.startsWith('.') || spec.startsWith('/')) add(file, spec);
      else if (!BUILTINS.has(spec) && !spec.startsWith('node:')) missing.push({ from: file, spec, target: `(bare package specifier in a renderer module)` });
    }
    // new URL('./x', import.meta.url) and fetch('./x') literals
    for (const text of found.strings) if (/^\.{1,2}\/.+\.(css|js|mjs|json|png|svg|jpg|ico|woff2?)$/.test(text)) add(file, text);
  };
  const pages = fs.readdirSync(abs('src/renderer')).filter((name) => name.endsWith('.html')).map((name) => `src/renderer/${name}`);
  for (const page of pages) {
    files.add(page);
    const html = fs.readFileSync(abs(page), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*"([^"]*)"/g)) add(page, match[1]);
    for (const match of html.matchAll(/\bsrcset\s*=\s*"([^"]*)"/g)) for (const candidate of match[1].split(',')) add(page, candidate.trim().split(/\s+/)[0]);
    for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const url of match[1].matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(page, url[1]);
    if (/<script(?![^>]*\bsrc=)[^>]*>[^<\s]/i.test(html)) missing.push({ from: page, spec: '(inline script)', target: 'inline scripts break the CSP' });
  }
  return { files, missing, external, pages };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Path-like string literals in the main process and the preloads
// ---------------------------------------------------------------------------------------------------------------------------------

const FILE_LIKE = /^[\w@./\\ -]+\.(html|js|mjs|cjs|css|png|svg|jpg|jpeg|ico|icns|dymo|ps1|json|yml|yaml|pdf|txt|md)$/i;

function literalPathReferences(mainStrings) {
  const refs = [];
  for (const [file, list] of mainStrings) {
    for (const text of list) if (FILE_LIKE.test(text.trim())) refs.push({ file, text: text.trim() });
  }
  // preloads are not in the require graph (Electron loads them)
  for (const preload of fs.readdirSync(abs('src/preload')).map((name) => `src/preload/${name}`)) {
    for (const text of scan(preload).strings) if (FILE_LIKE.test(text.trim())) refs.push({ file: preload, text: text.trim() });
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------------------------------

module.exports = { ROOT, pkg, createFilter, mainPatterns, walkMainFileSet, unpackFilter, existsExact, posix };

function main() {
  const asarFiles = walkMainFileSet();
  const inInstaller = new Set(asarFiles);
  const graph = crawlMain(posix(pkg.main));
  const preloads = fs.readdirSync(abs('src/preload')).map((name) => `src/preload/${name}`);
  const preloadRequires = preloads.flatMap((file) => scan(file).specs.map((item) => ({ file, ...item })));
  const renderer = crawlRenderer();

  // the files Electron itself loads from names in the code (windows, DYMO page, preloads, icons, label templates)
  const labelTemplates = new Set();
  try {
    const collect = (value) => {
      if (typeof value === 'string') labelTemplates.add(`labels/${value}`);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(require(abs('src/main/printing/dymo/plan.js')).TEMPLATES);
  } catch (error) {
    labelTemplates.add(`(could not load plan.js: ${error.message})`);
  }
  const loadedByElectron = new Set([
    ...preloads,
    ...renderer.files,
    ...labelTemplates,
    'assets/icon.ico',
    'assets/icon.png', // BrowserWindow icon on Windows / Linux (windows/main.js resolveWindowIcon)
    'assets/dymo.connect.framework.js', // loaded by src/renderer/dymo-loader.html
    'scripts/raw-print.ps1',
    'scripts/raw-print-host.ps1', // started by transports/win32-spooler.js
    'package.json',
  ]);

  for (const file of loadedByElectron) if (exists(file) && !existsExact(file)) caseProblems.push({ from: '(loaded by Electron by name)', spec: file, target: file });
  checkCase('package.json', 'main', posix(pkg.main));
  const lowerSeen = new Map();
  const caseCollisions = [];
  for (const file of asarFiles) {
    const key = file.toLowerCase();
    if (lowerSeen.has(key)) caseCollisions.push([lowerSeen.get(key), file]);
    else lowerSeen.set(key, file);
  }

  const reachable = new Set([...graph.files, ...loadedByElectron]);
  const missingFromInstaller = [...reachable].filter((file) => !inInstaller.has(file));
  const nonexistent = [...reachable].filter((file) => !exists(file));
  const unreferenced = asarFiles.filter((file) => !reachable.has(file));

  const declared = new Set(Object.keys(pkg.dependencies || {}));
  const packageProblems = [];
  for (const [name] of graph.packages) if (name !== 'electron' && !declared.has(name)) packageProblems.push(`${name} is required but not in dependencies`);
  for (const name of declared) if (!graph.packages.has(name)) packageProblems.push(`${name} is declared but never required under the main-process graph`);

  const literalRefs = literalPathReferences(graph.strings);
  const literalProblems = [];
  for (const ref of literalRefs) {
    const base = path.posix.basename(ref.text);
    const candidates = [ref.text, ...asarFiles.filter((file) => file.endsWith(`/${ref.text}`) || path.posix.basename(file) === base)];
    if (!candidates.some((candidate) => inInstaller.has(candidate))) literalProblems.push(ref);
  }

  const sizeOf = (file) => fs.statSync(abs(file)).size;
  const total = (files) => files.reduce((sum, file) => sum + sizeOf(file), 0);
  const byTop = {};
  for (const file of asarFiles) {
    const top = file.includes('/') ? file.split('/')[0] : '(root)';
    byTop[top] = byTop[top] || { files: 0, bytes: 0 };
    byTop[top].files += 1;
    byTop[top].bytes += sizeOf(file);
  }

  const report = {
    root: ROOT,
    builderPatterns: mainPatterns(),
    asar: { files: asarFiles.length, bytes: total(asarFiles), byTop, unpacked: asarFiles.filter((file) => unpackFilter(file, false)) },
    mainGraph: { files: [...graph.files].sort(), packages: [...graph.packages.entries()].map(([name, by]) => ({ name, usedBy: [...by].sort() })), unresolved: graph.unresolved, dynamic: graph.dynamic },
    preloadRequires: preloadRequires.filter((item) => !(item.spec === 'electron')),
    renderer: { pages: renderer.pages, files: [...renderer.files].sort(), missing: renderer.missing, external: renderer.external },
    labelTemplates: [...labelTemplates].sort(),
    missingFromInstaller,
    nonexistent,
    unreferenced: unreferenced.map((file) => ({ file, bytes: sizeOf(file) })),
    packageProblems,
    literalProblems,
    caseProblems,
    caseCollisions,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
    console.log(`root: ${ROOT}`);
    console.log(`emulated app.asar (project folder part): ${report.asar.files} files, ${kb(report.asar.bytes)}`);
    for (const [top, info] of Object.entries(byTop)) console.log(`  ${top.padEnd(10)} ${String(info.files).padStart(4)} files ${kb(info.bytes).padStart(10)}`);
    console.log(`unpacked by asarUnpack: ${report.asar.unpacked.join(', ') || '(none)'}`);
    console.log(`main-process graph: ${graph.files.size} project files; packages: ${[...graph.packages.keys()].join(', ')}`);
    console.log(`  unresolved requires: ${graph.unresolved.length}   dynamic (non-literal) requires: ${graph.dynamic.length}`);
    for (const item of graph.unresolved) console.log(`    UNRESOLVED ${item.file}: ${item.kind}('${item.spec}')`);
    for (const item of graph.dynamic) console.log(`    DYNAMIC ${item.file}: ${item.kind}`);
    console.log(`preload files: ${preloads.join(', ')}; their requires other than electron: ${report.preloadRequires.length}`);
    console.log(`renderer: ${renderer.pages.length} pages, ${renderer.files.size} files reached; missing: ${renderer.missing.length}; external urls: ${renderer.external.length}`);
    for (const item of renderer.missing) console.log(`    MISSING ${item.from} -> ${item.spec} (${item.target})`);
    for (const item of renderer.external) console.log(`    EXTERNAL ${item.from} -> ${item.spec}`);
    console.log(`label templates chosen by the code: ${labelTemplates.size}`);
    console.log(`reachable files not in the installer: ${missingFromInstaller.length}   reachable files that do not exist: ${nonexistent.length}`);
    for (const file of missingFromInstaller) console.log(`    NOT IN INSTALLER ${file}`);
    for (const file of nonexistent) console.log(`    NONEXISTENT ${file}`);
    console.log(`exact-case problems (a reference whose spelling differs from the file on disk): ${caseProblems.length}   case-only name collisions in the installer: ${caseCollisions.length}`);
    for (const item of caseProblems) console.log(`    CASE ${item.from}: '${item.spec}' -> ${item.target}`);
    for (const pair of caseCollisions) console.log(`    COLLISION ${pair.join(' <-> ')}`);
    console.log(`package problems: ${packageProblems.length}`);
    for (const text of packageProblems) console.log(`    ${text}`);
    console.log(`file-name literals in src with no matching installer file: ${literalProblems.length}`);
    for (const ref of literalProblems) console.log(`    ${ref.file}: "${ref.text}"`);
    console.log(`installer files nothing references: ${unreferenced.length} (${kb(unreferenced.reduce((sum, file) => sum + sizeOf(file), 0))})`);
    for (const file of unreferenced) console.log(`    ${file} (${kb(sizeOf(file))})`);
  }

  process.exitCode = caseProblems.length + caseCollisions.length + missingFromInstaller.length + nonexistent.length + graph.unresolved.length + graph.dynamic.length + renderer.missing.length + renderer.external.length > 0 ? 1 : 0;

}

if (require.main === module) main();
