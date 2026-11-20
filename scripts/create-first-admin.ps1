<#
.SYNOPSIS
  Arch PLM - B05 G-5(a): create the FIRST administrator on the pilot database.

.DESCRIPTION
  Operator wrapper for scripts/create-first-admin.ts (Windows PowerShell 5.1).
  - Reads the password TWICE at a hidden prompt (Read-Host -AsSecureString) and
    passes it to the script on STDIN only - never in an argument, an
    environment variable, a file or the screen.
  - Verifies the pinned SHA-256 of the script and the library files it uses
    (line ends normalized to LF, so a CRLF checkout gives the same hash).
  - A real run (without -DryRun) shows this wrapper's own SHA-256 and requires
    the operator to type SENT - the PO's written go citing that hash must have
    been sent first. A dry run writes nothing and needs no gate.
  - Writes an evidence log (parameters, hashes, the script's output and exit
    code - never the password) into -EvidenceDir.
  Run a -DryRun first. prisma/seed.ts, setup-admin.ts and the fixture scripts
  must NOT be run against the pilot database.

.EXAMPLE
  .\scripts\create-first-admin.ps1 -Email admin@example.com -Name "Pilot Admin" `
    -OrgName "Arch Engineering Services" -OrgCode ARCH -ExpectedDatabase arch_plm_pilot `
    -EnvFile C:\ArchPLM\config\app.env -EvidenceDir C:\ArchPLM\evidence -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$OrgName,
  [Parameter(Mandatory = $true)][string]$OrgCode,
  [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------
# Pinned files (SHA-256 of the content with CR bytes removed).
# Any change to these files must update this table (a test checks it).
# ------------------------------------------------------------
$PinnedFiles = [ordered]@{
  'scripts/create-first-admin.ts'   = '7B00CB95B41DD80DCC3FD5619368AF0903379E634EA2DA0BA0B880EDABDA0518'
  'app/lib/first-admin-core.ts'     = 'F1944E2551DE9AF1971C54F32D098B4F923EDE05CCCF798747F0490F1C793F78'
  'app/lib/first-admin-db.ts'       = '2C4CEE24111914F167BEB4108EC944BFD6099EF06A6C75301A6D75D735359289'
  'app/lib/user-admin-core.ts'      = '5ACCACCD8677F66A85FA30348D71C7F5F21114ECAC0BAA206BC4BD09EED08BB4'
  'app/lib/user-admin-db.ts'        = 'FCB7EF77BF215CCDAA0CE0BFAC0578E67DF88A14A2AA0BAA3A6E3238F59BB0BA'
}

function Get-LfSha256 {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $kept = New-Object System.Collections.Generic.List[byte]
  foreach ($b in $bytes) { if ($b -ne 13) { $kept.Add($b) } }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash($kept.ToArray()) | ForEach-Object { $_.ToString('X2') }) -join '')
  } finally {
    $sha.Dispose()
  }
}

