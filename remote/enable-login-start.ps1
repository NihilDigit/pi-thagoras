#requires -Version 7.0
[CmdletBinding()]
param([switch]$Run, [ValidateSet('Host','Relay','Tunnel')][string[]]$Components = @('Host','Relay','Tunnel'), [switch]$Enable, [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,60}$')][string]$TaskPrefix = 'PiThagoras')
$ErrorActionPreference = 'Stop'
if (-not $Run) {
    Write-Output ('Plan: register ' + (($Components | ForEach-Object { $TaskPrefix+'-'+$_ }) -join ', ') + ' at this Windows user logon.')
    Write-Output 'Limited interactive user, hidden foreground workers, no SYSTEM/admin service or stored password.'
    return
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$runtime = (Get-PitatoRuntimeConfig).runtimeRoot
$pwsh = (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$description = 'Managed by ' + $PSCommandPath + '; current-user personal relay only.'
$entries = @(
    @{ Name=($TaskPrefix+'-Relay'); Component='Relay'; Script='start-relay.ps1'; Description=$description },
    @{ Name=($TaskPrefix+'-Tunnel'); Component='Tunnel'; Script='connect-tunnel.ps1'; Description=$description },
    @{ Name=($TaskPrefix+'-Host'); Component='Host'; Script='run-host.mjs'; DirectNode=$true; Description=('Managed by ' + $PSCommandPath + '; current-user pitato session host.') }
)
foreach ($entry in $entries) {
    if ($entry.Component -notin $Components) { continue }
    $existing = Get-ScheduledTask -TaskName $entry.Name -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Description -ne $entry.Description -and $existing.Description -ne ('Managed by pi-thagoras; current-user ' + $entry.Component + '.')) { throw ('An unrelated task already uses ' + $entry.Name) }

    }
    # Native Task Scheduler keeps the SID verbatim; no name conversion or password.
    $task = $service.NewTask(0)
    $task.RegistrationInfo.Description = if (Test-Path -LiteralPath (Join-Path $(if($env:PI_CODING_AGENT_DIR){$env:PI_CODING_AGENT_DIR}else{Join-Path $env:USERPROFILE '.pi/agent'}) 'pi-thagoras.json')) { 'Managed by pi-thagoras; current-user ' + $entry.Component + '.' } else { $entry.Description }
    $task.Principal.UserId = $sid
    $task.Principal.LogonType = 3 # InteractiveToken
    $task.Principal.RunLevel = 0 # LeastPrivilege
    $trigger = $task.Triggers.Create(9) # Logon
    $trigger.UserId = $sid
    $trigger.Enabled = $true
    $task.Settings.Enabled = if ($Enable) { $true } elseif ($existing) { $existing.Settings.Enabled } else { $false }
    $task.Settings.MultipleInstances = 2 # IgnoreNew
    $task.Settings.StartWhenAvailable = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries = $false
    $task.Settings.RestartCount = 3
    $task.Settings.RestartInterval = 'PT1M'
    $task.Settings.ExecutionTimeLimit = 'PT0S'
    $action = $task.Actions.Create(0)
    $action.Path = if ($entry.DirectNode) { (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source } else { $pwsh }
    $diagnosticDirectory = Join-Path ([IO.Path]::GetTempPath()) 'pi-thagoras-startup'
    [IO.Directory]::CreateDirectory($diagnosticDirectory) | Out-Null
    $diagnosticFile = Join-Path $diagnosticDirectory ($entry.Name + '.error.txt')
    $entryScript = Join-Path $PSScriptRoot $entry.Script
    if ($entry.DirectNode) {
        $hostConfig = Join-Path $runtime 'pitato/host.json'
        if (-not (Test-Path -LiteralPath $hostConfig -PathType Leaf)) { throw 'Configure pitato before registering its login task.' }
        $action.Arguments = '"{0}" --config "{1}"' -f $entryScript,$hostConfig
    } else {
        $command = '$ErrorActionPreference=''Stop''; try {{ & ''{0}'' -RuntimeRoot ''{1}'' -Run }} catch {{ $_.Exception.Message | Set-Content -LiteralPath ''{2}'' -Encoding utf8; exit 1 }}' -f $entryScript.Replace("'","''"),$runtime.Replace("'","''"),$diagnosticFile.Replace("'","''")
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $action.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded
    }
    $action.WorkingDirectory = $env:USERPROFILE
    $folder.RegisterTaskDefinition($entry.Name,$task,6,$sid,$null,3,$null) | Out-Null
    Write-Output ($entry.Name + ': registered for current-user logon.')
}
