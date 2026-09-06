<#
.SYNOPSIS
  One-screen status of the local AI development workflow (.ai/).

.DESCRIPTION
  READ-ONLY. Prints:
    - repo HEAD / branch / subject
    - git status summary (staged / modified / untracked counts)
    - current milestone (id, title, base HEAD, status)
    - state of the task + report files
    - release-gate buckets and DECISION

  Never writes anything. Never runs a mutating git command. Never calls a
  network service. Safe on Windows PowerShell 5.1.

.EXAMPLE
  .\scripts\ai-status.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AiDir    = Join-Path $RepoRoot '.ai'

function Get-Field {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path $Path)) { return '(file missing)' }
    $pattern = '^\s*[-*]?\s*' + [regex]::Escape($Name) + '\s*:\s*(.+?)\s*$'
    $hit = Select-String -Path $Path -Pattern $pattern -List
    if ($null -eq $hit) { return '(not set)' }
    return $hit.Matches[0].Groups[1].Value.Trim()
}

function Get-GateValue {
    param([string[]]$Lines, [string]$Key)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match ('^\s*' + [regex]::Escape($Key) + '\s*:\s*(.*)$')) {
            $inline = $Matches[1].Trim()
            if ($inline -ne '') { return $inline }
            for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
                $l = $Lines[$j].Trim()
                if ($l -eq '') { continue }
                if ($l.StartsWith('<!--')) { continue }
                if ($l.StartsWith('#')) { return '(empty)' }
                if ($l -match '^[A-Z][A-Z ]*:\s*$') { return '(empty)' }
                return $l
            }
            return '(empty)'
        }
    }
    return '(not found)'
}

function Write-Section { param([string]$Text) Write-Host ''; Write-Host ('== ' + $Text + ' ==') -ForegroundColor Cyan }

Write-Host 'ARCH PLM - AI workflow status' -ForegroundColor Green
Write-Host ('repo: ' + $RepoRoot)

# --- repository ------------------------------------------------------
Write-Section 'Repository'
try {
    Push-Location $RepoRoot
    $head    = (& git rev-parse --short HEAD 2>$null)
    $branch  = (& git rev-parse --abbrev-ref HEAD 2>$null)
    $subject = (& git log -1 --pretty=%s 2>$null)
    Write-Host ('HEAD    : ' + $head + '  (' + $branch + ')  ' + $subject)

    $porcelain = @(& git status --porcelain 2>$null)
    if ($porcelain.Count -eq 0) {
        Write-Host 'status  : clean'
    }
    else {
        $staged    = @($porcelain | Where-Object { $_ -match '^[MADRC]' }).Count
        $modified  = @($porcelain | Where-Object { $_ -match '^.[MD]' }).Count
        $untracked = @($porcelain | Where-Object { $_ -match '^\?\?' }).Count
        Write-Host ('status  : ' + $staged + ' staged, ' + $modified + ' modified, ' + $untracked + ' untracked')
    }
}
catch {
    Write-Host ('git unavailable: ' + $_.Exception.Message) -ForegroundColor Yellow
}
finally {
    Pop-Location
}

# --- milestone -----------------------------------------------------
Write-Section 'Milestone'
$msPath = Join-Path $AiDir 'milestone.md'
Write-Host ('id      : ' + (Get-Field $msPath 'Milestone ID'))
Write-Host ('title   : ' + (Get-Field $msPath 'Title'))
Write-Host ('base    : ' + (Get-Field $msPath 'Stable HEAD'))
Write-Host ('status  : ' + (Get-Field $msPath 'Status'))

# --- tasks + reports ----------------------------------------------
Write-Section 'Tasks and reports'
$files = [ordered]@{
    'implementer-task.md'   = 'Status'
    'implementer-report.md' = 'Status'
    'reviewer-task.md'      = 'Status'
    'reviewer-report.md'    = 'Status'
}
foreach ($name in $files.Keys) {
    $p = Join-Path $AiDir $name
    $exists = Test-Path $p
    $state  = if ($exists) { Get-Field $p $files[$name] } else { '(missing)' }
    Write-Host (('{0,-22}: ' -f $name) + $state)
}

# --- release gate -----------------------------------------------
Write-Section 'Release gate'
$gatePath = Join-Path $AiDir 'release-gate.md'
if (Test-Path $gatePath) {
    $lines = Get-Content -LiteralPath $gatePath
    foreach ($k in @('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'PASS', 'DECISION')) {
        Write-Host (('{0,-9}: ' -f $k) + (Get-GateValue -Lines $lines -Key $k))
    }
    $decision = Get-GateValue -Lines $lines -Key 'DECISION'
    Write-Host ''
    if ($decision -eq 'SAFE TO COMMIT') {
        Write-Host 'gate    : SAFE TO COMMIT' -ForegroundColor Green
    }
    elseif ($decision -eq 'NOT SAFE TO COMMIT') {
        Write-Host 'gate    : NOT SAFE TO COMMIT' -ForegroundColor Red
    }
    else {
        Write-Host ('gate    : ' + $decision) -ForegroundColor Yellow
    }
}
else {
    Write-Host 'release-gate.md missing' -ForegroundColor Yellow
}

Write-Host ''
