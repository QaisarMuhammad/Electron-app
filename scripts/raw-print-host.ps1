# GadgetsPOS RAW print host (many print jobs, one process). Windows PowerShell 5.1.
#
# Started once by the app and kept running. Protocol, one JSON object per line:
#   stdout, once, when ready:  {"ready":true}
#   stdin,  one per job:       {"id":1,"printerName":"EPSON TM-T20","filePath":"C:\\Temp\\gpos-1.bin"}
#   stdout, one per job:       {"id":1,"ok":true,"code":0,"message":""}
# Codes: 0 printed, 2 printer not found, 3 open failed or unexpected error, 4 write failed, 5 bad command or arguments.
# The printer name is JSON data read from the command; it is never part of any code text.
# The host ends when stdin is closed. If the printing component cannot be loaded it writes to stderr and exits with 3.
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# BEGIN SHARED: identical in raw-print.ps1 and raw-print-host.ps1 (tests/printing/scripts.test.js checks it)
# The printing code is a constant C# source text. Nothing the caller passes is ever added to it.
$SpoolerSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class GposRawPrinter
{
    public const int Ok = 0;
    public const int NotFound = 2;
    public const int OpenFailed = 3;
    public const int WriteFailed = 4;

    private const int ChunkBytes = 65536;
    private const int ErrorFileNotFound = 2;
    private const int ErrorWriteFault = 29;
    private const int ErrorInvalidName = 123;
    private const int ErrorInvalidPrinterName = 1801;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOC_INFO_1 docInfo);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool AbortPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    private static bool IsNotFound(int win32Error)
    {
        return win32Error == ErrorFileNotFound || win32Error == ErrorInvalidName || win32Error == ErrorInvalidPrinterName;
    }

    private static int Fail(int status, out int win32Error)
    {
        win32Error = Marshal.GetLastWin32Error();
        return status;
    }

    // WritePrinter may accept fewer bytes than offered, so write until every byte has gone.
    private static int WriteAll(IntPtr printer, byte[] data, out int win32Error)
    {
        win32Error = 0;
        GCHandle pin = GCHandle.Alloc(data, GCHandleType.Pinned);
        try
        {
            long start = pin.AddrOfPinnedObject().ToInt64();
            int offset = 0;
            while (offset < data.Length)
            {
                int written;
                int chunk = Math.Min(data.Length - offset, ChunkBytes);
                if (!WritePrinter(printer, new IntPtr(start + offset), chunk, out written))
                {
                    return Fail(WriteFailed, out win32Error);
                }
                if (written <= 0)
                {
                    win32Error = ErrorWriteFault;
                    return WriteFailed;
                }
                offset += written;
            }
            return Ok;
        }
        finally
        {
            pin.Free();
        }
    }

    // Sends the bytes as one RAW document. Returns Ok, NotFound, OpenFailed or WriteFailed.
    public static int Print(string printerName, byte[] data, string documentName, out int win32Error)
    {
        win32Error = 0;
        IntPtr printer = IntPtr.Zero;
        bool opened = false;
        bool docStarted = false;
        bool pageStarted = false;
        try
        {
            if (!OpenPrinter(printerName, out printer, IntPtr.Zero))
            {
                int openError = Marshal.GetLastWin32Error();
                win32Error = openError;
                return IsNotFound(openError) ? NotFound : OpenFailed;
            }
            opened = true;

            DOC_INFO_1 doc = new DOC_INFO_1();
            doc.pDocName = documentName;
            doc.pOutputFile = null;
            doc.pDatatype = "RAW";
            if (StartDocPrinter(printer, 1, doc) == 0)
            {
                return Fail(OpenFailed, out win32Error);
            }
            docStarted = true;

            if (!StartPagePrinter(printer))
            {
                return Fail(OpenFailed, out win32Error);
            }
            pageStarted = true;

            int status = WriteAll(printer, data, out win32Error);
            if (status != Ok)
            {
                return status;
            }

            pageStarted = false;
            if (!EndPagePrinter(printer))
            {
                return Fail(WriteFailed, out win32Error);
            }
            docStarted = false;
            if (!EndDocPrinter(printer))
            {
                return Fail(WriteFailed, out win32Error);
            }
            return Ok;
        }
        finally
        {
            if (opened)
            {
                // A job that did not finish must not be left half-written in the queue.
                if (pageStarted || docStarted)
                {
                    AbortPrinter(printer);
                }
                ClosePrinter(printer);
            }
        }
    }

    public static string Describe(int win32Error)
    {
        return new Win32Exception(win32Error).Message;
    }
}
'@

