#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:USERPROFILE 'apps/CLIProxyAPI'),
    [string]$AgentRoot = $(if($env:PI_CODING_AGENT_DIR){$env:PI_CODING_AGENT_DIR}else{Join-Path $env:USERPROFILE '.pi/agent'}),
    [string]$Version = '8.0.36'
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$AgentRoot = [IO.Path]::GetFullPath($AgentRoot)
$versionDir = Join-Path $InstallRoot "v$Version"
$exePath = Join-Path $versionDir 'cli-proxy-api.exe'

foreach ($dir in @($InstallRoot, $versionDir, (Join-Path $InstallRoot 'auth'), (Join-Path $InstallRoot 'logs'), (Join-Path $InstallRoot 'downloads'), $AgentRoot)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

if (-not (Test-Path -LiteralPath $exePath)) {
    $arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { 'arm64' } else { 'amd64' }
    $zipName = "CLIProxyAPI_${Version}_windows_${arch}.zip"
    $zipPath = Join-Path $InstallRoot "downloads/$zipName"
    $url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$Version/$zipName"
    if (-not (Test-Path -LiteralPath $zipPath)) {
        Write-Output "Downloading CLIProxyAPI v$Version ($arch)..."
        try {
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        } catch {
            if ($arch -eq 'arm64') {
                $zipName = "CLIProxyAPI_${Version}_windows_amd64.zip"
                $zipPath = Join-Path $InstallRoot "downloads/$zipName"
                $url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$Version/$zipName"
                Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
            } else {
                throw
            }
        }
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $versionDir -Force
}

function New-RandomToken([int]$Bytes = 24) {
    $buf = [byte[]]::new($Bytes)
    [Security.Cryptography.RandomNumberGenerator]::Fill($buf)
    return ([Convert]::ToBase64String($buf) -replace '\+','-' -replace '/','_' -replace '=','')
}

$clientSettingsPath = Join-Path $InstallRoot 'client-settings.json'
$configYamlPath = Join-Path $InstallRoot 'config.yaml'
$piCpaConfigPath = Join-Path $AgentRoot 'cliproxyapi.json'

if (-not (Test-Path -LiteralPath $clientSettingsPath)) {
    $apiKey = 'cpa_' + (New-RandomToken 24)
    $mgmtKey = 'mgmt_' + (New-RandomToken 24)
    @{
        base_url = 'http://127.0.0.1:8317/v1'
        api_key = $apiKey
        management_key = $mgmtKey
    } | ConvertTo-Json | Set-Content -LiteralPath $clientSettingsPath -Encoding UTF8
} else {
    $existingClient = Get-Content -LiteralPath $clientSettingsPath -Raw | ConvertFrom-Json
    $apiKey = $existingClient.api_key
    $mgmtKey = $existingClient.management_key
}

if (-not (Test-Path -LiteralPath $configYamlPath)) {
    @"
host: "127.0.0.1"
port: 8317
auth-dir: "./auth"
api-keys:
  - "$apiKey"
remote-management:
  allow-remote: false
  secret-key: "$mgmtKey"
debug: false
logging-to-file: true
logs-max-total-size-mb: 50
"@ | Set-Content -LiteralPath $configYamlPath -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $piCpaConfigPath)) {
    @{
        baseUrl = 'http://127.0.0.1:8317/v1'
        apiKey = $apiKey
    } | ConvertTo-Json | Set-Content -LiteralPath $piCpaConfigPath -Encoding UTF8
}

$runPs1 = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath `$PSScriptRoot
`$server = Join-Path `$PSScriptRoot 'v$Version\cli-proxy-api.exe'
`$config = Join-Path `$PSScriptRoot 'config.yaml'
`$quotedConfig = '"' + `$config + '"'
while (`$true) {
    try {
        Start-Process -FilePath `$server -ArgumentList @('--config', `$quotedConfig) -WorkingDirectory `$PSScriptRoot -WindowStyle Hidden -Wait
    } catch {
        Write-Warning `$_.Exception.Message
    }
    Start-Sleep -Seconds 60
}
"@
Set-Content -LiteralPath (Join-Path $InstallRoot 'run.ps1') -Value $runPs1 -Encoding UTF8

$vbsContent = @'
Dim fso, dir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "pwsh.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\run.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, True
'@
$vbsPath = Join-Path $InstallRoot 'launch-hidden.vbs'
Set-Content -LiteralPath $vbsPath -Value $vbsContent -Encoding Unicode

$loginPs1 = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath `$PSScriptRoot
& (Join-Path `$PSScriptRoot 'v$Version\cli-proxy-api.exe') --config (Join-Path `$PSScriptRoot 'config.yaml') --antigravity-login
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath (Join-Path $InstallRoot 'login.ps1') -Value $loginPs1 -Encoding UTF8

$controlPs1 = @'
param([ValidateSet('Status','Start','Stop','Restart','Login','HideWindow')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
switch ($Action) {
    'Start' { Start-ScheduledTask -TaskName 'CLIProxyAPI' }
    'Stop' { Stop-ScheduledTask -TaskName 'CLIProxyAPI' }
    'Restart' {
        Stop-ScheduledTask -TaskName 'CLIProxyAPI'
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName 'CLIProxyAPI'
    }
    'HideWindow' {
        $taskAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument ('//B //NoLogo "' + (Join-Path $PSScriptRoot 'launch-hidden.vbs') + '"') -WorkingDirectory $PSScriptRoot
        Set-ScheduledTask -TaskName 'CLIProxyAPI' -Action $taskAction | Out-Null
        Stop-ScheduledTask -TaskName 'CLIProxyAPI' -ErrorAction SilentlyContinue
        Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'apps[\\/]CLIProxyAPI[\\/]run\.ps1|cli-proxy-api\.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
        Start-ScheduledTask -TaskName 'CLIProxyAPI'
    }
    'Login' { & (Join-Path $PSScriptRoot 'login.ps1'); exit $LASTEXITCODE }
}
Get-ScheduledTask -TaskName 'CLIProxyAPI' | Select-Object TaskName, State
'@
Set-Content -LiteralPath (Join-Path $InstallRoot 'control.ps1') -Value $controlPs1 -Encoding UTF8

$taskAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument ('//B //NoLogo "' + $vbsPath + '"') -WorkingDirectory $InstallRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'CLIProxyAPI' -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName 'CLIProxyAPI'
