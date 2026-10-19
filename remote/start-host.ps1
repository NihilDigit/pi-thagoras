#requires -Version 7.0
[CmdletBinding()]
param([switch]$Configure)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$extensionRoot = Join-Path $projectRoot 'upstream/remote_pi/pi-extension'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$runtimeConfig = Get-PitatoRuntimeConfig
$stateRoot = Join-Path $runtimeConfig.runtimeRoot 'pitato'
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null
$hostConfigPath = Join-Path $stateRoot 'host.json'
if ($Configure -or -not (Test-Path -LiteralPath $hostConfigPath)) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = [Windows.Forms.FolderBrowserDialog]::new()
    $picker.Description = '选择要在 pitato 中使用的项目文件夹'
    $picker.UseDescriptionForTitle = $true
    if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
    $projectDirectory = $picker.SelectedPath
    $trust = [Windows.Forms.MessageBox]::Show(
        "允许 Pi 为此项目加载本地指令、配置与扩展吗？`n`n$projectDirectory`n`n工具操作仍需经过正常权限检查。",
        'pitato · 项目资源', [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Question) -eq [Windows.Forms.DialogResult]::Yes
    $projectName = Split-Path $projectDirectory -Leaf
    $config = @{
        name = [Environment]::MachineName
        projects = @(@{id='primary';name=$projectName;cwd=$projectDirectory})
        relayUrl = $(if ($runtimeConfig.relayUrl) { $runtimeConfig.relayUrl } else { 'wss://pi-relay.nihildigit.dev' })
        trustProjects = $trust
        port = 4317
    }
    [IO.File]::WriteAllText($hostConfigPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
$config = Get-Content -LiteralPath $hostConfigPath -Raw | ConvertFrom-Json
try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/api" -Method Post -Headers @{'X-Pitato-Local'='1'} -ContentType 'application/json' -Body '{"action":"describe"}' -TimeoutSec 2 -NoProxy
    if ($existing.ok) { Start-Process "http://127.0.0.1:$($config.port)"; return }
} catch { }

. (Join-Path $PSScriptRoot 'host-runtime.ps1')
$managed = Get-PitatoManagedPi
$config | Add-Member -NotePropertyName piBin -NotePropertyValue $managed.Cli -Force
[IO.File]::WriteAllText($hostConfigPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$entry = if ($runtimeConfig.remotePackageRoot) { Join-Path $runtimeConfig.remotePackageRoot 'dist/bin/pitato-host.js' } else { Join-Path $extensionRoot 'dist/bin/pitato-host.js' }
if (-not (Test-Path -LiteralPath $entry)) {
    & pnpm -C $extensionRoot install --frozen-lockfile
    if ($LASTEXITCODE) { throw 'Host dependency installation failed.' }
    & pnpm -C $extensionRoot build
    if ($LASTEXITCODE) { throw 'Host build failed.' }
}
$task = Get-ScheduledTask -TaskName PiThagoras-Host -ErrorAction SilentlyContinue
$process = $null
if ($task) {
    $expectedDescription = 'Managed by ' + (Join-Path $PSScriptRoot 'enable-login-start.ps1') + '; current-user pitato session host.'
    if ($task.Description -ne $expectedDescription -and $task.Description -ne 'Managed by pi-thagoras; current-user Host.') { throw 'PiThagoras-Host belongs to another startup entry.' }
    Start-ScheduledTask -TaskName PiThagoras-Host
} else {
    $env:PI_MANAGED_INSTALL_ROOT = $managed.InstallRoot
    $launchArguments = @(('"{0}"' -f $entry), '--config', ('"{0}"' -f $hostConfigPath))
    $process = Start-Process -FilePath $managed.Node -ArgumentList $launchArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateRoot 'host.log') -RedirectStandardError (Join-Path $stateRoot 'host-error.log')
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($process -and $process.HasExited) { throw "Host exited. See $(Join-Path $stateRoot 'host-error.log')" }
    try {
        $ready = Invoke-WebRequest -Uri "http://127.0.0.1:$($config.port)/" -TimeoutSec 1 -NoProxy
        if ($ready.StatusCode -eq 200) { Start-Process "http://127.0.0.1:$($config.port)"; return }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw 'Host did not become ready. Check the host log.'
