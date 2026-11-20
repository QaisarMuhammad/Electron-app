'use strict';

/**
 * Static checks of the two PowerShell scripts. PowerShell is not available where these tests run, so they cannot be
 * executed here; these tests pin the properties that can be verified from the text and that the Node side relies on
 * (parameter names, protocol fields, output discipline, no code built from user values).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const SCRIPTS = {
  'raw-print.ps1': fs.readFileSync(path.join(root, 'scripts', 'raw-print.ps1'), 'utf8'),
  'raw-print-host.ps1': fs.readFileSync(path.join(root, 'scripts', 'raw-print-host.ps1'), 'utf8'),
};

/** Splits a script into its PowerShell text (without comment lines) and the C# text of the single-quoted here-string. */
function parts(text) {
  const match = /\$SpoolerSource = @'\n([\s\S]*?)\n'@\n/.exec(text);
  assert.ok(match, 'the C# source is one single-quoted here-string');
  const powershell = text.replace(match[0], '').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  return { powershell, csharp: match[1] };
}

/** Removes PowerShell string literals so brackets inside them are not counted. */
function withoutStrings(powershell) {
  return powershell.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
}

function balance(text, open, close) {
  let depth = 0;
  for (const char of text) {
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    assert.ok(depth >= 0, `a ${close} closes nothing`);
  }
  return depth;
}

