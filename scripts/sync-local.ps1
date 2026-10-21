#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$agent = Join-Path $env:USERPROFILE '.pi\agent'

Write-Host '1. 清理 ~/.pi/agent 下的冲突技能与旧扩展目录...' -ForegroundColor Cyan
$toRemove = @(
    (Join-Path $agent 'skills\local-chrome'),
    (Join-Path $agent 'extensions\auto-review-observer.ts'),
    (Join-Path $agent 'extensions\pi-better-compaction'),
    (Join-Path $agent 'extensions\pi-thagoras'),
    (Join-Path $agent 'local\pi-better-compaction'),
    (Join-Path $agent 'local\pi-thagoras'),
    (Join-Path $repo 'extensions\subagent-inspector.ts'),
    (Join-Path $repo 'extensions\subagent-inspector'),
    (Join-Path $repo 'tests\subagent-inspector.test.ts')
)
foreach ($p in $toRemove) {
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Recurse -Force
        Write-Host "  已移除: $p"
    }
}

Write-Host '2. 同步 APPEND_SYSTEM.md、models.json、permissions.json 与 subagent/config.json...' -ForegroundColor Cyan
Copy-Item -LiteralPath (Join-Path $repo 'APPEND_SYSTEM.md') -Destination (Join-Path $agent 'APPEND_SYSTEM.md') -Force
Copy-Item -LiteralPath (Join-Path $repo 'models.json') -Destination (Join-Path $agent 'models.json') -Force
Copy-Item -LiteralPath (Join-Path $repo 'config\permissions.json') -Destination (Join-Path $agent 'extensions\pi-permission-system\config.json') -Force
New-Item -ItemType Directory -Path (Join-Path $agent 'extensions\subagent') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'config\subagent.json') -Destination (Join-Path $agent 'extensions\subagent\config.json') -Force

Write-Host '3. 切换 CLIProxyAPI 计划任务为 wscript 无窗口后台运行...' -ForegroundColor Cyan
$cpaControl = Join-Path $env:USERPROFILE 'apps\CLIProxyAPI\control.ps1'
if (Test-Path -LiteralPath $cpaControl) {
    & $cpaControl -Action HideWindow
}

Write-Host '4. 同步新版 pi-auto-review 源码到 ProgramData 受保护目录 (UAC)...' -ForegroundColor Cyan
$reviewerDest = 'C:\ProgramData\PiSetup\S-1-5-21-3494849708-574138626-2646216864-1001\reviewer\20261009-164709-38d3c29c\src'
$reviewerSrc = Join-Path $repo 'upstream\pi-packages\packages\pi-auto-review\src'
if ((Test-Path -LiteralPath $reviewerDest) -and (Test-Path -LiteralPath $reviewerSrc)) {
    $cmd = "Copy-Item -Path '$reviewerSrc\*' -Destination '$reviewerDest' -Recurse -Force"
    Start-Process -FilePath (Get-Command pwsh).Source -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile', '-Command', $cmd)
    Write-Host "  已更新: $reviewerDest"
}

Write-Host '本机环境已全部同步完成！回到 Pi 执行 /reload 即可。' -ForegroundColor Green
