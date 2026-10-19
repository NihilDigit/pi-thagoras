#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$runtimeConfig = Get-PitatoRuntimeConfig
if (-not $RuntimeRoot) { $RuntimeRoot = $runtimeConfig.runtimeRoot }
if (-not $Run) {
    Write-Output 'Plan: run the configured pitato session host in the foreground as the current user.'
    Write-Output 'No project picker, browser window, model prompt, or session is started automatically.'
    return
}
. (Join-Path $PSScriptRoot 'host-runtime.ps1')
$managed = Get-PitatoManagedPi
$stateRoot = Join-Path $RuntimeRoot 'pitato'
$configPath = Join-Path $stateRoot 'host.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'pitato host is not configured. Open Start pitato.cmd first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config | Add-Member -NotePropertyName piBin -NotePropertyValue $managed.Cli -Force
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$entry = if ($runtimeConfig.remotePackageRoot) { Join-Path $runtimeConfig.remotePackageRoot 'dist/bin/pitato-host.js' } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'upstream/remote_pi/pi-extension/dist/bin/pitato-host.js' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Built pitato host not found. Build pi-extension before enabling login start.' }
$serviceEntry = Join-Path $PSScriptRoot 'run-host.mjs'
& $managed.Node $serviceEntry --config $configPath
if ($LASTEXITCODE -ne 0) { throw "pitato host exited with code $LASTEXITCODE" }
