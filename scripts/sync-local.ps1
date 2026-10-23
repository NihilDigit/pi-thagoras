#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$AgentRoot = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\agent' })
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$repo = Split-Path $PSScriptRoot -Parent
$agent = [IO.Path]::GetFullPath($AgentRoot)

foreach ($oldAgent in @('flash.md', 'astra.md', 'sol.md')) {
    $oldPath = Join-Path $repo "agents\$oldAgent"
    if (Test-Path -LiteralPath $oldPath) {
        Remove-Item -LiteralPath $oldPath -Force
    }
}

Write-Host '1. Syncing user profile (~/.pi/agent)...' -ForegroundColor Cyan
$appendPath = Join-Path $agent 'APPEND_SYSTEM.md'
$begin = '<!-- pi-thagoras:start -->'
$end = '<!-- pi-thagoras:end -->'
$block = "$begin`n$((Get-Content -LiteralPath (Join-Path $repo 'APPEND_SYSTEM.md') -Raw).Trim())`n$end"
if (Test-Path -LiteralPath $appendPath) {
    $current = Get-Content -LiteralPath $appendPath -Raw
    $s = $current.IndexOf($begin)
    $f = $current.IndexOf($end)
    if ($s -ge 0 -and $f -gt $s) {
        $updated = $current.Substring(0, $s) + $block + $current.Substring($f + $end.Length)
    } else {
        $updated = ($current.TrimEnd() + "`n`n" + $block + "`n").TrimStart()
    }
    Set-Content -LiteralPath $appendPath -Value $updated -NoNewline -Encoding utf8
} else {
    Set-Content -LiteralPath $appendPath -Value ($block + "`n") -NoNewline -Encoding utf8
}
Copy-Item -LiteralPath (Join-Path $repo 'models.json') -Destination (Join-Path $agent 'models.json') -Force
New-Item -ItemType Directory -Path (Join-Path $agent 'extensions\pi-permission-system') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'config\permissions.json') -Destination (Join-Path $agent 'extensions\pi-permission-system\config.json') -Force
New-Item -ItemType Directory -Path (Join-Path $agent 'extensions\subagent') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'config\subagent.json') -Destination (Join-Path $agent 'extensions\subagent\config.json') -Force

$infoPath = Join-Path $agent 'pi-thagoras.json'
if (-not (Test-Path -LiteralPath $infoPath)) {
    throw "Profile not found ($infoPath). Run: pwsh -NoProfile -File ./setup.ps1 -Apply -Rebuild"
}
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
$releaseRoot = $info.releaseRoot
$appDest = Join-Path $releaseRoot 'app'
if (-not (Test-Path -LiteralPath $appDest)) {
    throw "Release directory not found ($appDest). Run: pwsh -NoProfile -File ./setup.ps1 -Apply -Rebuild"
}

$piCli = $info.piCli
$recoveryState = $info.recoveryState
$psQuote = { param($v) "'" + $v.Replace("'", "''") + "'" }
$psLauncher = "`$env:PI_CODING_AGENT_DIR=$(&$psQuote $agent)`n`$env:PI_MANAGED_INSTALL_ROOT=$(&$psQuote $releaseRoot)`n`$env:PI_THAGORAS_RECOVERY_STATE=$(&$psQuote $recoveryState)`n& node $(&$psQuote $piCli) @args`nexit `$LASTEXITCODE`n"
$cmdLauncher = "@echo off`r`nset `"PI_CODING_AGENT_DIR=$agent`"`r`nset `"PI_MANAGED_INSTALL_ROOT=$releaseRoot`"`r`nset `"PI_THAGORAS_RECOVERY_STATE=$recoveryState`"`r`nnode `"$piCli`" %*`r`n"
$binDir = Join-Path $agent 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $binDir 'pi-thagoras.ps1'), $psLauncher, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText((Join-Path $binDir 'pi-thagoras.cmd'), $cmdLauncher, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText((Join-Path $binDir 'pi.ps1'), $psLauncher, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText((Join-Path $binDir 'pi.cmd'), $cmdLauncher, [Text.Encoding]::UTF8)

$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tempDir = Join-Path ([IO.Path]::GetTempPath()) "pi-thagoras-sync-$PID"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
try {
    $rootPkg = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
    $appPkg = [ordered]@{
        name    = $rootPkg.name
        version = $rootPkg.version
        private = $true
        pi      = $rootPkg.pi
    } | ConvertTo-Json -Depth 10
    $tempPkgPath = Join-Path $tempDir 'app-package.json'
    [IO.File]::WriteAllText($tempPkgPath, $appPkg + "`n", [Text.Encoding]::UTF8)

    $optimizeScript = Join-Path $repo 'scripts\optimize-installed-release.mjs'
    $tempScript = Join-Path $tempDir 'elevated-sync.ps1'
    $syncBody = @"
`$ErrorActionPreference = 'Stop'
`$repo = '$($repo.Replace("'", "''"))'
`$releaseRoot = '$($releaseRoot.Replace("'", "''"))'
`$appDest = Join-Path `$releaseRoot 'app'
foreach (`$dir in @('agents', 'extensions', 'guards', 'config', 'skills')) {
    `$targetDir = Join-Path `$appDest `$dir
    if (Test-Path -LiteralPath `$targetDir) {
        Remove-Item -LiteralPath `$targetDir -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path `$repo `$dir) -Destination `$targetDir -Recurse -Force
}
foreach (`$file in @('settings.json', 'models.json', 'APPEND_SYSTEM.md')) {
    Copy-Item -LiteralPath (Join-Path `$repo `$file) -Destination (Join-Path `$appDest `$file) -Force
}
Copy-Item -LiteralPath '$($tempPkgPath.Replace("'", "''"))' -Destination (Join-Path `$appDest 'package.json') -Force
`$autoReviewSrc = Join-Path `$repo 'upstream\pi-packages\packages\pi-auto-review\src'
`$autoReviewDest = Join-Path `$releaseRoot 'node_modules\@erichll\pi-auto-review\src'
if ((Test-Path -LiteralPath `$autoReviewSrc) -and (Test-Path -LiteralPath `$autoReviewDest)) {
    Remove-Item -LiteralPath `$autoReviewDest -Recurse -Force
    Copy-Item -LiteralPath `$autoReviewSrc -Destination `$autoReviewDest -Recurse -Force
}
`$permSrc = Join-Path `$repo 'upstream\pi-permission-packages\packages\pi-permission-system\src'
`$permDest = Join-Path `$releaseRoot 'node_modules\@gotgenes\pi-permission-system\src'
if ((Test-Path -LiteralPath `$permSrc) -and (Test-Path -LiteralPath `$permDest)) {
    Remove-Item -LiteralPath `$permDest -Recurse -Force
    Copy-Item -LiteralPath `$permSrc -Destination `$permDest -Recurse -Force
}
& '$($nodeExe.Replace("'", "''"))' '$($optimizeScript.Replace("'", "''"))' `$releaseRoot
if (`$LASTEXITCODE -ne 0) {
    throw "optimize-installed-release failed (`$LASTEXITCODE)"
}
"@
    [IO.File]::WriteAllText($tempScript, $syncBody, [Text.Encoding]::UTF8)

    Write-Host "2. Syncing repo & optimizing bundles in $releaseRoot (UAC)..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath (Get-Command pwsh).Source -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $tempScript)
    if ($proc.ExitCode -ne 0) {
        throw "Sync to $releaseRoot failed (ExitCode: $($proc.ExitCode))"
    }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Synced and optimized $releaseRoot. Run /reload or restart Pi to apply." -ForegroundColor Green
