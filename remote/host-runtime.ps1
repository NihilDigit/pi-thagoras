function Get-PitatoManagedPi {
    [CmdletBinding()]
    param([string]$AgentRoot = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' }))
    $profilePath = Join-Path $AgentRoot 'pi-thagoras.json'
    if (Test-Path -LiteralPath $profilePath) {
        $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
        $cli = [IO.Path]::GetFullPath($profile.piCli)
        if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Configured Pi executable is missing. Run setup or doctor.' }
        return [pscustomobject]@{ InstallRoot=$profile.releaseRoot; Cli=$cli; Node=(Get-Command node -CommandType Application -ErrorAction Stop).Source; Version=$profile.piVersion }
    }
    $managedRoot = Join-Path $AgentRoot 'install'
    $version = ([IO.File]::ReadAllText((Join-Path $managedRoot 'current-version'))).Trim()
    if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') { throw 'Invalid managed Pi version.' }
    $packageRoot = Join-Path $managedRoot "releases/$version/node_modules/@earendil-works/pi-coding-agent"
    $manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
    $bin = if ($manifest.bin -is [string]) { $manifest.bin } else { $manifest.bin.pi }
    $cli = [IO.Path]::GetFullPath((Join-Path $packageRoot $bin))
    if (-not $cli.StartsWith([IO.Path]::GetFullPath($packageRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Invalid managed Pi executable.' }
    [pscustomobject]@{
        InstallRoot = $managedRoot
        Cli = $cli
        Node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
        Version = $version
    }
}
