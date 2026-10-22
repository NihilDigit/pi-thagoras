#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$AgentRoot = $(if($env:PI_CODING_AGENT_DIR){$env:PI_CODING_AGENT_DIR}else{Join-Path $env:USERPROFILE '.pi/agent'}),
    [string]$RuntimeRoot,
    [switch]$Apply,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This installer targets Windows.' }
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run setup from a normal PowerShell window; only the protected-code step requests UAC.' }
$root = $PSScriptRoot
$AgentRoot = [IO.Path]::GetFullPath($AgentRoot)
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $AgentRoot 'pi-thagoras-state' }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$python = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $python -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ is required"'
if ($LASTEXITCODE) { throw 'Recovery guard requires Python 3.11+.' }

$infoPath = Join-Path $AgentRoot 'pi-thagoras.json'
$existingInfo = if (Test-Path -LiteralPath $infoPath) { Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json } else { $null }
$hasInstalledRelease = $existingInfo -and $existingInfo.releaseRoot -and (Test-Path -LiteralPath (Join-Path $existingInfo.releaseRoot 'app'))

if ($hasInstalledRelease -and -not $Rebuild) {
    if (-not $Apply) {
        Write-Output "Plan: sync current repo (agents, extensions, guards, config, skills, APPEND_SYSTEM.md) into $($existingInfo.releaseRoot) and $AgentRoot. Add -Apply to execute, or -Rebuild to rebuild node_modules from scratch."
        return
    }
    & (Join-Path $root 'scripts/sync-local.ps1') -AgentRoot $AgentRoot
    return
}

$pointerPath = Join-Path $root '.build/windows-current.json'
$needBuild = $Rebuild -or -not (Test-Path -LiteralPath $pointerPath)
if ($needBuild) {
    if (-not $Apply) { Write-Output 'Plan: build pinned submodules and dependencies, install a protected release via UAC, and merge this user profile. Add -Apply to execute.'; return }
    & $node (Join-Path $root 'scripts/build-windows.mjs')
    if ($LASTEXITCODE) { throw 'Windows build failed.' }
}
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$release = Join-Path $env:ProgramData ('PiThagoras/' + $sid + '/releases/' + $pointer.manifestHash.Substring(0,16))
$configure = Join-Path $root 'scripts/configure-profile.mjs'
$profileArgs = @($configure,'--release',$release,'--source',$pointer.stage,'--agent',$AgentRoot,'--runtime',$RuntimeRoot)
& $node @profileArgs
if ($LASTEXITCODE) { throw 'Profile preflight failed; nothing installed.' }
if (-not $Apply) { Write-Output 'Plan only. Add -Apply to install this release and configure the listed files.'; return }
$script = Join-Path $root 'scripts/install-windows.ps1'
$installer = Start-Process -FilePath (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$script+'"'),'-BundleRoot',('"'+$pointer.stage+'"'),'-ExpectedManifestHash',$pointer.manifestHash,'-UserSid',$sid)
if ($installer.ExitCode) { throw 'Protected release installation failed; user profile was not changed.' }
& $node @profileArgs --apply
if ($LASTEXITCODE) { throw 'Profile configuration failed. Protected release is retained for inspection.' }
$bin = Join-Path ([IO.Path]::GetFullPath($AgentRoot)) 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($bin -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath), 'User') }
$env:Path = $bin + ';' + $env:Path
& (Join-Path $root 'scripts/setup-cliproxyapi.ps1') -AgentRoot $AgentRoot
Write-Output 'Installed. Complete the two logins on a new machine:'
Write-Output '  1. Google (Argon/Flash): pwsh -NoProfile -File "$HOME/apps/CLIProxyAPI/control.ps1" -Action Login'
Write-Output '  2. OpenAI (Astra/Sol/Review): pi-thagoras /login openai'
