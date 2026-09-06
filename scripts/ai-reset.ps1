<#
.SYNOPSIS
  Reset the .ai/ working files to their templates for the next milestone.

.DESCRIPTION
  Restores these six files from .ai/templates/:
    milestone.md
    implementer-task.md
    implementer-report.md
    reviewer-task.md
    reviewer-report.md
    release-gate.md

  README.md and .ai/templates/ are NEVER touched.

  This script ONLY writes inside .ai/. It never touches source code, never
  runs git reset / git clean / git checkout, never commits, never pushes,
  and never calls a network service.

.PARAMETER Force
  Skip the confirmation prompt (for non-interactive use).

.EXAMPLE
  .\scripts\ai-reset.ps1
  .\scripts\ai-reset.ps1 -Force
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$AiDir       = Join-Path $RepoRoot '.ai'
$TemplateDir = Join-Path $AiDir 'templates'

$Working = @(
    'milestone.md',
    'implementer-task.md',
    'implementer-report.md',
    'reviewer-task.md',
    'reviewer-report.md',
    'release-gate.md'
)

if (-not (Test-Path -LiteralPath $TemplateDir)) {
    throw "Templates directory not found: $TemplateDir"
}

# Pre-flight: every template must exist before we change anything.
$plan = @()
foreach ($name in $Working) {
    $tpl = Join-Path $TemplateDir ($name -replace '\.md$', '.template.md')
    if (-not (Test-Path -LiteralPath $tpl)) {
        throw "Missing template for '$name': $tpl"
    }
    $plan += [pscustomobject]@{
        Name     = $name
        Template = $tpl
        Target   = Join-Path $AiDir $name
    }
}

Write-Host 'ai-reset will restore these files from .ai/templates/:' -ForegroundColor Yellow
foreach ($item in $plan) { Write-Host ('  .ai/' + $item.Name) }
Write-Host 'README.md, .ai/templates/ and ALL source code are left untouched.'
Write-Host ''

if (-not $Force) {
    $answer = "$(Read-Host 'Proceed? (y/N)')".Trim().ToLowerInvariant()
    if ($answer -ne 'y' -and $answer -ne 'yes') {
        Write-Host 'Aborted. Nothing changed.'
        return
    }
}

foreach ($item in $plan) {
    if ($PSCmdlet.ShouldProcess($item.Target, 'restore from template')) {
        Copy-Item -LiteralPath $item.Template -Destination $item.Target -Force
        Write-Host ('  reset  .ai/' + $item.Name)
    }
}

Write-Host ''
Write-Host 'Done. Next: PM edits .ai/milestone.md and .ai/implementer-task.md,' -ForegroundColor Green
Write-Host 'then run  .\scripts\ai-status.ps1  to confirm the fresh state.'
