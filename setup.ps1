#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$RelayUrl,
    [string]$AgentRoot = $(if($env:PI_CODING_AGENT_DIR){$env:PI_CODING_AGENT_DIR}else{Join-Path $env:USERPROFILE '.pi/agent'}),
    [string]$RuntimeRoot,
    [ValidateRange(1024,65535)][int]$Port = 4317,
    [switch]$RelayServer,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This installer targets Windows. Build on the target Windows ABI.' }
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run setup from a normal PowerShell window; only the protected-code step requests UAC.' }
$root = $PSScriptRoot
$AgentRoot = [IO.Path]::GetFullPath($AgentRoot)
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $AgentRoot 'pi-thagoras-state' }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$python = (Get-Command python -CommandType Application -ErrorAction Stop).Source
& $python -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ is required"'
if ($LASTEXITCODE) { throw 'Recovery guard requires Python 3.11+.' }
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$pointerPath = Join-Path $root '.build/windows-current.json'
$revision = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw 'Cannot identify checkout. Clone with Git and --recurse-submodules.' }
$outdated = -not (Test-Path -LiteralPath $pointerPath)
if (-not $outdated) { $outdated = (Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json).rootRevision -ne $revision }
if ($outdated) {
    if (-not $Apply) { Write-Output 'Plan: build pinned submodules and dependencies, install a protected release via UAC, merge this user profile, and register the Host login task. Add -Apply to execute.'; return }
    $buildArgs = @((Join-Path $root 'scripts/build-windows.mjs'))
    if ($RelayServer) { $buildArgs += '--relay-server' }
    & $node @buildArgs
    if ($LASTEXITCODE) { throw 'Windows build failed.' }
}
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $pointer.stage 'manifest.json') -Raw | ConvertFrom-Json
if ((Get-FileHash (Join-Path $pointer.stage 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pointer.manifestHash) { throw 'Release manifest changed.' }
if ($RelayServer -and -not $manifest.software) { throw 'Rebuild with node scripts/build-windows.mjs --relay-server.' }
if ($manifest.arch -ne (& $node -p 'process.arch')) { throw 'Release ABI does not match this machine.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$release = Join-Path $env:ProgramData ('PiThagoras/' + $sid + '/releases/' + $pointer.manifestHash.Substring(0,16))
$configure = Join-Path $root 'scripts/configure-profile.mjs'
$profileArgs = @($configure,'--release',$release,'--source',$pointer.stage,'--agent',$AgentRoot,'--runtime',$RuntimeRoot,'--project',$project,'--relay',$RelayUrl,'--port',"$Port")
& $node @profileArgs
if ($LASTEXITCODE) { throw 'Profile preflight failed; nothing installed.' }
if (-not $Apply) { Write-Output 'Plan only. Add -Apply to install this release and configure the listed files.'; return }
$hostTask = Get-ScheduledTask -TaskName 'PiThagoras-Host' -ErrorAction SilentlyContinue
if ($hostTask -and $hostTask.Description -ne 'Managed by pi-thagoras; current-user Host.') { throw 'An existing Host task belongs to a different entry. Review its migration before applying setup.' }
$active = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pi-launcher\.js|pi-coding-agent[\\/].*cli\.js|subagent-runner-bootstrap' })
if ($active.Count) { throw 'Close Pi and its child tasks before applying setup.' }
$script = Join-Path $root 'scripts/install-windows.ps1'
$installer = Start-Process -FilePath (Get-Command pwsh).Source -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$script+'"'),'-BundleRoot',('"'+$pointer.stage+'"'),'-ExpectedManifestHash',$pointer.manifestHash,'-UserSid',$sid)
if ($installer.ExitCode) { throw 'Protected release installation failed; user profile was not changed.' }
$active = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pi-launcher\.js|pi-coding-agent[\\/].*cli\.js|subagent-runner-bootstrap' })
if ($active.Count) { throw 'Pi started while installation was awaiting confirmation. Close it before applying the user profile.' }
if ($hostTask) { Stop-ScheduledTask -TaskName 'PiThagoras-Host' }
& $node @profileArgs --apply
if ($LASTEXITCODE) { if($hostTask){Start-ScheduledTask -TaskName 'PiThagoras-Host'}; throw 'Profile configuration failed. Protected release is retained for inspection.' }
$previousAgent = $env:PI_CODING_AGENT_DIR
try {
    $env:PI_CODING_AGENT_DIR = [IO.Path]::GetFullPath($AgentRoot)
    & (Join-Path $release 'app/remote/enable-login-start.ps1') -Components Host -Run -Enable
    Start-ScheduledTask -TaskName PiThagoras-Host
} finally { $env:PI_CODING_AGENT_DIR = $previousAgent }
$bin = Join-Path ([IO.Path]::GetFullPath($AgentRoot)) 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($bin -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath), 'User') }
$env:Path = $bin + ';' + $env:Path
Write-Output "Installed. Open a new terminal and run pi-thagoras /login openai. Host: http://127.0.0.1:$Port/"
if ($RelayServer) {
    Write-Output "Relay tools are installed. Save your own connector token with: & '$release/app/remote/save-tunnel-token.ps1' -Run"
    Write-Output "Then register Relay/Tunnel: & '$release/app/remote/enable-login-start.ps1' -Components Relay,Tunnel -Run -Enable"
}
