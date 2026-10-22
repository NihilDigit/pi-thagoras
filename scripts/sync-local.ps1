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

$swPatchOld1 = @'
function runsAllCall(children) {
    return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression} }`).join(", ")}])`;
}
'@.Replace("`r`n", "`n")
$swPatchNew1 = @'
function runsAllCall(children) {
    return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}${child.model ? `, model: ${JSON.stringify(child.model)}` : ""}${child.worktree !== undefined ? `, worktree: ${JSON.stringify(child.worktree)}` : ""}${child.cwd ? `, cwd: ${JSON.stringify(child.cwd)}` : ""}, task: ${child.taskExpression} }`).join(", ")}])`;
}
'@.Replace("`r`n", "`n")
$swPatchOld2 = @'
        const record = exactFields(item, path, ["agent", "task"], "Each tasks item accepts only agent and task.");
        const agent = nonEmptyString(record.agent, `${path}.agent`);
        const task = nonEmptyString(record.task, `${path}.task`);
        const taskExpression = compileTemplate(task, {
            path: `${path}.task`,
            hasOriginalTask: originalTask !== undefined,
            previous: { unavailable: "tasks items may only use {task}." },
            outputsUnavailable: "tasks items may only use {task}.",
        });
        return { key: `task-${index + 1}`, agent, taskExpression };
'@.Replace("`r`n", "`n")
$swPatchNew2 = @'
        const record = exactFields(item, path, ["agent", "task", "model", "worktree", "cwd"], "Each tasks item accepts agent, task, model, worktree and cwd.");
        const agent = nonEmptyString(record.agent, `${path}.agent`);
        const task = nonEmptyString(record.task, `${path}.task`);
        const model = record.model === undefined ? undefined : nonEmptyString(record.model, `${path}.model`);
        const worktree = typeof record.worktree === "boolean" ? record.worktree : undefined;
        const cwd = record.cwd === undefined ? undefined : nonEmptyString(record.cwd, `${path}.cwd`);
        const taskExpression = compileTemplate(task, {
            path: `${path}.task`,
            hasOriginalTask: originalTask !== undefined,
            previous: { unavailable: "tasks items may only use {task}." },
            outputsUnavailable: "tasks items may only use {task}.",
        });
        return { key: `task-${index + 1}`, agent, model, worktree, cwd, taskExpression };
'@.Replace("`r`n", "`n")

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

    $swPath = Join-Path $releaseRoot 'node_modules\pi-subagents\src\workflows\structured-workflow-scripts.js'
    $tempSwPath = ''
    if (Test-Path -LiteralPath $swPath) {
        $swRaw = (Get-Content -LiteralPath $swPath -Raw).Replace("`r`n", "`n")
        $swRaw = $swRaw.Replace($swPatchOld1, $swPatchNew1).Replace($swPatchOld2, $swPatchNew2)
        $tempSwPath = Join-Path $tempDir 'structured-workflow-scripts.js'
        [IO.File]::WriteAllText($tempSwPath, $swRaw, [Text.Encoding]::UTF8)
    }

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
if ('$($tempSwPath.Replace("'", "''"))' -and (Test-Path -LiteralPath '$($tempSwPath.Replace("'", "''"))')) {
    Copy-Item -LiteralPath '$($tempSwPath.Replace("'", "''"))' -Destination (Join-Path `$releaseRoot 'node_modules\pi-subagents\src\workflows\structured-workflow-scripts.js') -Force
}
"@
    [IO.File]::WriteAllText($tempScript, $syncBody, [Text.Encoding]::UTF8)

    Write-Host "2. Syncing repo to $releaseRoot (UAC)..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath (Get-Command pwsh).Source -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $tempScript)
    if ($proc.ExitCode -ne 0) {
        throw "Sync to $releaseRoot failed (ExitCode: $($proc.ExitCode))"
    }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Synced to $releaseRoot. Run /reload in Pi to apply." -ForegroundColor Green
