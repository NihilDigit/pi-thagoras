function Get-PitatoRuntimeConfig {
    [CmdletBinding()]
    param([string]$AgentRoot = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' }))
    $installed = Join-Path $AgentRoot 'pi-thagoras.json'
    $local = Join-Path $PSScriptRoot 'runtime-path.local.json'
    $config = if (Test-Path -LiteralPath $installed) { Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json }
        elseif (Test-Path -LiteralPath $local) { Get-Content -LiteralPath $local -Raw | ConvertFrom-Json }
        else { [pscustomobject]@{ runtimeRoot=(Join-Path $AgentRoot 'pi-thagoras-state') } }
    if (-not $config.logicalRuntimeRoot) { $config | Add-Member logicalRuntimeRoot $config.runtimeRoot -Force }
    return $config
}

function Get-PitatoSoftware {
    param([string]$RuntimeRoot)
    $config = Get-PitatoRuntimeConfig
    if ($config.softwareManifest) {
        $software = Get-Content -LiteralPath $config.softwareManifest -Raw | ConvertFrom-Json
        foreach ($name in @('relay','cloudflared')) { $software.$name | Add-Member path (Join-Path (Split-Path $config.softwareManifest -Parent) $software.$name.file) -Force }
        return $software
    }
    if ($config.legacySoftware) { return $config.legacySoftware }
    throw 'No installed software manifest. Run setup.ps1 with -RelayServer.'
}
