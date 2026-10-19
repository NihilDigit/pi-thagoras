#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$TokenFile,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
if (-not $RuntimeRoot) { $RuntimeRoot = (Get-PitatoRuntimeConfig).runtimeRoot }
if (-not $Run) {
    Write-Output 'Plan: connect the existing Dashboard-managed tunnel in the foreground via --token-file.'
    Write-Output 'No tunnel creation, DNS edit, login, cert.pem, service installation or scheduled task.'
    return
}
if (-not $TokenFile) { $TokenFile = Join-Path $RuntimeRoot 'secrets/tunnel.token' }
if (-not [IO.Path]::IsPathFullyQualified($TokenFile)) { throw 'Use an absolute external token-file path.' }
$tokenPath = [IO.Path]::GetFullPath($TokenFile)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\','/')
if ($tokenPath.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Token file must remain outside the repository.'
}
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw 'User-provisioned token file not found.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $tokenPath
if (@($acl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $user
}).Count -gt 0) { throw 'Token file grants access beyond the current user; review its ACL first.' }
$software = Get-PitatoSoftware $RuntimeRoot
$binary = $software.cloudflared.path
$expected = $software.cloudflared.sha256
if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or
    (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Verified cloudflared 2026.10.1 not found.'
}

# One foreground owner per current-user logon session; repeated starts are harmless.
$runtimeMutex = [Threading.Mutex]::new($false, 'Local\PiThagoras-cloudflared-2026.10.1-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$runtimeMutexHeld = $false
try { $runtimeMutexHeld = $runtimeMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $runtimeMutexHeld = $true }
if (-not $runtimeMutexHeld) {
    $runtimeMutex.Dispose()
    Write-Output 'cloudflared-2026.10.1: an existing startup entry owns this runtime.'
    return
}
try {
    $existingRuntime = @(Get-Process -Name 'cloudflared-2026.10.1' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $binary -or $_.Path -eq (Join-Path ((Get-PitatoRuntimeConfig).logicalRuntimeRoot) ('bin/' + [IO.Path]::GetFileName($binary))) })
    if ($existingRuntime.Count -gt 0) {
        $probeResult = Invoke-WebRequest -Uri 'http://127.0.0.1:20242/ready' -NoProxy -TimeoutSec 5 -SkipHttpErrorCheck
        if ($probeResult.StatusCode -eq 200) {
            Write-Output 'cloudflared-2026.10.1: existing verified-path runtime is healthy; no duplicate started.'
            return
        }
        throw 'cloudflared-2026.10.1: existing runtime is not ready; no duplicate was started.'
    }
    $portProbe = [Net.Sockets.TcpClient]::new()
    try {
        if ($portProbe.ConnectAsync('127.0.0.1', 20242).Wait(300) -and $portProbe.Connected) {
            throw 'Local runtime port 20242 is already occupied by another process.'
        }
    } catch [AggregateException] {
        # Connection refused: port is available.
    } finally { $portProbe.Dispose() }
& $binary tunnel --protocol http2 --loglevel warn --metrics '127.0.0.1:20242' run --token-file $tokenPath
if ($LASTEXITCODE -ne 0) { throw 'Tunnel connection exited with an error.' }

} finally {
    if ($runtimeMutexHeld) { $runtimeMutex.ReleaseMutex() }
    $runtimeMutex.Dispose()
}
