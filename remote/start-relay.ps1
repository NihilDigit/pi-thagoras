#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$DataDirectory,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
if (-not $RuntimeRoot) { $RuntimeRoot = (Get-PitatoRuntimeConfig).runtimeRoot }
if (-not $Run) {
    Write-Output 'Plan: foreground relay 0.3.1, loopback 127.0.0.1:3000, external persistent mesh.db.'
    Write-Output 'Use -Run after approving the local service. No service, task, tunnel or identity creation.'
    return
}
$software = Get-PitatoSoftware $RuntimeRoot
$binary = $software.relay.path
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Prepared relay binary not found.' }
$expected = $software.relay.sha256
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Prepared relay hash differs; rebuild and review before running.'
}

# One foreground owner per current-user logon session; repeated starts are harmless.
$runtimeMutex = [Threading.Mutex]::new($false, 'Local\PiThagoras-relay-0.3.1-loopback-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$runtimeMutexHeld = $false
try { $runtimeMutexHeld = $runtimeMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $runtimeMutexHeld = $true }
if (-not $runtimeMutexHeld) {
    $runtimeMutex.Dispose()
    Write-Output 'relay-0.3.1-loopback: an existing startup entry owns this runtime.'
    return
}
try {
    $existingRuntime = @(Get-Process -Name 'relay-0.3.1-loopback' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $binary -or $_.Path -eq (Join-Path ((Get-PitatoRuntimeConfig).logicalRuntimeRoot) ('bin/' + [IO.Path]::GetFileName($binary))) })
    if ($existingRuntime.Count -gt 0) {
        $probeResult = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -NoProxy -TimeoutSec 5 -SkipHttpErrorCheck
        if ($probeResult.StatusCode -eq 200 -and $probeResult.Content.Trim() -eq 'OK') {
            Write-Output 'relay-0.3.1-loopback: existing verified-path runtime is healthy; no duplicate started.'
            return
        }
        throw 'relay-0.3.1-loopback: existing runtime is not ready; no duplicate was started.'
    }
    $portProbe = [Net.Sockets.TcpClient]::new()
    try {
        if ($portProbe.ConnectAsync('127.0.0.1', 3000).Wait(300) -and $portProbe.Connected) {
            throw 'Local runtime port 3000 is already occupied by another process.'
        }
    } catch [AggregateException] {
        # Connection refused: port is available.
    } finally { $portProbe.Dispose() }
if (-not $DataDirectory) { $DataDirectory = Join-Path $RuntimeRoot 'state/relay' }
$data = [IO.Path]::GetFullPath($DataDirectory)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\','/')
if ($data.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or
    $data.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'mesh.db must remain outside the repository.'
}
[IO.Directory]::CreateDirectory($data) | Out-Null
$previousDb = $env:REMOTEPI_MESH_DB_PATH
$previousPort = $env:REMOTEPI_RELAY_PORT
$previousLog = $env:RUST_LOG
try {
    $env:REMOTEPI_MESH_DB_PATH = Join-Path $data 'mesh.db'
    $env:REMOTEPI_RELAY_PORT = '3000'
    $env:RUST_LOG = 'warn'
    & $binary
    if ($LASTEXITCODE -ne 0) { throw 'Relay exited with an error.' }
} finally {
    $env:REMOTEPI_MESH_DB_PATH = $previousDb
    $env:REMOTEPI_RELAY_PORT = $previousPort
    $env:RUST_LOG = $previousLog
}

} finally {
    if ($runtimeMutexHeld) { $runtimeMutex.ReleaseMutex() }
    $runtimeMutex.Dispose()
}