function ConvertTo-WindowsArgument {
  # Quote one argument for CreateProcess / the C runtime parser.
  param([string]$Value)
  if ($Value -eq '') { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Read-PlainFromSecure {
  param([System.Security.SecureString]$Secure)
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$mode = if ($DryRun) { 'DRY RUN' } else { 'REAL RUN' }
$started = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# --- Preconditions (nothing is read from the database yet) ---
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Env file not found: $EnvFile" }
if (-not (Test-Path -LiteralPath $EvidenceDir -PathType Container)) { throw "Evidence folder not found: $EvidenceDir" }
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

$hashLines = New-Object System.Collections.Generic.List[string]
foreach ($relative in $PinnedFiles.Keys) {
  $full = Join-Path $repoRoot $relative
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing file: $relative" }
  $actual = Get-LfSha256 -Path $full
  if ($actual -ne $PinnedFiles[$relative]) {
    throw "Hash mismatch for $relative (expected $($PinnedFiles[$relative]), got $actual). Stop - nothing was run."
  }
  $hashLines.Add("  $relative  $actual")
}
# C4-L2: the go cites the LF-normalized hash (the same rule as the pins), so a
# CRLF dev checkout and the LF copy from the archive show the same value.
$selfHash = Get-LfSha256 -Path $PSCommandPath
$selfRawHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash

Write-Host "Arch PLM - create first administrator ($mode)"
Write-Host "  Email:             $Email"
Write-Host "  Name:              $Name"
Write-Host "  Organization:      $OrgName ($OrgCode)"
Write-Host "  Expected database: $ExpectedDatabase"
Write-Host "  Env file:          $EnvFile"
Write-Host "  Wrapper SHA-256 (LF, cited in the go): $selfHash"
Write-Host "  Wrapper SHA-256 (file bytes, info):    $selfRawHash"
Write-Host "  Pinned files verified:"
$hashLines | ForEach-Object { Write-Host $_ }

# --- Gate (rule 6): a real run needs the PO's go, already sent ---
if (-not $DryRun) {
  Write-Host ""
  Write-Host "The PO's written go must cite wrapper SHA-256 (LF) $selfHash and must already be SENT."
  $answer = Read-Host "Type SENT to continue (anything else stops; nothing is written)"
  if ($answer -cne 'SENT') {
    Write-Host "Stopped at the gate. Nothing was written."
    exit 3
  }
}

# --- Password: typed twice, hidden (rule 13: type it or right-click-paste; compare the asterisk count) ---
Write-Host ""
Write-Host "Password for the new administrator: at least 16 characters, at most 72 bytes."
Write-Host "Type it (or right-click to paste) and compare the number of asterisks."
$first = Read-Host -AsSecureString "Password"
$second = Read-Host -AsSecureString "Password again"

$arguments = @(
  '--experimental-strip-types', "--env-file=$EnvFile", 'scripts/create-first-admin.ts',
  '--email', $Email, '--name', $Name, '--org-name', $OrgName, '--org-code', $OrgCode,
  '--expected-database', $ExpectedDatabase
)
if ($DryRun) { $arguments += '--dry-run' }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeExe
$psi.Arguments = (($arguments | ForEach-Object { ConvertTo-WindowsArgument -Value $_ }) -join ' ')
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
[void]$process.Start()
$stderrTask = $process.StandardError.ReadToEndAsync()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()

# STDIN: exactly two lines, UTF-8 without BOM; the plain text exists only here.
# C4-L1: if the script already exited (e.g. it refused an argument), the pipe
# is closed - record that and still collect the output and write the evidence.
$stdinNote = 'password lines written to STDIN'
$stdin = New-Object System.IO.StreamWriter($process.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
$stdin.NewLine = "`n"
try {
  $plain = Read-PlainFromSecure -Secure $first
  $stdin.WriteLine($plain)
  $plain = Read-PlainFromSecure -Secure $second
  $stdin.WriteLine($plain)
  $stdin.Flush()
} catch [System.IO.IOException] {
  $stdinNote = 'STDIN not accepted (the script exited early)'
} finally {
  $plain = $null
  try { $stdin.Close() } catch [System.IO.IOException] { $stdinNote = 'STDIN not accepted (the script exited early)' }
  $first.Dispose()
  $second.Dispose()
}

$process.WaitForExit()
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
$exitCode = $process.ExitCode

Write-Host ""
if ($stdout) { Write-Host $stdout.TrimEnd() }
if ($stderr) { Write-Host $stderr.TrimEnd() }
Write-Host "STDIN: $stdinNote"
Write-Host "Exit code: $exitCode"

# --- Evidence log (rule 10: build first, then write; never the password) ---
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$kind = if ($DryRun) { 'dryrun' } else { 'run' }
$evidencePath = Join-Path $EvidenceDir "create-first-admin-$kind-$stamp.txt"
$evidence = New-Object System.Collections.Generic.List[string]
$evidence.Add("Arch PLM - create first administrator - $mode")
$evidence.Add("Started (UTC): $started")
$evidence.Add("Computer: $env:COMPUTERNAME  User: $env:USERNAME")
$evidence.Add("Email: $Email  Name: $Name  Organization: $OrgName ($OrgCode)")
$evidence.Add("Expected database: $ExpectedDatabase  Env file: $EnvFile")
$evidence.Add("Wrapper SHA-256 (LF, cited in the go): $selfHash")
$evidence.Add("Wrapper SHA-256 (file bytes): $selfRawHash")
$evidence.Add("Pinned files (LF SHA-256):")
foreach ($line in $hashLines) { $evidence.Add($line) }
$evidence.Add("--- script output ---")
$evidence.Add($stdout.TrimEnd())
$evidence.Add("--- script errors ---")
$evidence.Add($stderr.TrimEnd())
$evidence.Add("STDIN: $stdinNote")
$evidence.Add("Exit code: $exitCode")
[System.IO.File]::WriteAllLines($evidencePath, $evidence.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Evidence: $evidencePath  SHA-256 $((Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash)"

exit $exitCode
