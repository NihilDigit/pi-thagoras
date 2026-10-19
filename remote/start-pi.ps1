#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [switch]$Run,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$PiArguments
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
if (-not $RuntimeRoot) { $RuntimeRoot = (Get-PitatoRuntimeConfig).runtimeRoot }
if (-not $Run) {
    Write-Output 'Plan: start ordinary Pi in the current project; pi-thagoras loads remote-pi for interactive terminals.'
    Write-Output 'The existing paired phone reconnects through the personal relay; no new QR is generated.'
    return
}
. (Join-Path $PSScriptRoot 'host-runtime.ps1')
$pi = Get-PitatoManagedPi
& $pi.Node $pi.Cli @PiArguments
