#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ReleaseRoot)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $root (".build/service-smoke/中文 O'Brien-" + [guid]::NewGuid().ToString('N'))
$project = Join-Path $fixture 'project'
[IO.Directory]::CreateDirectory($project) | Out-Null
$prepare = Join-Path $fixture 'prepare.mjs'
@'
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,release,directory]=process.argv.slice(2);
const {planProfile,applyProfile}=await import(pathToFileURL(join(root,'scripts/lib/profile.mjs')));
const plan=planProfile({releaseRoot:release,agentDir:join(directory,'agent'),runtimeRoot:join(directory,'state'),projectPath:join(directory,'project'),relayUrl:'ws://127.0.0.1:3017',port:Number(process.env.PITATO_SMOKE_PORT)});
applyProfile(plan);
const file=join(directory,'state/pitato/host.json');
const config=JSON.parse(readFileSync(file,'utf8'));delete config.relayUrl;
writeFileSync(file,JSON.stringify(config));
'@ | Set-Content -LiteralPath $prepare -Encoding utf8
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
$previousAgent = $env:PI_CODING_AGENT_DIR
$previousPort = $env:PITATO_SMOKE_PORT
$previousPath = $env:Path
$expectedNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$expectedPwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
$fallbackTools = Join-Path $fixture 'fallback-tools'
[IO.Directory]::CreateDirectory($fallbackTools) | Out-Null
foreach($name in @('node.exe','pwsh.exe')) { [IO.File]::WriteAllText((Join-Path $fallbackTools $name),'synthetic fallback; never execute') }
$env:Path += ';' + $fallbackTools
$env:PI_CODING_AGENT_DIR = Join-Path $fixture 'agent'
$env:PITATO_SMOKE_PORT = "$port"
$prefix = 'PiThagorasSmoke-' + [guid]::NewGuid().ToString('N')
$taskName = $prefix + '-Host'
$registered = $false
try {
    & node $prepare $root ([IO.Path]::GetFullPath($ReleaseRoot)) $fixture
    if($LASTEXITCODE){throw 'Synthetic service profile failed'}
    if(@(Get-Command node -CommandType Application).Count -lt 2 -or @(Get-Command pwsh -CommandType Application).Count -lt 2){throw 'Duplicate executable fixture did not activate'}
    . (Join-Path $root 'remote/host-runtime.ps1')
    if((Get-PitatoManagedPi).Node -ne $expectedNode){throw 'Managed Pi resolved multiple Node executables'}
    & (Join-Path $root 'remote/enable-login-start.ps1') -Components Host -TaskPrefix $prefix -Run -Enable
    $registered=$true
    & (Join-Path $root 'remote/enable-login-start.ps1') -Components Relay,Tunnel -TaskPrefix $prefix -Run
    foreach($component in @('Relay','Tunnel')){
        $serverTask=Get-ScheduledTask -TaskName ($prefix+'-'+$component)
        if($serverTask.Actions.Execute -ne $expectedPwsh){throw 'Task did not select the first PowerShell executable'}
        if($serverTask.Settings.Enabled){throw 'Synthetic server tasks must stay disabled'}
        $encoded=($serverTask.Actions.Arguments -split ' ')[-1]
        $command=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
        $parseErrors=$null; $tokens=$null
        $ast=[Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$parseErrors)
        if($parseErrors.Count){throw 'Quoted service command did not parse'}
        $values=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst]},$true) | ForEach-Object Value)
        if((Join-Path $fixture 'state') -notin $values){throw 'Service command did not preserve the target runtime path'}
        Export-ScheduledTask -TaskName ($prefix+'-'+$component) | Set-Content -LiteralPath (Join-Path $fixture ($component+'.xml')) -Encoding utf8
    }
    $task=Get-ScheduledTask -TaskName $taskName
    if($task.Principal.RunLevel.ToString() -ne 'Limited' -or $task.Principal.LogonType.ToString() -ne 'Interactive' -or $task.Actions.Execute -ne $expectedNode){throw 'Unexpected task principal or action'}
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $fixture 'task.xml') -Encoding utf8
    $live = [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0
    if($live){
        Start-ScheduledTask -TaskName $taskName
        $ready=$false
        for($attempt=0;$attempt -lt 40;$attempt++){
            try { $response=Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -NoProxy -TimeoutSec 1; if($response.StatusCode -eq 200){$ready=$true;break} } catch {}
            Start-Sleep -Milliseconds 250
        }
        if(-not $ready){throw 'Scheduled synthetic Host did not become ready. Inspect the retained fixture logs.'}
    }
    $result=@{ taskDefinition=$true; serverDefinitions=$true; quotedPaths=$true; multipleExecutables=$true; leastPrivilege=$true; directNode=$true; liveHost=$live; modelCalls=0; productionTasksChanged=$false }
    if(-not $live){$result.headlessReason='Session 0 has no interactive logon token; definition verified without starting the task.'}
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.build/service-smoke.json') -Encoding utf8
    $result | ConvertTo-Json
} finally {
    if($registered){foreach($component in @('Host','Relay','Tunnel')){ $name=$prefix+'-'+$component; if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false} }}
    $env:PI_CODING_AGENT_DIR=$previousAgent; $env:PITATO_SMOKE_PORT=$previousPort
    $env:Path=$previousPath
}