for (const [name, text] of Object.entries(SCRIPTS)) {
  test(`${name}: plain ASCII, LF line ends, final newline (no encoding surprises in Windows PowerShell 5.1)`, () => {
    assert.doesNotMatch(text, /[^\x0a\x20-\x7e]/, 'only printable ASCII and LF (no tabs, no CR, no BOM)');
    assert.ok(text.endsWith('\n'));
  });

  test(`${name}: strict mode, stop on errors, quiet streams, param block first`, () => {
    const { powershell } = parts(text);
    assert.match(powershell, /^param\(/, 'the param block is the first statement');
    assert.match(powershell, /Set-StrictMode -Version 2\.0/);
    assert.match(powershell, /\$ErrorActionPreference = 'Stop'/);
    assert.match(powershell, /\$ProgressPreference = 'SilentlyContinue'/);
    assert.match(powershell, /\$WarningPreference = 'SilentlyContinue'/);
  });

  test(`${name}: no dynamic code, no other programs, no network`, () => {
    const { powershell, csharp } = parts(text);
    const code = `${powershell}\n${csharp}`;
    assert.doesNotMatch(code, /Invoke-Expression|\biex\b|Invoke-Command|Start-Process|-EncodedCommand|ScriptBlock\]::Create|Invoke-WebRequest|Invoke-RestMethod|DownloadString|\bcmd(\.exe)?\b|\bpowershell(\.exe)?\b/i);
    assert.doesNotMatch(code, /(^|[;({])\s*&\s*[$(]|^\s*\.\s+[$(]|\bInvoke-Item\b/m, 'no call operator and no dot-sourcing');
  });

  test(`${name}: the C# source is constant text: single-quoted here-string, no expansion, no user value inside`, () => {
    const { csharp, powershell } = parts(text);
    assert.equal((text.match(/@'\n/g) || []).length, 1, 'one here-string opener');
    assert.equal((text.match(/\n'@\n/g) || []).length, 1, 'one here-string terminator');
    assert.doesNotMatch(text, /@"/, 'no double-quoted here-string (it would expand variables)');
    assert.doesNotMatch(csharp, /[$`]/, 'no PowerShell metacharacters in the C# text');
    const addTypes = powershell.match(/Add-Type[^\n]*/g) || [];
    assert.equal(addTypes.length, 1);
    assert.match(addTypes[0], /^Add-Type -TypeDefinition \$SpoolerSource -Language CSharp -IgnoreWarnings$/);
    assert.doesNotMatch(powershell, /\$SpoolerSource\s*(\+|-f|\.Replace|-replace)/, 'the C# text is never edited');
  });

  test(`${name}: brackets balance in the PowerShell text and in the C# text`, () => {
    const { powershell, csharp } = parts(text);
    const clean = withoutStrings(powershell);
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      assert.equal(balance(clean, open, close), 0, `${open}${close} in PowerShell`);
    }
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      assert.equal(balance(csharp.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, ''), open, close), 0, `${open}${close} in C#`);
    }
  });

  test(`${name}: the C# uses only language features of the C# 5 compiler that Windows PowerShell 5.1 ships`, () => {
    const { csharp } = parts(text);
    assert.doesNotMatch(csharp, /\$"|\?\.|\?\[|=>|nameof\s*\(|out var |is not |using var |\bdefault\s*\(\)|\bvar\b.*=\s*new\s*\(\)/);
  });
}

test('the shared block (C# printing code, JSON helper, print function) is identical in both scripts', () => {
  const pattern = /# BEGIN SHARED[\s\S]*?# END SHARED/;
  const blocks = Object.values(SCRIPTS).map((text) => pattern.exec(text));
  assert.ok(blocks.every(Boolean));
  assert.equal(blocks[0][0], blocks[1][0]);
  assert.ok(blocks[0][0].length > 3000);
});

test('the C# prints one RAW document through winspool.drv, with the SPEC call sequence', () => {
  const { csharp } = parts(SCRIPTS['raw-print.ps1']);
  for (const entry of ['OpenPrinterW', 'StartDocPrinterW']) assert.match(csharp, new RegExp(`EntryPoint = "${entry}"`));
  for (const name of ['StartPagePrinter', 'WritePrinter', 'EndPagePrinter', 'EndDocPrinter', 'ClosePrinter']) {
    assert.match(csharp, new RegExp(`static extern bool ${name}\\(`), name);
  }
  assert.equal((csharp.match(/DllImport\("winspool\.drv"/g) || []).length, 8, 'eight winspool imports (the seven calls and AbortPrinter)');
  assert.match(csharp, /class DOC_INFO_1/);
  assert.match(csharp, /doc\.pDatatype = "RAW";/);
  assert.match(csharp, /StartDocPrinter\(printer, 1, doc\)/, 'DOC_INFO_1 is level 1');
  const order = ['OpenPrinter(printerName', 'StartDocPrinter(printer', 'StartPagePrinter(printer', 'WriteAll(printer', 'EndPagePrinter(printer', 'EndDocPrinter(printer'];
  const positions = order.map((fragment) => csharp.indexOf(fragment, csharp.indexOf('public static int Print')));
  assert.ok(positions.every((position) => position > 0), 'every call is made');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in the documented order');
});

test('WritePrinter is called in a loop until every byte has been written', () => {
  const { csharp } = parts(SCRIPTS['raw-print.ps1']);
  assert.match(csharp, /while \(offset < data\.Length\)/);
  assert.match(csharp, /offset \+= written;/);
  assert.match(csharp, /if \(written <= 0\)/, 'a write that accepts nothing is an error, not an endless loop');
  assert.match(csharp, /out written\)/);
});

test('the printer handle is closed in a finally block, and an unfinished job is aborted', () => {
  const { csharp } = parts(SCRIPTS['raw-print.ps1']);
  const finallyBlocks = csharp.match(/finally\s*\{[\s\S]*?\n {8}\}/g) || [];
  assert.ok(finallyBlocks.some((block) => block.includes('ClosePrinter(printer)')), 'ClosePrinter is in a finally');
  assert.ok(finallyBlocks.some((block) => block.includes('AbortPrinter(printer)')), 'a half-written job is aborted');
  assert.ok(finallyBlocks.some((block) => block.includes('pin.Free()')), 'the pinned buffer is released');
});

test('exit and answer codes are exactly 0, 2, 3, 4 and 5', () => {
  const { csharp, powershell } = parts(SCRIPTS['raw-print.ps1']);
  assert.match(csharp, /public const int Ok = 0;/);
  assert.match(csharp, /public const int NotFound = 2;/);
  assert.match(csharp, /public const int OpenFailed = 3;/);
  assert.match(csharp, /public const int WriteFailed = 4;/);
  const codes = new Set([...powershell.matchAll(/\bCode = (\d+)/g)].map((match) => Number(match[1])));
  assert.deepEqual([...codes].sort(), [0, 5], 'the PowerShell side adds 0 (printed) and 5 (bad arguments); 2, 3 and 4 come from the C# status');
  assert.match(powershell, /\$exitCode = 3/, 'an unexpected failure is "open failed"');
  assert.match(powershell, /exit \$exitCode\s*$/);
});

test('printer names and file paths come only from parameters or command data, and are passed as arguments', () => {
  const oneShot = parts(SCRIPTS['raw-print.ps1']).powershell;
  assert.match(oneShot, /param\(\s*\[string\] \$PrinterName,\s*\[string\] \$FilePath\s*\)/);
  assert.match(oneShot, /Get-RawPrintResult -Name \$PrinterName -Path \$FilePath/);
  const host = parts(SCRIPTS['raw-print-host.ps1']).powershell;
  assert.match(host, /\$name = \[string\] \$command\.printerName/);
  assert.match(host, /\$path = \[string\] \$command\.filePath/);
  assert.match(host, /Get-RawPrintResult -Name \$name -Path \$path/);
  assert.match(host, /\$id = \$command\.id/);
  assert.doesNotMatch(oneShot + host, /(?:\$PrinterName|\$FilePath|\$name|\$path)\s*(\+|-f\b)/, 'a user value is never concatenated');
});

test('the one-shot script writes exactly one line to stdout and nothing else', () => {
  const { powershell } = parts(SCRIPTS['raw-print.ps1']);
  assert.equal((powershell.match(/\[Console\]::Out\.WriteLine/g) || []).length, 1);
  assert.doesNotMatch(powershell, /Write-Host|Write-Output|Write-Verbose|Write-Warning|Write-Error|Write-Debug|Out-Host|Out-Default|\becho\b|Read-Host/i);
  assert.match(powershell, /\[Console\]::Out\.WriteLine\(\(Format-Answer -Id \$null -Code \$exitCode -Text \$message\)\)\nexit \$exitCode/);
});

test('every helper statement that returns a value is captured, so nothing leaks into stdout', () => {
  const { powershell } = parts(SCRIPTS['raw-print.ps1']);
  const builderCalls = powershell.match(/\$builder\.(Append|AppendFormat)\(/g) || [];
  const voided = powershell.match(/\[void\] \$builder\.(Append|AppendFormat)\(/g) || [];
  assert.equal(builderCalls.length, voided.length);
});

test('the host script follows the line protocol the Node side speaks', () => {
  const { powershell } = parts(SCRIPTS['raw-print-host.ps1']);
  const ready = powershell.indexOf(`$writer.WriteLine('{"ready":true}')`);
  const loop = powershell.indexOf('while ($true)');
  const typeLoad = powershell.indexOf('Add-Type');
  assert.ok(typeLoad > 0 && ready > typeLoad, 'ready is announced only after the printing component loaded');
  assert.ok(loop > ready, 'commands are read only after ready');
  assert.match(powershell, /New-Object System\.Text\.UTF8Encoding\(\$false\)/, 'UTF-8 without a BOM');
  assert.match(powershell, /New-Object System\.IO\.StreamReader\(\[Console\]::OpenStandardInput\(\), \$utf8\)/);
  assert.match(powershell, /New-Object System\.IO\.StreamWriter\(\[Console\]::OpenStandardOutput\(\), \$utf8\)/);
  assert.match(powershell, /\$writer\.AutoFlush = \$true/);
  assert.match(powershell, /\$reader\.ReadLine\(\)/);
  assert.match(powershell, /if \(\$null -eq \$line\) \{ break \}/, 'the host ends when stdin is closed');
  assert.match(powershell, /\$line \| ConvertFrom-Json/);
  assert.match(powershell, /\$writer\.WriteLine\(\(Format-Answer -Id \$id -Code \$code -Text \$message\)\)/);
  assert.match(powershell, /exit 3\n\}/, 'a printing component that cannot load ends the host with code 3');
  assert.match(powershell, /exit 0\s*$/);
});

test('every answer line of the host carries id, ok, code and message', () => {
  const { powershell } = parts(SCRIPTS['raw-print-host.ps1']);
  const format = /return '\{"id":' \+ \$idText \+ ',"ok":' \+ \$okText \+ ',"code":' \+ \$Code \+ ',"message":' \+ \(ConvertTo-AsciiJsonString -Text \$Text\) \+ '\}'/;
  assert.match(powershell, format);
});

test('the JSON text of an answer is escaped to printable ASCII (quote, backslash and everything outside 32-126)', () => {
  const { powershell } = parts(SCRIPTS['raw-print.ps1']);
  assert.match(powershell, /\$code -eq 34\) \{ \[void\] \$builder\.Append\('\\"'\) \}/);
  assert.match(powershell, /\$code -eq 92\) \{ \[void\] \$builder\.Append\('\\\\'\) \}/);
  assert.match(powershell, /\$code -lt 32 -or \$code -gt 126\) \{ \[void\] \$builder\.AppendFormat\('\\u\{0:x4\}', \$code\) \}/);
});

test('the Node side starts exactly these two scripts with exactly these parameter names', () => {
  const spooler = fs.readFileSync(path.join(root, 'src', 'main', 'printing', 'transports', 'win32-spooler.js'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'raw-print.ps1')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'raw-print-host.ps1')));
  assert.match(spooler, /'scripts', 'raw-print\.ps1'/);
  assert.match(spooler, /'scripts', 'raw-print-host\.ps1'/);
  assert.match(spooler, /'-PrinterName', printerName, '-FilePath', filePath/);
});
