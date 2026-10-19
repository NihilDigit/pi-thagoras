#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$TokenFile,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
if (-not $TokenFile) { $TokenFile = Join-Path (Get-PitatoRuntimeConfig).runtimeRoot 'secrets/tunnel.token' }
# cloudflared 2026.10.1 ParseToken uses standard Base64. No input values are logged.
function ConvertTo-TunnelTokenValue {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$InputValue)
    $value = $InputValue.Trim()
    if ($value.Length -ge 2 -and (
        ($value[0] -eq [char]34 -and $value[-1] -eq [char]34) -or
        ($value[0] -eq [char]39 -and $value[-1] -eq [char]39))) {
        $value = $value.Substring(1, $value.Length - 2).Trim()
    }
    $formatError = 'Paste only the long eyJ... connector token from the Dashboard command, not the command or Tunnel UUID. Nothing saved.'
    if ($value.Length -lt 40 -or $value -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') {
        throw $formatError
    }
    $decoded = $null
    try { $decoded = [Convert]::FromBase64String($value) }
    catch { throw $formatError }
    finally { if ($null -ne $decoded) { [Array]::Clear($decoded, 0, $decoded.Length) } }
    return $value
}
if (-not $Run) {
    Write-Output 'Plan: user pastes a Dashboard connector token at a masked local prompt.'
    Write-Output 'The new file stays outside the repository with access restricted to the current Windows user.'
    Write-Output 'No token is printed, supplied in process arguments, or read from existing credential stores.'
    return
}
if (-not [IO.Path]::IsPathFullyQualified($TokenFile)) { throw 'Use an absolute external token-file path.' }
$target = [IO.Path]::GetFullPath($TokenFile)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\','/')
if ($target.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Tokens must remain outside the repository.'
}
if (Test-Path -LiteralPath $target) { throw 'Token file already exists; this helper never overwrites it.' }
$parentDirectory = Split-Path -Parent $target
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (Test-Path -LiteralPath $parentDirectory) {
    if (-not (Test-Path -LiteralPath $parentDirectory -PathType Container)) { throw 'Parent is not a directory.' }
    $acl = Get-Acl -LiteralPath $parentDirectory
    if (@($acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $user.Value
    }).Count -gt 0) { throw 'Existing parent is not current-user-only. Use a new dedicated secrets directory; no ACL was changed.' }
} else {
    [IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $parentDirectory -AclObject $acl
}
$secure = Read-Host 'Paste the approved Tunnel connector token (hidden)' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $plain = ConvertTo-TunnelTokenValue -InputValue $plain
    $stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
        $stream.Write($bytes,0,$bytes.Length)
        [Array]::Clear($bytes,0,$bytes.Length)
    } finally { $stream.Dispose() }
    Write-Output 'Tunnel token saved in the external protected file; its value was not printed.'
} finally {
    $plain = $null
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secure.Dispose()
}