# JSON text with every character outside printable ASCII written as a \uXXXX escape, so the console code page never matters.
function ConvertTo-AsciiJsonString {
    param([string] $Text)

    $builder = New-Object System.Text.StringBuilder
    [void] $builder.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int] $ch
        if ($code -eq 34) { [void] $builder.Append('\"') }
        elseif ($code -eq 92) { [void] $builder.Append('\\') }
        elseif ($code -lt 32 -or $code -gt 126) { [void] $builder.AppendFormat('\u{0:x4}', $code) }
        else { [void] $builder.Append($ch) }
    }
    [void] $builder.Append('"')
    return $builder.ToString()
}

# One machine-readable answer line: {"id":..,"ok":..,"code":..,"message":".."}  (code: 0 ok, 2 not found, 3 open failed, 4 write failed, 5 bad arguments)
function Format-Answer {
    param($Id, [int] $Code, [string] $Text)

    $okText = 'false'
    if ($Code -eq 0) { $okText = 'true' }
    $idText = 'null'
    if ($Id -is [int] -or $Id -is [long] -or $Id -is [double] -or $Id -is [decimal]) {
        $idText = [System.Convert]::ToString($Id, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    elseif ($Id -is [string]) {
        $idText = ConvertTo-AsciiJsonString -Text $Id
    }
    return '{"id":' + $idText + ',"ok":' + $okText + ',"code":' + $Code + ',"message":' + (ConvertTo-AsciiJsonString -Text $Text) + '}'
}

# Reads the file and prints it as one RAW document. Returns @{ Code = <0|2|3|4|5>; Message = <text> }.
function Get-RawPrintResult {
    param([string] $Name, [string] $Path)

    if ([string]::IsNullOrWhiteSpace($Name)) { return @{ Code = 5; Message = 'The printer name is empty.' } }
    if ([string]::IsNullOrWhiteSpace($Path)) { return @{ Code = 5; Message = 'The file name is empty.' } }
    if (-not [System.IO.File]::Exists($Path)) { return @{ Code = 5; Message = 'The file to print was not found.' } }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
    }
    catch {
        return @{ Code = 5; Message = 'The file to print could not be read.' }
    }
    if ($bytes.Length -eq 0) { return @{ Code = 5; Message = 'The file to print is empty.' } }

    $win32Error = 0
    $status = [GposRawPrinter]::Print($Name, $bytes, 'GadgetsPOS', [ref] $win32Error)
    if ($status -eq 0) { return @{ Code = 0; Message = '' } }
    return @{ Code = [int] $status; Message = [GposRawPrinter]::Describe($win32Error) }
}
# END SHARED

try {
    Add-Type -TypeDefinition $SpoolerSource -Language CSharp -IgnoreWarnings
}
catch {
    [Console]::Error.WriteLine('The printing component could not be loaded: ' + $_.Exception.Message)
    exit 3
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
$writer.NewLine = "`n"
$writer.WriteLine('{"ready":true}')

while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $id = $null
    $code = 5
    $message = 'The command could not be read.'
    $stage = 'read'
    try {
        $command = $line | ConvertFrom-Json
        $id = $command.id
        $name = [string] $command.printerName
        $path = [string] $command.filePath
        $stage = 'print'
        $result = Get-RawPrintResult -Name $name -Path $path
        $code = [int] $result.Code
        $message = [string] $result.Message
    }
    catch {
        $message = $_.Exception.Message
        if ($stage -eq 'print') { $code = 3 }
    }
    $writer.WriteLine((Format-Answer -Id $id -Code $code -Text $message))
}
exit 0
